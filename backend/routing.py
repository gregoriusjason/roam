"""Discovery and pedestrian routes with explicit time-budget checks."""
import math
import os
import time
from functools import lru_cache
from threading import Lock

import httpx

from .integrations import rank_checkpoints, openai_configured
from .places import LOCATIONS, PLACES

HEADERS = {"User-Agent": "RoamReverseTourGuide/1.0 (walking exploration prototype)"}
_network_lock = Lock()
_last_request = 0


def fetch_json(url, params=None, timeout=18):
    global _last_request
    # Shared throttling for prototype public services; successful lookups are cached.
    with _network_lock:
        delay = 1.05 - (time.monotonic() - _last_request)
        if delay > 0:
            time.sleep(delay)
        _last_request = time.monotonic()
    try:
        result = httpx.get(url, params=params, headers=HEADERS, timeout=timeout, follow_redirects=True)
        result.raise_for_status()
        return result.json()
    except (httpx.HTTPError, ValueError) as error:
        raise RuntimeError("The map service is taking a break. Please try again in a moment.") from error


def distance(a, b):
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = lat2 - lat1
    dlng = math.radians(b["lng"] - a["lng"])
    h = math.sin(dlat / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2)**2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(h)))


def validate_location(value):
    if not isinstance(value, dict):
        raise ValueError("Choose a starting point and destination from the search results.")
    try:
        lat, lng = float(value["lat"]), float(value["lng"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("Choose a valid map location.")
    if not math.isfinite(lat) or not math.isfinite(lng) or not -90 <= lat <= 90 or not -180 <= lng <= 180:
        raise ValueError("Choose a valid map location.")
    name = value.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise ValueError("A location needs a name of up to 200 characters.")
    return {"id": str(value.get("id", f"gps:{lat:.5f},{lng:.5f}"))[:100],
            "name": name.strip(), "lat": lat, "lng": lng}


@lru_cache(maxsize=256)
def search_places(query):
    local = [p for p in LOCATIONS if query.casefold() in p["name"].casefold()]
    if local:
        return local[:6]
    data = fetch_json(os.getenv("GEOCODER_URL", "https://photon.komoot.io/api/"),
                      {"q": query, "limit": 5, "lang": "en"})
    results = []
    for f in data.get("features", []):
        prop = f.get("properties", {})
        coords = f.get("geometry", {}).get("coordinates", [])
        if len(coords) < 2:
            continue
        name = prop.get("name") or prop.get("street") or query
        area = ", ".join(dict.fromkeys(str(prop[k]) for k in ("city", "state", "country") if prop.get(k)))
        results.append({"id": f"osm:{prop.get('osm_type', '')}:{prop.get('osm_id', '')}",
                        "name": name, "area": area, "lng": coords[0], "lat": coords[1]})
    return results


@lru_cache(maxsize=96)
def _discover(lat, lng, radius):
    # Small single-category queries are more reliable on public instances than
    # one large union. Keep partial results if a category service request fails.
    elements = {}
    endpoint = os.getenv("OVERPASS_URL", "https://overpass.private.coffee/api/interpreter")
    for selector in ("[historic][name]", "[tourism][name]", "[leisure=park][name]"):
        query = f"[out:json][timeout:6];nwr(around:{radius},{lat},{lng}){selector};out center 25;"
        try:
            data = fetch_json(endpoint, {"data": query}, timeout=8)
            for element in data.get("elements", []):
                elements[(element["type"], element["id"])] = element
        except RuntimeError:
            continue
    places = []
    for e in elements.values():
        tags = e.get("tags", {})
        pos = e.get("center", e)
        if "lat" not in pos or "lon" not in pos or not tags.get("name") or tags.get("access") in ("private", "no"):
            continue
        if not (tags.get("historic") or tags.get("leisure") == "park" or
                tags.get("tourism") in ("artwork", "viewpoint", "museum", "attraction")):
            continue
        category = ("Nature" if tags.get("leisure") == "park" or tags.get("tourism") == "viewpoint"
                    else "History" if tags.get("historic") else "Arts & culture")
        feature = (tags.get("historic") or tags.get("tourism") or tags.get("leisure", "place")).replace("_", " ")
        places.append({"id": f"osm:{e['type']}:{e['id']}", "name": tags["name"],
                       "lat": pos["lat"], "lng": pos["lon"], "category": category,
                       "area": "Nearby discovery", "description": "A new place to make your own.",
                       "fact": f"OpenStreetMap lists this place as a {feature}.",
                       "source": f"https://www.openstreetmap.org/{e['type']}/{e['id']}"})
    return places or _wiki_discover(lat, lng, radius)


def _wiki_discover(lat, lng, radius):
    """Independent, attributed fallback when map landmark services are unavailable."""
    endpoint = "https://en.wikipedia.org/w/api.php"
    result = fetch_json(endpoint, {"action": "query", "format": "json", "list": "geosearch",
                                  "gscoord": f"{lat}|{lng}", "gsradius": min(radius, 10000), "gslimit": 25}, timeout=8)
    records = result.get("query", {}).get("geosearch", [])
    if not records:
        return []
    # Use the source's introduction for context, never invented historical facts.
    try:
        summaries = fetch_json(endpoint, {"action": "query", "format": "json",
            "pageids": "|".join(str(p["pageid"]) for p in records), "prop": "extracts",
            "exintro": 1, "explaintext": 1, "exsentences": 1, "exlimit": 25}, timeout=8).get("query", {}).get("pages", {})
    except RuntimeError:
        summaries = {}
    places = []
    for record in records:
        name = record["title"]
        category = ("Nature" if any(w in name.lower() for w in ("garden", "park", "wood", "hill"))
                    else "Arts & culture" if any(w in name.lower() for w in ("museum", "gallery", "library", "theatre", "book"))
                    else "Hidden gems")
        summary = summaries.get(str(record["pageid"]), {}).get("extract", "").strip()
        places.append({"id": f"wiki:{record['pageid']}", "name": name,
                       "lat": record["lat"], "lng": record["lon"], "category": category,
                       "area": "Nearby discovery", "description": "A place with a story, just around the corner.",
                       "fact": summary[:600] if summary else f"Discover the background to {name} in its Wikipedia article.",
                       "source": f"https://en.wikipedia.org/?curid={record['pageid']}",
                       "fact_credit": "Wikipedia contributors · CC BY-SA"})
    return places


def discover(origin, destination):
    midpoint = {"lat": (origin["lat"] + destination["lat"]) / 2,
                "lng": (origin["lng"] + destination["lng"]) / 2}
    if distance(midpoint, {"lat": 55.950, "lng": -3.193}) < 4500:
        return [dict(p) for p in PLACES]
    radius = min(4000, max(1000, round(distance(origin, destination) / 2 + 700)))
    return _discover(round(midpoint["lat"], 3), round(midpoint["lng"], 3), radius)


@lru_cache(maxsize=256)
def walking_route(coordinates):
    coords = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in coordinates)
    base = os.getenv("WALKING_ROUTER_URL", "https://routing.openstreetmap.de/routed-foot/route/v1/foot")
    data = fetch_json(f"{base.rstrip('/')}/{coords}", {"overview": "full", "geometries": "geojson", "steps": "false"})
    if data.get("code") != "Ok" or not data.get("routes"):
        raise ValueError("We couldn't find a walking route between those places. Try closer locations.")
    for waypoint in data.get("waypoints", []):
        if waypoint.get("distance", 0) > 250:
            raise ValueError("One location is too far from a mapped walking path. Pick a nearby street or entrance.")
    route = data["routes"][0]
    return {"geometry": route["geometry"], "distance": round(route["distance"]),
            "walking_minutes": math.ceil(max(route["duration"] / 60, route["distance"] / 75))}


def route_for(points):
    return walking_route(tuple((p["lat"], p["lng"]) for p in points))


def plan_route(origin, destination, minutes, interests, visited, fresh_only=True, use_ai=True, photo=None):
    if distance(origin, destination) > 15000:
        raise ValueError("Let's keep this a city walk. Choose places within 15 km of each other.")
    direct = route_for([origin, destination])
    if direct["walking_minutes"] + 5 > minutes:
        raise ValueError(f"The direct walk needs about {direct['walking_minutes']} minutes, plus a 5-minute buffer. Choose a later arrival time.")
    warnings = []
    try:
        candidates = discover(origin, destination)
    except RuntimeError:
        candidates = []
        warnings.append("Nearby discoveries are unavailable. This route goes straight to your destination.")
    candidates = [dict(p, visited=p["id"] in visited) for p in candidates
                  if distance(p, origin) > 80 and distance(p, destination) > 80
                  and (not fresh_only or p["id"] not in visited)]
    candidates.sort(key=lambda p: (p["visited"], p["category"] not in interests,
                     distance(origin, p) + distance(p, destination)))
    mode = "discovery"
    if use_ai and openai_configured() and candidates:
        try:
            ranked = rank_checkpoints(candidates[:20], interests, photo=photo)
            if ranked:
                candidates.sort(key=lambda p: (p["visited"], ranked.index(p["id"]) if p["id"] in ranked else 999))
                mode = "ai"
        except Exception:
            warnings.append("AI personalisation is unavailable. Your interests and exploration history were used instead.")
    stops = []
    # Insert a few diverse stops, then verify the whole pedestrian route.
    for candidate in candidates:
        if len(stops) >= 3:
            break
        choices = []
        for i in range(len(stops) + 1):
            trial = stops[:i] + [candidate] + stops[i:]
            points = [origin, *trial, destination]
            estimate = sum(distance(a, b) for a, b in zip(points, points[1:])) * 1.3 / 75 + len(trial) * 5 + 5
            choices.append((estimate, trial))
        estimate, trial = min(choices, key=lambda c: c[0])
        if estimate <= minutes:
            stops = trial
    actual = route_for([origin, *stops, destination]) if stops else direct
    while stops and actual["walking_minutes"] + len(stops) * 5 + 5 > minutes:
        stops.pop()
        actual = route_for([origin, *stops, destination]) if stops else direct
    total = actual["walking_minutes"] + len(stops) * 5
    if not stops and not warnings:
        warnings.append("No new checkpoints fit this walk. Allow more time or include familiar places.")
    return {"origin": origin, "destination": destination, "checkpoints": stops, **actual,
            "total_minutes": total, "buffer_minutes": minutes - total,
            "direct_minutes": direct["walking_minutes"], "mode": mode, "warnings": warnings,
            "new_places": sum(not p["visited"] for p in stops), "interests": interests}
