// Waveform peaks for the editors (pure: no DOM, the network is a function you pass in).
//
// Every track has one coarse copy of the whole file. When the view is zoomed in far enough that the coarse copy is too
// blurry, a detailed piece for the part on screen is fetched (debounced, de-duplicated) and kept in a small cache.
// get() always answers immediately with the best peaks it has, and calls `onUpdate` when something better arrives.
//
// A peaks object: { start, end, min: [..], max: [..] }  (values -128..127, one pair per equal slice of [start, end]).

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const MAX_DETAIL = 40;     // pieces kept per track

export class PeakCache {
  /** fetchPeaks(track, start, end, n) -> Promise<{start, end, min, max}> */
  constructor(fetchPeaks, onUpdate = () => {}) {
    this.fetchPeaks = fetchPeaks;
    this.onUpdate = onUpdate;
    this.coarse = new Map();      // track -> peaks of the whole file
    this.detail = new Map();      // track -> [peaks, ...] (most recently used last)
    this.queue = new Map();       // key -> {track, start, end, n}
    this.inflight = new Set();
    this.failed = new Set();
    this.paused = false;          // while dragging: don't hit the server for every pixel
    this.epoch = 0;               // bumped by reset(): answers of an older source are dropped
    this.delay = 120;
    this._timer = null;
  }

  reset() {
    this.coarse.clear(); this.detail.clear(); this.queue.clear(); this.inflight.clear(); this.failed.clear();
    this.epoch++;
    clearTimeout(this._timer);
    this._timer = null;
  }

  setCoarse(track, pk) {
    if (pk && pk.max && pk.max.length) this.coarse.set(track, pk);
  }
  hasCoarse(track) { return this.coarse.has(track); }
  duration(track) { const c = this.coarse.get(track); return c ? c.end : 0; }

  pause() { this.paused = true; }
  resume() { this.paused = false; this._schedule(); }

  /** Best peaks for source range [a, b] drawn over `px` pixels (null while nothing has loaded). */
  get(track, a, b, px) {
    const coarse = this.coarse.get(track) || null;
    if (!(b > a) || !(px > 0)) return coarse;
    const want = (b - a) / px;                                      // seconds per pixel
    const res = (p) => (p.end - p.start) / Math.max(1, p.max.length);
    if (coarse && res(coarse) <= want * 1.25) return coarse;        // the coarse copy is sharp enough
    let best = null;
    for (const d of this.detail.get(track) || []) {
      if (d.start <= a + 1e-6 && d.end >= b - 1e-6 && res(d) <= want * 1.6 && (!best || res(d) < res(best))) best = d;
    }
    if (best) return best;
    this._request(track, a, b, want, coarse);
    return coarse;
  }

  _request(track, a, b, want, coarse) {
    const dur = coarse ? coarse.end : b;
    const span = b - a;
    const q = Math.max(span / 4, 1e-3);
    const lo = clamp(Math.floor((a - span * 0.25) / q) * q, 0, dur);
    const hi = clamp(Math.ceil((b + span * 0.25) / q) * q, lo + 1e-3, Math.max(dur, lo + 1e-3));
    let n = clamp(Math.round(((hi - lo) / want) * 1.4), 300, 8000);
    n = 2 ** Math.ceil(Math.log2(n));                                // a few size buckets: repeated draws de-duplicate
    const key = `${track}|${lo.toFixed(3)}|${hi.toFixed(3)}|${n}`;
    if (this.failed.has(key) || this.inflight.has(key) || this.queue.has(key)) return;
    this.queue.set(key, { track, start: lo, end: hi, n });
    this._schedule();
  }

  _schedule() {
    if (this._timer || this.paused || !this.queue.size) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, this.delay);
  }

  /** Start the queued requests now (tests call this directly). Resolves when they are done. */
  async flush() {
    if (this.paused) return;
    const jobs = [...this.queue.entries()];
    this.queue.clear();
    const epoch = this.epoch;
    await Promise.all(jobs.map(async ([key, j]) => {
      this.inflight.add(key);
      try {
        const r = await this.fetchPeaks(j.track, j.start, j.end, j.n);
        if (epoch !== this.epoch || !r || !r.max || !r.max.length) return;
        const list = this.detail.get(j.track) || [];
        list.push({ start: r.start, end: r.end, min: r.min, max: r.max });
        while (list.length > MAX_DETAIL) list.shift();
        this.detail.set(j.track, list);
        this.onUpdate();
      } catch (e) {
        this.failed.add(key);                                        // keep the coarse waveform, don't retry forever
      } finally {
        this.inflight.delete(key);
      }
    }));
  }
}
