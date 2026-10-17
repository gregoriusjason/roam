from shapely.geometry import shape, mapping
import math
import shapely

METRES_PER_DEG_LAT = 111320
METRES_PER_DEG_LNG = 111320 * math.cos(math.radians(55.95))

def to_metres(coords):
    return coords * [METRES_PER_DEG_LNG, METRES_PER_DEG_LAT]

def to_degrees(coords):
    return coords / [METRES_PER_DEG_LNG, METRES_PER_DEG_LAT]


def build_footprint(journeys):

    areas = []

    for journey in journeys:
        if journey["status"] != "completed":
            continue
        line = shape(journey["route"]["geometry"])
        line_m = shapely.transform(line, to_metres)
        area_m = line_m.buffer(40)
        areas.append(area_m)

    if not areas:
        return None
    
    footprint = shapely.union_all(areas)
    footprint_deg = shapely.transform(footprint, to_degrees)
    return mapping(footprint_deg)
