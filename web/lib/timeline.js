// Pure timeline model + editor + renderer (no DOM, no ComfyUI imports): unit-testable, draws to any 2D context.
//
// Vocabulary
//   source    the audio of the file's tracks (shown as waveform lanes)
//   section   a kept part of the source. The output ("program") is the sections joined in their listed order, so
//             sections can be cut, resized, deleted, split and re-ordered. No sections = the whole source.
//   speaker   a lane of the output; its clips say where in the SOURCE that speaker talks
//   clip      {start, end, speaker} in source seconds

export const SPEAKER_COLORS = ["#4fc3f7", "#ff8a65", "#aed581", "#ba68c8", "#ffd54f",
                               "#4db6ac", "#f06292", "#90a4ae", "#a1887f", "#7986cb"];
export const GUTTER = 120;      // label column
const PAD_R = 10;
const OV_H = 24;                // overview bar (sections + view window)
const OUT_H = 18;               // output-order strip
const RULER_H = 18;
const LANE_MIN = 20, LANE_DEF = 34, LANE_MAX = 40, MAX_H = 480, MIN_H = 170;
const EDGE_PX = 6;
const MIN_SPAN = 0.02;          // smallest zoom, seconds
const MIN_SEC = 0.05;           // smallest section / clip, seconds
const EPS = 1e-9;

export function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function niceStep(span, targetTicks) {
  const raw = Math.max(span, 1e-9) / Math.max(targetTicks, 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/** Parse the `edit` widget text. Never throws. */
export function parseEdit(text) {
  const out = { sections: [], speakers: [], clips: [] };
  try {
    const d = JSON.parse(text || "{}");
    if (!d || typeof d !== "object") return out;
    out.sections = (d.sections || []).map((p) => [Number(p[0]), Number(p[1])]).filter((p) => p[1] > p[0]);
    out.speakers = (d.speakers || []).map((s) => ({ id: String(s.id), name: String(s.name || s.id) }));
    out.clips = (d.clips || [])
      .map((c) => ({ start: Number(c.start), end: Number(c.end), speaker: String(c.speaker) }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  } catch (e) { /* damaged text: start empty */ }
  return out;
}

export class Timeline {
  constructor() {
    this.duration = 0;
    this.viewStart = 0;
    this.viewEnd = 1;
    this.tracks = [];            // {index, title, channels, rate, coarse, detail, error}: the file's audio tracks
    this.selTrack = 0;           // the track used as the timeline (and analysed)
    this.mode = "detected";      // "detected": speaker lanes | "tracks": the file's other tracks are the lanes
    this.sections = [];          // [{start, end}] in OUTPUT order; [] = the whole source
    this.speakers = [];          // [{id, name}] lane order = output order
    this.clips = [];             // [{start, end, speaker}]
    this.sel = null;             // {type: "clip"|"section", ref}
    this.selLane = null;         // {kind: "source"|"speaker", index}
    this.playhead = null;
    this.band = null;            // rubber band while drawing: {kind: "section"|"clip", a, b, lane}
    this.dropLane = null;        // speaker lane a dragged clip would move to
    this.message = "";
    this.maxOutputs = 16;
    this.w = 640;
    this.h = 280;
    this.drag = null;
    this.theme = {
      bg: "#1c1d21", lane: "#26272c", laneAlt: "#2b2c32", text: "#d7d9de", dim: "#8c909a", grid: "#3b3d46",
      wave: "#6e7681", waveSel: "#8ab4f8", accent: "#ffd54f", shade: "rgba(0,0,0,0.55)", out: "#3d5a80",
    };
  }

  // ================================================================== source
  reset() {
    this.duration = 0;
    this.tracks = [];
    this.playhead = null;
    this.selLane = null;
    this.sel = null;
    this.band = null;
    this.viewStart = 0;
    this.viewEnd = 1;
  }

  /** info: {duration, tracks: [{index, title, channels, sample_rate}]} */
  setInfo(info) {
    this.tracks = (info.tracks || []).map((t) => ({
      index: t.index, title: t.title || "", channels: t.channels || 0, rate: t.sample_rate || 0,
      coarse: null, detail: null, error: "",
    }));
    this.setDuration(info.duration || 0);
    if (!this.tracks.some((t) => t.index === this.selTrack)) this.selTrack = this.tracks.length ? this.tracks[0].index : 0;
    this.message = this.tracks.length ? "" : "No audio tracks in this file";
  }

  setDuration(d) {
    if (!(d > 0)) return;
    const first = this.duration === 0;
    if (d > this.duration) this.duration = d;
    if (first) this.fit();
  }

  trackByIndex(i) { return this.tracks.find((t) => t.index === i) || null; }

  // ================================================================== sections (what is kept, in output order)
  effSections() {
    return this.sections.length ? this.sections : (this.duration > 0 ? [{ start: 0, end: this.duration }] : []);
  }
  hasSections() { return this.sections.length > 0; }
  materialize() {
    if (!this.sections.length && this.duration > 0) this.sections = [{ start: 0, end: this.duration }];
  }
  programLength() { return this.effSections().reduce((a, s) => a + (s.end - s.start), 0); }

  sourceToProgram(t) {
    let off = 0;
    for (const s of this.effSections()) {
      if (t >= s.start - EPS && t <= s.end + EPS) return off + (t - s.start);
      off += s.end - s.start;
    }
    return null;
  }
  programToSource(p) {
    let off = 0;
    for (const s of this.effSections()) {
      const len = s.end - s.start;
      if (p <= off + len + EPS) return s.start + clamp(p - off, 0, len);
      off += len;
    }
    return null;
  }
  sectionAt(t) { return this.effSections().find((s) => t >= s.start && t <= s.end) || null; }

  _bounds(sec) {          // free space around a section in source time (other sections are walls)
    let lo = 0, hi = this.duration;
    for (const o of this.sections) {
      if (o === sec) continue;
      if (o.end <= sec.start + EPS) lo = Math.max(lo, o.end);
      if (o.start >= sec.end - EPS) hi = Math.min(hi, o.start);
    }
    return [lo, hi];
  }

  setSectionEdge(sec, side, t) {
    this.materialize();
    if (!this.sections.includes(sec)) sec = this.sections[0];
    const [lo, hi] = this._bounds(sec);
    if (side === "start") sec.start = clamp(t, lo, sec.end - MIN_SEC);
    else sec.end = clamp(t, sec.start + MIN_SEC, hi);
    return sec;
  }

  /** Add a section (appended to the output order). With no sections yet, the drawn range REPLACES the whole source. */
  addSection(a, b) {
    if (b < a) [a, b] = [b, a];
    a = clamp(a, 0, this.duration);
    b = clamp(b, 0, this.duration);
    if (b - a < MIN_SEC) return null;
    if (!this.sections.length) {
      const s = { start: a, end: b };
      this.sections = [s];
      return s;
    }
    for (const o of this.sections) if (a > o.start + EPS && a < o.end - EPS) return null;   // starts inside another one
    let lo = 0, hi = this.duration;
    for (const o of this.sections) {
      if (o.end <= a + EPS) lo = Math.max(lo, o.end);
      if (o.start >= a + EPS) hi = Math.min(hi, o.start);
    }
    a = Math.max(a, lo);
    b = Math.min(b, hi);
    if (b - a < MIN_SEC) return null;
    const s = { start: a, end: b };
    this.sections.push(s);
    return s;
  }

  deleteSection(sec) {
    const i = this.sections.indexOf(sec);
    if (i < 0) return false;
    this.sections.splice(i, 1);          // no sections left = the whole source again
    if (this.sel && this.sel.ref === sec) this.sel = null;
    return true;
  }

  moveSection(sec, toIndex) {
    const i = this.sections.indexOf(sec);
    if (i < 0) return false;
    toIndex = clamp(toIndex, 0, this.sections.length - 1);
    if (toIndex === i) return false;
    this.sections.splice(i, 1);
    this.sections.splice(toIndex, 0, sec);
    return true;
  }

  /** Razor: split the section under t in two (same place in the output order, nothing changes audibly). */
  splitSectionAt(t) {
    this.materialize();
    const sec = this.sections.find((s) => t > s.start + MIN_SEC && t < s.end - MIN_SEC);
    if (!sec) return null;
    const right = { start: t, end: sec.end };
    sec.end = t;
    this.sections.splice(this.sections.indexOf(sec) + 1, 0, right);
    return right;
  }

  // ================================================================== speakers and clips
  colorOf(i) { return SPEAKER_COLORS[i % SPEAKER_COLORS.length]; }
  speakerIndex(id) { return this.speakers.findIndex((s) => s.id === id); }
  speakerOf(id) { return this.speakers.find((s) => s.id === id) || null; }
  clipsOf(id) { return this.clips.filter((c) => c.speaker === id).sort((a, b) => a.start - b.start); }

  addSpeaker(name = "") {
    const used = new Set(this.speakers.map((s) => s.id));
    let n = 1;
    while (used.has(`MANUAL_${n}`)) n++;
    const sp = { id: `MANUAL_${n}`, name: name.trim() || `Speaker ${this.speakers.length + 1}` };
    this.speakers.push(sp);
    return sp;
  }
  deleteSpeaker(id) {
    const i = this.speakerIndex(id);
    if (i < 0) return false;
    this.speakers.splice(i, 1);
    this.clips = this.clips.filter((c) => c.speaker !== id);
    if (this.sel && this.sel.type === "clip" && !this.clips.includes(this.sel.ref)) this.sel = null;
    this.selLane = null;
    return true;
  }
  renameSpeaker(id, name) {
    const sp = this.speakerOf(id);
    if (!sp || !name.trim()) return false;
    sp.name = name.trim();
    return true;
  }

  _clipBounds(clip) {    // free space around a clip among the other clips of the same speaker
    let lo = 0, hi = this.duration;
    for (const o of this.clips) {
      if (o === clip || o.speaker !== clip.speaker) continue;
      if (o.end <= clip.start + EPS) lo = Math.max(lo, o.end);
      if (o.start >= clip.end - EPS) hi = Math.min(hi, o.start);
    }
    return [lo, hi];
  }

  setClipEdge(clip, side, t) {
    const [lo, hi] = this._clipBounds(clip);
    if (side === "start") clip.start = clamp(t, lo, clip.end - MIN_SEC);
    else clip.end = clamp(t, clip.start + MIN_SEC, hi);
    return clip;
  }

  /** New clip for a speaker; it fits into the free space around `a` (it never overlaps that speaker's other clips). */
  addClip(speakerId, a, b) {
    if (b < a) [a, b] = [b, a];
    a = clamp(a, 0, this.duration);
    b = clamp(b, 0, this.duration);
    let lo = 0, hi = this.duration;
    for (const o of this.clips) {
      if (o.speaker !== speakerId) continue;
      if (a > o.start + EPS && a < o.end - EPS) return null;
      if (o.end <= a + EPS) lo = Math.max(lo, o.end);
      if (o.start >= a + EPS) hi = Math.min(hi, o.start);
    }
    a = Math.max(a, lo);
    b = Math.min(b, hi);
    if (b - a < MIN_SEC || this.speakerIndex(speakerId) < 0) return null;
    const c = { start: a, end: b, speaker: speakerId };
    this.clips.push(c);
    return c;
  }

  deleteClip(clip) {
    const i = this.clips.indexOf(clip);
    if (i < 0) return false;
    this.clips.splice(i, 1);
    if (this.sel && this.sel.ref === clip) this.sel = null;
    return true;
  }

  /** Make [a, b] belong to `speakerId` only (overwrite): that speaker's overlapping clips are cut back. */
  _overwrite(speakerId, a, b, except) {
    const out = [];
    for (const c of this.clips) {
      if (c === except || c.speaker !== speakerId || c.end <= a + EPS || c.start >= b - EPS) { out.push(c); continue; }
      if (c.start >= a - EPS && c.end <= b + EPS) continue;                         // fully covered: gone
      if (c.start < a - EPS && c.end > b + EPS) {                                    // contains it: split around
        out.push({ start: c.start, end: a, speaker: speakerId }, { start: b, end: c.end, speaker: speakerId });
        continue;
      }
      if (c.start < a - EPS) c.end = a; else c.start = b;
      if (c.end - c.start >= MIN_SEC) out.push(c);
    }
    this.clips = out;
  }

  reassignClip(clip, speakerId) {
    if (!this.clips.includes(clip) || this.speakerIndex(speakerId) < 0 || clip.speaker === speakerId) return false;
    this._overwrite(speakerId, clip.start, clip.end, clip);
    clip.speaker = speakerId;
    return true;
  }

  splitClipAt(clip, t) {
    if (!this.clips.includes(clip) || t < clip.start + MIN_SEC || t > clip.end - MIN_SEC) return null;
    const right = { start: t, end: clip.end, speaker: clip.speaker };
    clip.end = t;
    this.clips.push(right);
    return right;
  }

  /** Replace the lanes and clips with an analysis result (names of speakers that already exist are kept). */
  applyAnalysis(clips, order) {
    const names = Object.fromEntries(this.speakers.map((s) => [s.id, s.name]));
    this.clips = clips.map((c) => ({ start: c.start, end: c.end, speaker: c.speaker }));
    this.speakers = order.map((id) => ({ id, name: names[id] || id }));
    this.sel = null;
    this.selLane = null;
  }

  clearEdit() {
    this.sections = [];
    this.speakers = [];
    this.clips = [];
    this.sel = null;
    this.selLane = null;
  }

  toEdit() {
    return {
      v: 1,
      sections: this.sections.map((s) => [Math.round(s.start * 1000) / 1000, Math.round(s.end * 1000) / 1000]),
      speakers: this.speakers.map((s) => ({ id: s.id, name: s.name })),
      clips: this.clips.map((c) => ({ start: Math.round(c.start * 1000) / 1000, end: Math.round(c.end * 1000) / 1000, speaker: c.speaker })),
    };
  }
  isEmptyEdit() { return !this.sections.length && !this.speakers.length && !this.clips.length; }

  fromEdit(e) {
    this.sections = (e.sections || []).map(([a, b]) => ({ start: a, end: b }));
    this.speakers = (e.speakers || []).map((s) => ({ id: s.id, name: s.name }));
    this.clips = (e.clips || []).map((c) => ({ ...c }));
    for (const c of this.clips) if (this.speakerIndex(c.speaker) < 0) this.speakers.push({ id: c.speaker, name: c.speaker });
    this.sel = null;
    if (this.selLane && this.selLane.kind === "speaker" && this.selLane.index >= this.speakers.length) this.selLane = null;
  }

  /** Labels of the `count` lane outputs: "1: Anna" / the file's other tracks / "speaker_3" when nobody is there yet. */
  outputLabels(count) {
    const out = [];
    const others = this.tracks.filter((t) => t.index !== this.selTrack);
    for (let k = 0; k < count; k++) {
      if (this.mode === "tracks") {
        const t = others[k];
        out.push(t ? `${k + 1}: ${t.title || "track " + t.index}` : `speaker_${k + 1}`);
      } else {
        const sp = this.speakers[k];
        out.push(sp ? `${k + 1}: ${sp.name}` : `speaker_${k + 1}`);
      }
    }
    return out;
  }
  laneOutputCount() {
    return this.mode === "tracks" ? Math.max(this.tracks.length - 1, 0) : this.speakers.length;
  }

  // ================================================================== layout
  lanes() {
    const lanes = [];
    for (const t of this.tracks) {
      const ch = t.channels === 1 ? "mono" : t.channels === 2 ? "stereo" : t.channels > 2 ? `${t.channels}ch` : "";
      const rate = t.rate ? ` · ${Math.round(t.rate / 100) / 10}k` : "";
      lanes.push({ kind: "source", index: t.index, label: `T${t.index}${t.title ? " " + t.title : ""}`, sub: `${ch}${rate}`, color: this.theme.waveSel });
    }
    if (this.mode === "detected") {
      this.speakers.forEach((sp, i) => lanes.push({ kind: "speaker", index: i, id: sp.id, label: sp.name, sub: i >= this.maxOutputs ? "no output" : `speaker_${i + 1}`, color: this.colorOf(i) }));
    }
    return lanes;
  }
  top() { return OV_H + OUT_H + RULER_H + 2; }
  desiredHeight() { return clamp(this.top() + 8 + Math.max(this.lanes().length, 2) * LANE_DEF, MIN_H, MAX_H); }
  laneRects() {
    const lanes = this.lanes();
    const lh = clamp((this.h - this.top() - 6) / Math.max(lanes.length, 1), LANE_MIN, LANE_MAX);
    return lanes.map((l, i) => ({ ...l, y: this.top() + i * lh, h: lh - 2 }));
  }
  laneAtY(y) { return this.laneRects().find((r) => y >= r.y && y < r.y + r.h + 2) || null; }

  plot() { return { x0: GUTTER, x1: Math.max(GUTTER + 40, this.w - PAD_R) }; }
  t2x(t) { const p = this.plot(); return p.x0 + ((t - this.viewStart) / (this.viewEnd - this.viewStart)) * (p.x1 - p.x0); }
  x2t(x) { const p = this.plot(); return this.viewStart + ((x - p.x0) / (p.x1 - p.x0)) * (this.viewEnd - this.viewStart); }
  ov2x(t) { const p = this.plot(); return p.x0 + (this.duration > 0 ? t / this.duration : 0) * (p.x1 - p.x0); }
  ox2t(x) { const p = this.plot(); return clamp(((x - p.x0) / (p.x1 - p.x0)) * this.duration, 0, this.duration); }

  /** Blocks of the output-order strip: [{sec, x, w}] */
  outBlocks() {
    const p = this.plot();
    const total = this.programLength();
    if (!(total > 0)) return [];
    let x = p.x0;
    return this.effSections().map((sec) => {
      const w = ((sec.end - sec.start) / total) * (p.x1 - p.x0);
      const b = { sec, x, w };
      x += w;
      return b;
    });
  }

  // ================================================================== view
  fit() { this.viewStart = 0; this.viewEnd = Math.max(this.duration, 0.1); }
  setView(a, b) {
    const d = Math.max(this.duration, 0.1);
    const span = clamp(b - a, Math.min(MIN_SPAN, d), d);
    const s = clamp(a, 0, d - span);
    this.viewStart = s;
    this.viewEnd = s + span;
  }
  zoomAt(x, factor) {
    const t = this.x2t(x);
    const span = (this.viewEnd - this.viewStart) * factor;
    const s = t - (t - this.viewStart) * factor;
    this.setView(s, s + span);
  }
  panBySeconds(dt) { this.setView(this.viewStart + dt, this.viewEnd + dt); }

  // ================================================================== hit testing
  _secEdgeNear(x, via) {
    const f = via === "ov" ? (t) => this.ov2x(t) : (t) => this.t2x(t);
    let best = null, bd = EDGE_PX + 1;
    for (const sec of this.effSections()) {
      for (const side of ["start", "end"]) {
        const d = Math.abs(x - f(side === "start" ? sec.start : sec.end));
        if (d < bd) { bd = d; best = { type: "sec-edge", sec, side, via }; }
      }
    }
    return best;
  }

  hit(x, y) {
    const P = this.plot();
    if (y < OV_H) {
      return this._secEdgeNear(x, "ov") || { type: "overview", t: this.ox2t(x) };
    }
    if (y < OV_H + OUT_H) {
      const b = this.outBlocks().find((q) => x >= q.x && x < q.x + q.w);
      return b ? { type: "out-block", sec: b.sec } : { type: "none" };
    }
    if (y < OV_H + OUT_H + RULER_H) {
      return (x >= GUTTER - 2 && this._secEdgeNear(x, "main")) || { type: "ruler", t: this.x2t(x) };
    }
    const lane = this.laneAtY(y);
    if (!lane) return { type: "none" };
    if (x < GUTTER) return { type: "label", lane };
    if (lane.kind === "speaker") {
      const t = this.x2t(x);
      for (const c of this.clips) {            // clip edges first: they are the finest handles
        if (c.speaker !== lane.id) continue;
        if (Math.abs(x - this.t2x(c.start)) <= EDGE_PX && x <= this.t2x(c.end) + EDGE_PX) return { type: "clip-edge", clip: c, side: "start", lane };
        if (Math.abs(x - this.t2x(c.end)) <= EDGE_PX) return { type: "clip-edge", clip: c, side: "end", lane };
      }
      const se = this._secEdgeNear(x, "main");
      if (se) return se;
      const c = this.clips.find((q) => q.speaker === lane.id && t >= q.start && t <= q.end);
      return c ? { type: "clip", clip: c, lane, t } : { type: "lane-empty", lane, t };
    }
    return this._secEdgeNear(x, "main") || { type: "lane", lane, t: this.x2t(x) };
  }

  cursorAt(x, y) {
    const h = this.hit(x, y);
    if (h.type === "sec-edge" || h.type === "clip-edge") return "ew-resize";
    if (h.type === "out-block") return "grab";
    if (h.type === "clip") return "pointer";
    if (h.type === "lane-empty") return "crosshair";
    if (h.type === "lane" || h.type === "ruler") return "crosshair";
    if (h.type === "overview" || h.type === "label") return "pointer";
    return "default";
  }

  // ================================================================== pointer gestures
  pointerDown(x, y) {
    const h = this.hit(x, y);
    this.drag = { hit: h, x0: x, y0: y, lastX: x, moved: false };
    return h;
  }

  pointerMove(x, y) {
    const d = this.drag;
    if (!d) return { type: "hover", cursor: this.cursorAt(x, y) };
    if (Math.abs(x - d.x0) > 3 || Math.abs(y - d.y0) > 3) d.moved = true;
    const h = d.hit;
    const P = this.plot();
    switch (h.type) {
      case "sec-edge": {
        const t = h.via === "ov" ? this.ox2t(x) : this.x2t(x);
        h.sec = this.setSectionEdge(h.sec, h.side, t);
        this.sel = { type: "section", ref: h.sec };
        return { type: "edit" };
      }
      case "clip-edge":
        this.setClipEdge(h.clip, h.side, this.x2t(x));
        this.sel = { type: "clip", ref: h.clip };
        return { type: "edit" };
      case "overview": {
        const span = this.viewEnd - this.viewStart;
        const c = this.ox2t(x);
        this.setView(c - span / 2, c + span / 2);
        return { type: "view" };
      }
      case "out-block": {
        if (!d.moved) return { type: "none" };
        const blocks = this.outBlocks().filter((b) => b.sec !== h.sec);
        const to = blocks.filter((b) => b.x + b.w / 2 < x).length;
        this.materialize();
        this.sel = { type: "section", ref: h.sec };
        return this.moveSection(h.sec, to) ? { type: "edit" } : { type: "none" };
      }
      case "ruler":
        if (!d.moved) return { type: "none" };
        this.band = { kind: "section", a: this.x2t(d.x0), b: this.x2t(x) };
        return { type: "band" };
      case "lane-empty":
        if (!d.moved) return { type: "none" };
        this.band = { kind: "clip", a: this.x2t(d.x0), b: this.x2t(x), lane: h.lane };
        return { type: "band" };
      case "clip": {
        if (!d.moved) return { type: "none" };
        const lane = this.laneAtY(y);
        this.dropLane = lane && lane.kind === "speaker" && lane.id !== h.clip.speaker ? lane : null;
        this.sel = { type: "clip", ref: h.clip };
        return { type: "band" };
      }
      case "lane":
        if (!d.moved) return { type: "none" };
        {
          const dt = -((x - d.lastX) / (P.x1 - P.x0)) * (this.viewEnd - this.viewStart);
          d.lastX = x;
          this.panBySeconds(dt);
        }
        return { type: "view" };
      default:
        return { type: "none" };
    }
  }

  pointerUp(x, y) {
    const d = this.drag;
    this.drag = null;
    const band = this.band, drop = this.dropLane;
    this.band = null;
    this.dropLane = null;
    if (!d) return { type: "none" };
    const h = d.hit;
    switch (h.type) {
      case "sec-edge":
      case "clip-edge":
        return d.moved ? { type: "commit" } : { type: "select", ref: h.type === "sec-edge" ? { type: "section", ref: h.sec } : { type: "clip", ref: h.clip } };
      case "out-block":
        if (d.moved) return { type: "commit" };
        this.sel = { type: "section", ref: h.sec };
        return { type: "select" };
      case "overview": {
        if (d.moved) return { type: "none" };
        const sec = this.sections.find((s) => h.t >= s.start && h.t <= s.end);
        this.sel = sec ? { type: "section", ref: sec } : null;
        return { type: "select" };
      }
      case "ruler":
        if (band && Math.abs(band.b - band.a) > 0) {
          const s = this.addSection(band.a, band.b);
          if (s) { this.sel = { type: "section", ref: s }; return { type: "commit" }; }
          return { type: "none" };
        }
        return { type: "click", hit: h, t: this.x2t(x) };
      case "lane-empty":
        if (band) {
          const c = this.addClip(h.lane.id, band.a, band.b);
          if (c) { this.sel = { type: "clip", ref: c }; return { type: "commit" }; }
          return { type: "none" };
        }
        this.sel = null;
        return { type: "click", hit: h, t: this.x2t(x) };
      case "clip":
        if (d.moved) {
          if (drop && this.reassignClip(h.clip, drop.id)) { this.sel = { type: "clip", ref: h.clip }; return { type: "commit" }; }
          return { type: "none" };
        }
        this.sel = { type: "clip", ref: h.clip };
        return { type: "click", hit: h, t: this.x2t(x) };
      case "lane":
        if (d.moved) return { type: "none" };
        this.sel = null;
        return { type: "click", hit: h, t: this.x2t(x) };
      case "label":
        return d.moved ? { type: "none" } : { type: "click-label", lane: h.lane };
      default:
        return { type: "none" };
    }
  }

  // ================================================================== drawing
  _peaksFor(tr) {
    const d = tr.detail;
    if (d && d.start <= this.viewStart + 1e-6 && d.end >= this.viewEnd - 1e-6) return d;
    return tr.coarse;
  }

  _wave(ctx, peaks, yMid, amp, color, from, to) {
    if (!peaks || !peaks.max || !peaks.max.length) return;
    const n = peaks.max.length;
    const per = (peaks.end - peaks.start) / n;
    if (!(per > 0)) return;
    const a = Math.max(from, this.viewStart, peaks.start);
    const b = Math.min(to, this.viewEnd, peaks.end);
    if (b <= a) return;
    ctx.fillStyle = color;
    const xa = Math.floor(this.t2x(a)), xb = Math.ceil(this.t2x(b));
    for (let px = xa; px < xb; px++) {
      const ta = this.x2t(px), tb = this.x2t(px + 1);
      const i0 = clamp(Math.floor((ta - peaks.start) / per), 0, n - 1);
      const i1 = clamp(Math.ceil((tb - peaks.start) / per), i0 + 1, n);
      let mn = 127, mx = -128;
      for (let i = i0; i < i1; i++) { if (peaks.min[i] < mn) mn = peaks.min[i]; if (peaks.max[i] > mx) mx = peaks.max[i]; }
      if (mx < mn) continue;
      ctx.fillRect(px, yMid - (mx / 128) * amp, 1, Math.max(1, (mx - mn) / 128 * amp));
    }
  }

  _text(ctx, s, x, y, color, size = 11, maxW = 0, bold = false) {
    ctx.font = `${bold ? "600 " : ""}${size}px sans-serif`;
    ctx.fillStyle = color;
    if (maxW > 0) while (s.length > 1 && ctx.measureText(s).width > maxW) s = s.slice(0, -2) + "…";
    ctx.fillText(s, x, y);
  }

  draw(ctx) {
    const th = this.theme, { w, h } = this, P = this.plot();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = "middle";
    const selSec = this.sel && this.sel.type === "section" ? this.sel.ref : null;
    const selClip = this.sel && this.sel.type === "clip" ? this.sel.ref : null;
    const secs = this.effSections();
    const explicit = this.hasSections();
    const selTr = this.trackByIndex(this.selTrack);

    // ---- overview: the whole source, the kept sections, the visible window
    ctx.fillStyle = th.lane;
    ctx.fillRect(P.x0, 2, P.x1 - P.x0, OV_H - 4);
    this._text(ctx, "sections", 8, OV_H / 2, th.dim, 11);
    if (selTr && selTr.coarse && this.duration > 0) {
      const pk = selTr.coarse, n = pk.max.length;
      ctx.fillStyle = "#4a4f59";
      for (let px = Math.floor(P.x0); px < P.x1; px++) {
        const i = clamp(Math.floor(((px - P.x0) / (P.x1 - P.x0)) * n), 0, n - 1);
        const amp = Math.max(Math.abs(pk.max[i]), Math.abs(pk.min[i])) / 128;
        const hh = Math.max(1, amp * (OV_H - 8));
        ctx.fillRect(px, OV_H / 2 - hh / 2, 1, hh);
      }
    }
    if (this.duration > 0) {
      secs.forEach((sec, i) => {
        const xs = this.ov2x(sec.start), xe = this.ov2x(sec.end);
        ctx.fillStyle = sec === selSec ? "rgba(255,213,79,0.34)" : "rgba(255,213,79,0.20)";
        ctx.fillRect(xs, 2, Math.max(1, xe - xs), OV_H - 4);
        ctx.fillStyle = th.accent;
        ctx.fillRect(xs - 1, 1, 3, OV_H - 2);
        ctx.fillRect(xe - 2, 1, 3, OV_H - 2);
        if (explicit && xe - xs > 14) this._text(ctx, String(i + 1), xs + 5, OV_H / 2, th.accent, 10, 0, true);
      });
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(this.ov2x(this.viewStart) + 0.5, 2.5, Math.max(2, this.ov2x(this.viewEnd) - this.ov2x(this.viewStart)), OV_H - 5);
    }

    // ---- output order strip
    const oy = OV_H;
    this._text(ctx, `output ${fmtTime(this.programLength())}`, 8, oy + OUT_H / 2, th.dim, 11);
    this.outBlocks().forEach((b, i) => {
      ctx.fillStyle = th.out;
      ctx.fillRect(b.x + 0.5, oy + 2, Math.max(1, b.w - 1), OUT_H - 4);
      if (b.sec === selSec) { ctx.strokeStyle = th.accent; ctx.lineWidth = 1.5; ctx.strokeRect(b.x + 1, oy + 2.5, Math.max(1, b.w - 2), OUT_H - 5); }
      if (b.w > 26) this._text(ctx, explicit ? `${i + 1}  ${fmtTime(b.sec.end - b.sec.start)}` : fmtTime(b.sec.end - b.sec.start), b.x + 5, oy + OUT_H / 2, th.text, 10, b.w - 8);
    });

    // ---- ruler
    const ry = OV_H + OUT_H;
    if (this.duration > 0) {
      const step = niceStep(this.viewEnd - this.viewStart, (P.x1 - P.x0) / 80);
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let t = Math.ceil(this.viewStart / step) * step; t <= this.viewEnd + 1e-9; t += step) {
        const x = Math.round(this.t2x(t)) + 0.5;
        ctx.moveTo(x, ry + RULER_H - 5);
        ctx.lineTo(x, h);
        this._text(ctx, fmtTime(t), x + 3, ry + 8, th.dim, 10);
      }
      ctx.stroke();
    }

    // ---- lanes
    const rects = this.laneRects();
    rects.forEach((r, i) => {
      ctx.fillStyle = i % 2 ? th.laneAlt : th.lane;
      ctx.fillRect(0, r.y, w, r.h);
      const selected = this.selLane ? (this.selLane.kind === r.kind && this.selLane.index === r.index) : (r.kind === "source" && r.index === this.selTrack);
      const isTimeline = r.kind === "source" && r.index === this.selTrack;
      if (selected) { ctx.fillStyle = th.accent; ctx.fillRect(0, r.y, 3, r.h); }
      if (this.dropLane && r.kind === "speaker" && r.id === this.dropLane.id) { ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(0, r.y, w, r.h); }
      const mid = r.y + r.h / 2;
      if (r.kind === "speaker") { ctx.fillStyle = r.color; ctx.beginPath(); ctx.arc(14, mid, 4, 0, Math.PI * 2); ctx.fill(); }
      const lx = r.kind === "speaker" ? 24 : 8;
      if (r.h >= 28) {
        this._text(ctx, r.label, lx, mid - 6, th.text, 11, GUTTER - lx - 6, true);
        this._text(ctx, r.sub, lx, mid + 7, th.dim, 10, GUTTER - lx - 6);
      } else {
        this._text(ctx, r.label, lx, mid, th.text, 11, GUTTER - lx - 6, true);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(P.x0, r.y, P.x1 - P.x0, r.h);
      ctx.clip();
      const amp = (r.h - 4) / 2;
      if (r.kind === "source") {
        const tr = this.trackByIndex(r.index);
        const pk = tr && this._peaksFor(tr);
        if (pk) this._wave(ctx, pk, r.y + r.h / 2, amp, isTimeline ? th.waveSel : th.wave, 0, this.duration);
        else this._text(ctx, tr && tr.error ? tr.error : "loading waveform…", P.x0 + 8, mid, th.dim, 10);
      } else {
        const src = selTr && this._peaksFor(selTr);
        for (const c of this.clips) {
          if (c.speaker !== r.id || c.end < this.viewStart || c.start > this.viewEnd) continue;
          const x1 = this.t2x(c.start), x2 = this.t2x(c.end);
          ctx.fillStyle = r.color + (c === selClip ? "70" : "40");
          ctx.fillRect(x1, r.y + 1, Math.max(1, x2 - x1), r.h - 2);
          if (src) this._wave(ctx, src, r.y + r.h / 2, amp, r.color, c.start, c.end);
          if (c === selClip) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.strokeRect(x1 + 0.5, r.y + 1.5, Math.max(1, x2 - x1 - 1), r.h - 3); }
          ctx.fillStyle = "rgba(255,255,255,0.55)";
          ctx.fillRect(x1, r.y + 3, 2, r.h - 6);
          ctx.fillRect(x2 - 2, r.y + 3, 2, r.h - 6);
        }
        if (this.band && this.band.kind === "clip" && this.band.lane && this.band.lane.id === r.id) {
          const xa = this.t2x(Math.min(this.band.a, this.band.b)), xb = this.t2x(Math.max(this.band.a, this.band.b));
          ctx.fillStyle = r.color + "55";
          ctx.fillRect(xa, r.y + 1, xb - xa, r.h - 2);
        }
      }
      ctx.restore();
    });

    // ---- sections over the lanes: what is NOT kept is dimmed, the section edges are drawn
    if (this.duration > 0 && rects.length) {
      const y0 = OV_H + OUT_H + RULER_H, hh = h - y0;
      const kept = [...secs].sort((a, b) => a.start - b.start);
      let prev = 0;
      ctx.fillStyle = th.shade;
      for (const s of kept) {
        if (s.start > prev) this._shade(ctx, prev, s.start, y0, hh);
        prev = Math.max(prev, s.end);
      }
      if (prev < this.duration) this._shade(ctx, prev, this.duration, y0, hh);
      for (const sec of secs) {
        for (const side of ["start", "end"]) {
          const x = this.t2x(side === "start" ? sec.start : sec.end);
          if (x < P.x0 - 1 || x > P.x1 + 1) continue;
          ctx.fillStyle = sec === selSec ? "#ffffff" : th.accent;
          ctx.fillRect(Math.round(x) - 1, y0, 2, hh);
          ctx.fillRect(side === "start" ? Math.round(x) - 1 : Math.round(x) - 6, y0, 7, 6);
        }
      }
    }
    if (this.band && this.band.kind === "section") {
      const xa = this.t2x(Math.min(this.band.a, this.band.b)), xb = this.t2x(Math.max(this.band.a, this.band.b));
      ctx.fillStyle = "rgba(255,213,79,0.25)";
      ctx.fillRect(xa, OV_H + OUT_H, xb - xa, h - OV_H - OUT_H);
    }

    // ---- playhead
    if (this.playhead != null && this.duration > 0) {
      const x = this.t2x(this.playhead);
      if (x >= P.x0 && x <= P.x1) { ctx.fillStyle = "#ffffff"; ctx.fillRect(Math.round(x), OV_H + OUT_H, 1, h - OV_H - OUT_H); }
    }

    // ---- empty states
    if (!rects.length || this.message) {
      this._text(ctx, this.message || "Choose a file, or connect an audio node", P.x0 + 12, OV_H + OUT_H + RULER_H + 28, th.dim, 12);
    } else if (this.mode === "detected" && this.speakers.length === 0) {
      this._text(ctx, "No speakers yet: press Analyze, or add one with + Speaker", P.x0 + 12, h - 14, th.dim, 11);
    }
  }

  _shade(ctx, a, b, y0, hh) {
    const P = this.plot();
    const xa = Math.max(this.t2x(a), P.x0), xb = Math.min(this.t2x(b), P.x1);
    if (xb > xa) ctx.fillRect(xa, y0, xb - xa, hh);
  }
}

/** Rough size of the saved multi-track file (PCM): {kbps per track, megabytes}. */
export function estimateSave({ depth, rate, channels, seconds, tracks }) {
  const bits = { "16": 16, "24": 24, "32f": 32 }[String(depth)] || 16;
  const kbps = (rate * bits * channels) / 1000;
  return { kbps, megabytes: (kbps * 1000 / 8) * seconds * tracks / 1e6, bits };
}
