(function () {
  const BUFFER = 5;                 // minutes of safety margin
  const NEAR = 40, LEFT = 60;       // metres: "arrived at stop" / "left the stop"
  const COOLDOWN = 30000;           // ms between replans (prevents flapping)
  const SPARE_MIN = 25;             // spare minutes before we try to ADD stops

  const hav = (a, b) => {
    const R = 6371000, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const x = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  class LiveTrip {
    // route: the route object from /api/routes (needs checkpoints, destination, arrival_at, id)
    // opts: { onRoute(route, reason), onStatus({timeLeft, needed, slack}), now() }
    constructor(route, opts = {}) {
      this.route = route;
      this.onRoute = opts.onRoute || (() => {});
      this.onStatus = opts.onStatus || (() => {});
      this.now = opts.now || (() => Date.now());
      this.remaining = [...route.checkpoints];
      this.done = [];
      this.atStop = null;
      this.pos = null;
      this.lastFix = null;
      this.lastReplan = 0;
      this.busy = false;
      this.speed = 75;              // m/min, learned
      this.speedSamples = 0;
      this.dwell = 8;               // min, learned
      this.dwellByCat = {};         // category -> avg minutes
    }

    dwellFor(stop) { return this.dwellByCat[stop.category] ?? this.dwell; }

    walkMin(points) {
      let metres = 0;
      for (let i = 1; i < points.length; i++) metres += hav(points[i - 1], points[i]);
      return (metres * 1.3) / this.speed;
    }

    onPosition(pos) {
      const t = this.now();

      // learn walking speed (only while moving between stops)
      if (this.lastFix && !this.atStop) {
        const dtMin = (t - this.lastFix.t) / 60000;
        if (dtMin > 0.05) {
          const v = hav(this.lastFix.pos, pos) / dtMin;
          if (v > 40 && v < 130) {
            this.speed = this.speedSamples < 3 ? this.speed : 0.8 * this.speed + 0.2 * v;
            this.speedSamples++;
          }
        }
      }
      this.lastFix = { pos, t };
      this.pos = pos;

      // arrive / leave stops
      if (this.atStop) {
        if (hav(pos, this.atStop.stop) > LEFT) this.finishStop();
      } else {
        const hit = this.remaining.find((s) => hav(pos, s) < NEAR);
        if (hit) this.atStop = { stop: hit, since: t };
      }
      this.evaluate();
    }

    finishStop() {
      const { stop, since } = this.atStop;
      const spent = (this.now() - since) / 60000;
      const prev = this.dwellByCat[stop.category] ?? this.dwell;
      this.dwellByCat[stop.category] = 0.6 * prev + 0.4 * spent;
      this.dwell = 0.7 * this.dwell + 0.3 * spent;
      this.done.push(stop.id);
      this.remaining = this.remaining.filter((r) => r.id !== stop.id);
      this.atStop = null;
    }

    evaluate() {
      if (!this.pos) return;
      const timeLeft = (new Date(this.route.arrival_at) - this.now()) / 60000;

      let dwellLeft = this.remaining.reduce((s, st) => s + this.dwellFor(st), 0);
      if (this.atStop) {
        const spent = (this.now() - this.atStop.since) / 60000;
        // if they linger past the expected dwell, the overrun counts against slack
        dwellLeft -= Math.min(this.dwellFor(this.atStop.stop), spent);
        if (spent > this.dwellFor(this.atStop.stop)) dwellLeft += spent - this.dwellFor(this.atStop.stop);
      }

      const needed =
        this.walkMin([this.pos, ...this.remaining, this.route.destination]) + dwellLeft + BUFFER;
      const slack = timeLeft - needed;
      this.onStatus({ timeLeft, needed, slack, speed: this.speed, dwell: this.dwell });

      const cooled = this.now() - this.lastReplan > COOLDOWN;
      if (cooled && !this.busy && (slack < 0 || slack > SPARE_MIN)) {
        this.replan(slack < 0 ? "late" : "spare");
      }
    }

    async replan(reason) {
      this.busy = true;
      this.lastReplan = this.now();
      try {
        const res = await fetch(`/api/journeys/${this.route.id}/replan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            current: { lat: this.pos.lat, lng: this.pos.lng, id: "here", name: "You are here" },
            completed_stops: this.done,
            speed: this.speed,
            dwell: this.dwell,
            minutes_left: Math.floor((new Date(this.route.arrival_at) - this.now()) / 60000),
            reason,
          }),
        });
        const data = await res.json();
        if (data.route) {
          this.route = data.route;
          this.remaining = [...data.route.checkpoints];
          this.onRoute(data.route, reason);
        }
      } catch (e) {
        console.error("replan failed", e);
      } finally {
        this.busy = false;
      }
    }

        markDone(id) {
      if (!this.done.includes(id)) this.done.push(id);
      this.remaining = this.remaining.filter((r) => r.id !== id);
      if (this.atStop && this.atStop.stop.id === id) this.atStop = null;
    }

    // ---- demo simulator: fake walker on a sped-up clock (10x by default) ----
    simulate(points, { speedUp = 10, tickMs = 1000 } = {}) {
      clearInterval(this._timer);
      this.simPts = points.slice(1);
      this.simPos = { lat: points[0].lat, lng: points[0].lng };
      this.clockOffset = this.clockOffset || 0;
      this.now = () => Date.now() + this.clockOffset;
      this.paused = this.paused || false;
      this._timer = setInterval(() => {
        if (this.paused) { if (this.pos) this.evaluate(); return; }
        this.clockOffset += tickMs * (speedUp - 1);          // sped-up clock
        if (this.atStop) {                                    // hold at the stop for its dwell time
          const spent = (this.now() - this.atStop.since) / 60000;
          if (spent < this.dwellFor(this.atStop.stop)) { this.evaluate(); return; }
        }
        const target = this.simPts[0];
        if (!target) return;
        const step = this.speed * ((tickMs * speedUp) / 60000);   // metres per tick
        const d = hav(this.simPos, target);
        if (d <= step) {
          this.simPos = { lat: target.lat, lng: target.lng };
          this.simPts.shift();
        } else {
          const f = step / d;
          this.simPos = {
            lat: this.simPos.lat + (target.lat - this.simPos.lat) * f,
            lng: this.simPos.lng + (target.lng - this.simPos.lng) * f,
          };
        }
        this.onPosition({ ...this.simPos });
      }, tickMs);
    }
    linger(minutes) { this.clockOffset = (this.clockOffset || 0) + minutes * 60000; this.paused = true; if (this.pos) this.evaluate(); }
    resume() { this.paused = false; }
    stop() { clearInterval(this._timer); }
  }

  window.LiveTrip = LiveTrip;
})();