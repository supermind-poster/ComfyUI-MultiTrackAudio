// The sequence editor (pure: no DOM, draws to any 2D context, unit-testable). It is a VIEW on the same Timeline model
// as the compact timeline on the node, but laid out like a video editor:
//
//   x axis = OUTPUT time (the order the sections are joined in), so what you see is what you get
//   sections = the clips of the sequence; they sit end to end (magnetic: there are never gaps)
//   audio lanes = the file's tracks, each cut the same way          speaker lanes = who talks when, in output time
//
//   drag a clip ................ re-order (the others make room, the clip drops into the slot)
//   drag a clip edge ........... ripple trim (what follows moves with it)
//   blade tool / S ............. cut          Delete ................... ripple delete
//   drag in an empty speaker lane = draw a clip; drag a speaker clip = move it / hand it to another speaker
import { fmtTime, niceStep } from "./timeline.js";

export const HEADER_W = 168;      // track header column
export const RULER_H = 30;
export const NAV_H = 14;          // the overview/scroll strip at the bottom
const SB_W = 10;                  // vertical scrollbar
const SRC_LANE_H = 84, SRC_LANE_H_MULTI = 64, SPK_LANE_H = 52;
const TITLE_H = 15;               // title bar of a clip block
const EDGE_PX = 7;                // grab zone of a clip edge
const SNAP_PX = 8;
const MOVE_PX = 4;                // movement before a click becomes a drag
const MIN_SPAN = 0.02;            // smallest zoom, seconds
const MIN_SEC = 0.05;
const EPS = 1e-9;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/** Ruler label: as precise as the tick spacing needs. */
export function fmtTC(t, step = 0.1) {
  t = Math.max(0, t);
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const k = 10 ** dec;
  const total = Math.round(t * k) / k;
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const ss = dec ? s.toFixed(dec).padStart(3 + dec, "0") : String(Math.floor(s + 1e-9)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
/** m:ss.mmm */
export function fmtPrecise(t) {
  return fmtTC(t, 0.001);
}
/** "12.5", "1:02.5", "1:02:03.5" -> seconds (NaN when it isn't a time). */
export function parseTime(text) {
  const s = String(text ?? "").trim().replace(",", ".");
  if (!s || !/^\d+(\.\d*)?(:\d+(\.\d*)?){0,2}$/.test(s)) return NaN;
  return s.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
}

export const SEQ_THEME = {
  bg: "#16171a", lane: "#1c1d21", laneAlt: "#1f2025", ruler: "#202228", header: "#25272d", headerSel: "#2e3139",
  text: "#dcdfe5", dim: "#8a8f9a", grid: "#33353d", line: "#0d0e10",
  clip: ["#24463a", "#294f42"], clipTitle: "#2f6b53", clipTitleSel: "#3f9a74", wave: "#8fe0b4",
  other: ["#27303d", "#2b3543"], otherTitle: "#3a4a63", otherWave: "#93abd1",
  accent: "#ffd54f", playhead: "#ff4d4f", snap: "#4dd0e1", ghost: "rgba(255,255,255,0.16)",
};

export class SequenceView {
  /** tl: the Timeline model (shared with the compact widget), peaks: a PeakCache (or anything with get()). */
  constructor(tl, peaks) {
    this.tl = tl;
    this.peaks = peaks;
    this.w = 1000;
    this.h = 360;
    this.vStart = 0;               // visible program range, seconds
    this.vEnd = 10;
    this.scrollY = 0;
    this.tool = "select";          // "select" | "blade"
    this.snap = true;
    this.playhead = 0;             // program time
    this.drag = null;
    this.hover = null;
    this.preview = null;           // re-order in progress: {dragSec, k, layout, floatX, floatW}
    this.band = null;              // drawing a clip: {lane, entry, a, b}
    this.ghost = null;             // moving a speaker clip: {piece, dt, lane}
    this.spkDrop = null;           // a section dragged down to the speakers: {entry, lane} (lane null = a new speaker)
    this.guide = null;             // program time of the snap guide
    this.blade = null;             // {t, lane} cut line under the pointer
    this.dropMark = null;          // program time where a clip dragged from the source would land
    this.tip = null;               // {x, y, text}
    this.theme = SEQ_THEME;
  }

  // ================================================================== geometry
  plot() { return { x0: HEADER_W, x1: Math.max(HEADER_W + 60, this.w - SB_W) }; }
  pxPerSec() { const p = this.plot(); return (p.x1 - p.x0) / (this.vEnd - this.vStart); }
  t2x(t) { const p = this.plot(); return p.x0 + ((t - this.vStart) / (this.vEnd - this.vStart)) * (p.x1 - p.x0); }
  x2t(x) { const p = this.plot(); return this.vStart + ((x - p.x0) / (p.x1 - p.x0)) * (this.vEnd - this.vStart); }
  total() { return this.tl.programLength(); }
  layout() { return this.preview ? this.preview.layout : this.tl.programLayout(); }

  // ================================================================== view
  maxSpan() { return Math.max(this.total() * 1.1, 1); }
  setView(a, b) {
    const T = this.total();
    const span = clamp(b - a, MIN_SPAN, this.maxSpan());
    const s = clamp(a, 0, Math.max(0, T * 1.05 - span));
    this.vStart = s;
    this.vEnd = s + span;
  }
  fit() { this.vStart = 0; this.vEnd = Math.max(this.total() * 1.04, 0.5); }
  zoomAt(x, factor) {
    const t = this.x2t(x);
    const span = (this.vEnd - this.vStart) * factor;
    const s = t - (t - this.vStart) * factor;
    this.setView(s, s + span);
  }
  zoomAround(t, factor) { this.zoomAt(this.t2x(clamp(t, this.vStart, this.vEnd)), factor); }
  panBySeconds(dt) { this.setView(this.vStart + dt, this.vEnd + dt); }
  /** Scroll so that program time t is on screen (page-wise, like a player). */
  ensureVisible(t) {
    const span = this.vEnd - this.vStart;
    if (t > this.vEnd - span * 0.02 || t < this.vStart) this.setView(t - span * 0.1, t + span * 0.9);
  }
  /** After the model changed: keep playhead, view and scroll valid. */
  afterEdit() {
    this.playhead = clamp(this.playhead, 0, this.total());
    this.setView(this.vStart, this.vEnd);
    this.scrollY = clamp(this.scrollY, 0, this.maxScroll());
  }
  /** Vertical scroll of the lanes. */
  contentHeight() { return this._laneList().reduce((a, l) => a + l.h, 0) + SPK_LANE_H + 12; }
  /** y where the audio lanes end (below it are the speaker lanes and the empty area). */
  _srcBottom() {
    const r = this.laneRects().filter((l) => l.kind === "source");
    const last = r[r.length - 1];
    return last ? last.y + last.h : RULER_H;
  }
  viewportHeight() { return Math.max(40, this.h - RULER_H - NAV_H); }
  maxScroll() { return Math.max(0, this.contentHeight() - this.viewportHeight()); }
  scrollBy(dy) { this.scrollY = clamp(this.scrollY + dy, 0, this.maxScroll()); }

  // ================================================================== lanes
  _laneList() {
    const base = this.tl.lanes();
    const nSrc = base.filter((l) => l.kind === "source").length;
    return base.map((l) => ({ ...l, h: l.kind === "source" ? (nSrc > 1 ? SRC_LANE_H_MULTI : SRC_LANE_H) : SPK_LANE_H }));
  }
  laneRects() {
    let y = RULER_H - this.scrollY;
    return this._laneList().map((l) => { const r = { ...l, y }; y += l.h; return r; });
  }
  laneAtY(y) {
    if (y < RULER_H || y >= this.h - NAV_H) return null;
    return this.laneRects().find((r) => y >= r.y && y < r.y + r.h) || null;
  }
  isLaneSelected(r) {
    const s = this.tl.selLane;
    return s ? s.kind === r.kind && s.index === r.index : r.kind === "source" && r.index === this.tl.selTrack;
  }

  // ================================================================== snapping
  _snapPoints(exceptClip = null) {
    const pts = [0, this.total(), this.playhead];
    const layout = this.layout();
    for (const e of layout) pts.push(e.p0, e.p1);
    for (const sp of this.tl.speakers) {
      for (const pc of this.tl.piecesOf(sp.id, layout)) {
        if (exceptClip && pc.clip === exceptClip) continue;
        pts.push(pc.p0, pc.p1);
      }
    }
    return pts;
  }
  /** Snap program time t to the nearest cut / clip edge / playhead within a few pixels. */
  snapP(t, exceptClip = null, off = false) {
    this.guide = null;
    if (!this.snap || off) return t;
    const thr = SNAP_PX / this.pxPerSec();
    let best = null, bd = thr;
    for (const p of this._snapPoints(exceptClip)) {
      const d = Math.abs(p - t);
      if (d < bd) { bd = d; best = p; }
    }
    if (best == null) return t;
    this.guide = best;
    return best;
  }
  /** Snap a SOURCE time (a trimmed section edge) to where speakers start/stop talking. */
  snapSrc(t, off = false) {
    if (!this.snap || off) return t;
    const thr = SNAP_PX / this.pxPerSec();
    const pts = [];
    for (const c of this.tl.clips) pts.push(c.start, c.end);
    const ph = this.tl.programToSource(this.playhead);
    if (ph != null) pts.push(ph);
    let best = t, bd = thr;
    for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  // ================================================================== hit testing
  _secEdgeAt(x, layout) {
    let best = null, bd = Infinity;
    for (const e of layout) {
      const xs = this.t2x(e.p0), xe = this.t2x(e.p1);
      const zone = Math.min(EDGE_PX, (xe - xs) / 3);
      for (const [side, ex] of [["start", xs], ["end", xe]]) {
        let d = Math.abs(x - ex);
        if (side === "start" && x < ex) d += 0.5;      // at a join the pointer belongs to the clip it is inside
        if (side === "end" && x >= ex) d += 0.5;
        if (d <= zone && d < bd) { bd = d; best = { type: "sec-edge", entry: e, side }; }
      }
    }
    return best;
  }

  hit(x, y, edges = true) {
    const P = this.plot();
    if (y < RULER_H) return x < HEADER_W ? { type: "corner" } : { type: "ruler", t: this.x2t(x) };
    if (y >= this.h - NAV_H) return x >= P.x0 && x <= P.x1 ? { type: "nav", t: ((x - P.x0) / (P.x1 - P.x0)) * this.navSpan() } : { type: "none" };
    const lane = this.laneAtY(y);
    if (!lane) return { type: "none" };
    if (x < HEADER_W) {
      if (lane.kind === "speaker" && x >= HEADER_W - 24) return { type: "label-del", lane };
      return { type: "label", lane };
    }
    if (x > P.x1) return { type: "none" };
    const layout = this.layout();
    const t = this.x2t(x);
    if (lane.kind === "source") {
      const edge = edges && this._secEdgeAt(x, layout);
      if (edge) return { ...edge, lane };
      const e = layout.find((q) => t >= q.p0 && t < q.p1);
      return e ? { type: "section", entry: e, lane, t } : { type: "lane-empty", lane, t };
    }
    const pieces = this.tl.piecesOf(lane.id, layout);
    if (edges) {
      for (const pc of pieces) {
        const xs = this.t2x(pc.p0), xe = this.t2x(pc.p1);
        const zone = Math.min(EDGE_PX, (xe - xs) / 3);
        const realStart = pc.clip.start >= pc.entry.sec.start - EPS;     // a cut made by a section join is not an edge
        const realEnd = pc.clip.end <= pc.entry.sec.end + EPS;
        if (realStart && Math.abs(x - xs) <= zone) return { type: "clip-edge", piece: pc, side: "start", lane };
        if (realEnd && Math.abs(x - xe) <= zone) return { type: "clip-edge", piece: pc, side: "end", lane };
      }
    }
    const pc = pieces.find((q) => t >= q.p0 && t <= q.p1);
    return pc ? { type: "clip", piece: pc, lane, t } : { type: "lane-empty", lane, t };
  }

  navSpan() { return Math.max(this.total() * 1.05, this.vEnd, 0.5); }

  cursorAt(x, y) {
    const h = this.hit(x, y, this.tool !== "blade");
    if (this.tool === "blade") return h.type === "section" || h.type === "clip" || h.type === "lane-empty" ? "crosshair" : "default";
    switch (h.type) {
      case "sec-edge": case "clip-edge": return "ew-resize";
      case "section": return this.layout().length > 1 ? "grab" : "default";
      case "clip": return "grab";
      case "lane-empty": return h.lane.kind === "speaker" ? "crosshair" : "default";
      case "ruler": case "nav": case "label": return "pointer";
      case "label-del": return "pointer";
      default: return "default";
    }
  }

  // ================================================================== pointer gestures
  pointerDown(x, y, mods = {}) {
    const h = this.hit(x, y, this.tool !== "blade");
    this.drag = { hit: h, x0: x, y0: y, t0: this.x2t(x), moved: false };
    const d = this.drag;
    if (h.type === "ruler") {
      this.playhead = clamp(this.snapP(h.t, null, mods.alt), 0, this.total());
      d.moved = true;
      return { type: "seek", t: this.playhead };
    }
    if (h.type === "nav") { this._navTo(x); return { type: "view" }; }
    if (h.type === "sec-edge") { d.orig = { start: h.entry.sec.start, end: h.entry.sec.end }; d.base = this.tl.toEdit(); }
    if (h.type === "clip-edge") { d.orig = { start: h.piece.clip.start, end: h.piece.clip.end }; d.base = this.tl.toEdit(); }
    return { type: "none", hit: h };
  }

  _navTo(x) {
    const P = this.plot();
    const t = ((x - P.x0) / (P.x1 - P.x0)) * this.navSpan();
    const span = this.vEnd - this.vStart;
    this.setView(t - span / 2, t + span / 2);
  }

  pointerMove(x, y, mods = {}) {
    const d = this.drag;
    if (!d) {
      this.hover = this.hit(x, y, this.tool !== "blade");
      this.blade = null;
      if (this.tool === "blade" && (this.hover.type === "section" || this.hover.type === "clip" || this.hover.type === "lane-empty") && x >= this.plot().x0) {
        const t = this.snapP(this.x2t(x), null, mods.alt);
        if (t >= 0 && t <= this.total()) this.blade = { t, lane: this.hover.lane };
      } else this.guide = null;
      return { type: "hover", cursor: this.cursorAt(x, y) };
    }
    if (Math.abs(x - d.x0) > MOVE_PX || Math.abs(y - d.y0) > MOVE_PX) d.moved = true;
    const h = d.hit;
    const T = this.total();
    switch (h.type) {
      case "ruler":
        this.playhead = clamp(this.snapP(this.x2t(x), null, mods.alt), 0, T);
        return { type: "seek", t: this.playhead };
      case "nav":
        this._navTo(x);
        return { type: "view" };
      case "sec-edge": {                                   // ripple trim: the pointer moves the edge in the SOURCE by the same distance
        if (!d.moved) return { type: "none" };
        const sec = h.entry.sec;
        const dt = this.x2t(x) - d.t0;
        const want = this.snapSrc(d.orig[h.side] + dt, mods.alt);
        this.tl.setSectionEdge(sec, h.side, want);
        this.tl.sel = { type: "section", ref: sec };
        const edge = h.side === "start" ? sec.start : sec.end;
        const delta = edge - d.orig[h.side];
        this.tip = { x, y, text: `${h.side === "start" ? "In" : "Out"} ${fmtPrecise(edge)}  (${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(3)} s)  ·  length ${(sec.end - sec.start).toFixed(3)} s` };
        return { type: "edit" };
      }
      case "section": {                                    // re-order
        if (!d.moved || this.tool === "blade") return { type: "none" };
        const sec = h.entry.sec;
        const secs = this.tl.effSections();
        if (this.tl.mode === "detected" && y >= this._srcBottom()) {   // pulled down below the audio lanes: copy to a speaker
          const lane = this.laneAtY(y);
          const target = lane && lane.kind === "speaker" ? lane : null;
          this.preview = null;
          this.spkDrop = { entry: h.entry, lane: target };
          this.tl.sel = { type: "section", ref: sec };
          this.tip = { x, y, text: target ? `Copy to ${target.label}` : (this.tl.speakers.length >= this.tl.maxOutputs ? "No free speaker output" : "Copy to a new speaker") };
          return { type: "band" };
        }
        this.spkDrop = null;
        if (secs.length < 2) return { type: "none" };
        if (!d.reorder) d.reorder = { sec, grabT: d.t0 - h.entry.p0, len: sec.end - sec.start, from: secs.indexOf(sec) };
        const r = d.reorder;
        const leftT = this.x2t(x) - r.grabT;               // program time of the floating clip's left edge
        const floatX = this.t2x(leftT);
        const centre = leftT + r.len / 2;
        const others = secs.filter((s) => s !== sec);
        const k = this.tl.programLayout(others).filter((o) => (o.p0 + o.p1) / 2 < centre).length;
        const order = [...others];
        order.splice(k, 0, sec);
        this.preview = { dragSec: sec, k, layout: this.tl.programLayout(order), floatX, floatW: this.t2x(leftT + r.len) - floatX };
        this.tl.sel = { type: "section", ref: sec };
        this.tip = { x, y, text: k === r.from ? `Position ${k + 1} (unchanged)` : `Move to position ${k + 1} of ${secs.length}` };
        return { type: "band" };
      }
      case "clip-edge": {                                  // speaker clip edge
        if (!d.moved) return { type: "none" };
        const pc = h.piece, sec = pc.entry.sec;
        const p = this.snapP(this.x2t(x), pc.clip, mods.alt);
        const src = clamp(sec.start + (p - pc.entry.p0), sec.start, sec.end);
        this.tl.setClipEdge(pc.clip, h.side, src);
        this.tl.sel = { type: "clip", ref: pc.clip };
        const c = pc.clip;
        this.tip = { x, y, text: `${fmtPrecise(c.start)} – ${fmtPrecise(c.end)}  ·  ${(c.end - c.start).toFixed(3)} s` };
        return { type: "edit" };
      }
      case "clip": {                                       // move a speaker clip / hand it to another speaker
        if (!d.moved || this.tool === "blade") return { type: "none" };
        const pc = h.piece;
        const lane = this.laneAtY(y);
        const target = lane && lane.kind === "speaker" ? lane : h.lane;
        let dt = this._snapMove(pc, this.x2t(x) - d.t0, mods.alt);
        const [lo, hi] = this._clipMoveRange(pc, target.id === pc.clip.speaker);
        dt = clamp(dt, lo, hi);
        this.ghost = { piece: pc, dt, lane: target };
        this.tl.sel = { type: "clip", ref: pc.clip };
        const verb = target.id !== pc.clip.speaker ? `→ ${target.label}` : "";
        this.tip = { x, y, text: `${dt >= 0 ? "+" : "−"}${Math.abs(dt).toFixed(3)} s ${verb}`.trim() };
        return { type: "band" };
      }
      case "lane-empty": {
        if (h.lane.kind !== "speaker" || !d.moved || this.tool === "blade") return { type: "none" };
        const layout = this.layout();
        const a0 = d.t0;
        const e = layout.find((q) => a0 >= q.p0 && a0 < q.p1);
        if (!e) return { type: "none" };
        const a = this.snapP(a0, null, mods.alt);
        const b = clamp(this.snapP(this.x2t(x), null, mods.alt), e.p0, e.p1);
        this.band = { lane: h.lane, entry: e, a: clamp(a, e.p0, e.p1), b };
        return { type: "band" };
      }
      default:
        return { type: "none" };
    }
  }

  /** Allowed movement of a speaker clip, in seconds. */
  _clipMoveRange(pc, sameLane) {
    const c = pc.clip, sec = pc.entry.sec;
    if (!(c.start >= sec.start - EPS && c.end <= sec.end + EPS)) return [0, 0];   // it crosses a join: only reassign
    let lo = sec.start - c.start, hi = sec.end - c.end;
    if (sameLane) {
      const [bl, bh] = this.tl._clipBounds(c);
      lo = Math.max(lo, bl - c.start);
      hi = Math.min(hi, bh - c.end);
    }
    return [Math.min(lo, 0), Math.max(hi, 0)];
  }
  _snapMove(pc, dt, off) {
    this.guide = null;
    if (!this.snap || off) return dt;
    const thr = SNAP_PX / this.pxPerSec();
    const pts = this._snapPoints(pc.clip);
    let best = dt, bd = thr, at = null;
    for (const edge of [pc.p0, pc.p1]) {
      for (const p of pts) {
        const d = Math.abs(p - (edge + dt));
        if (d < bd) { bd = d; best = p - edge; at = p; }
      }
    }
    this.guide = at;
    return best;
  }

  pointerUp(x, y, mods = {}) {
    const d = this.drag;
    this.drag = null;
    const band = this.band, ghost = this.ghost, prev = this.preview, spk = this.spkDrop;
    this.band = null; this.ghost = null; this.preview = null; this.spkDrop = null; this.guide = null; this.tip = null;
    if (!d) return { type: "none" };
    const h = d.hit;
    const T = this.total();
    switch (h.type) {
      case "ruler": case "nav":
        return { type: h.type === "ruler" ? "seek-end" : "view" };
      case "sec-edge":
        if (d.moved) return { type: "commit" };
        this.tl.sel = { type: "section", ref: h.entry.sec };
        return { type: "select" };
      case "clip-edge":
        if (d.moved) return { type: "commit" };
        this.tl.sel = { type: "clip", ref: h.piece.clip };
        return { type: "select" };
      case "section": {
        if (this.tool === "blade") return this._bladeCut(h, x);
        if (spk) return this._copyToSpeaker(spk);
        if (prev) {
          const ok = this.tl.moveSection(prev.dragSec, prev.k);
          this.tl.sel = { type: "section", ref: prev.dragSec };
          return ok ? { type: "commit", message: `Moved to position ${prev.k + 1}` } : { type: "select" };
        }
        this.tl.sel = { type: "section", ref: h.entry.sec };
        this.playhead = clamp(this.x2t(x), 0, T);
        return { type: "click", lane: h.lane, t: this.playhead };
      }
      case "clip": {
        if (this.tool === "blade") return this._bladeCut(h, x);
        if (ghost) {
          const c = ghost.piece.clip;
          const moved = Math.abs(ghost.dt) > 1e-6;
          if (moved) { c.start += ghost.dt; c.end += ghost.dt; }
          let reassigned = false;
          if (ghost.lane.id !== c.speaker) reassigned = this.tl.reassignClip(c, ghost.lane.id);
          this.tl.sel = { type: "clip", ref: c };
          return moved || reassigned ? { type: "commit" } : { type: "select" };
        }
        this.tl.sel = { type: "clip", ref: h.piece.clip };
        this.playhead = clamp(this.x2t(x), 0, T);
        return { type: "click", lane: h.lane, t: this.playhead };
      }
      case "lane-empty": {
        if (this.tool === "blade") return this._bladeCut(h, x);
        if (band && Math.abs(band.b - band.a) > 0) {
          const sec = band.entry.sec;
          const src = (p) => sec.start + (p - band.entry.p0);
          const c = this.tl.addClip(band.lane.id, src(Math.min(band.a, band.b)), src(Math.max(band.a, band.b)));
          if (c) { this.tl.sel = { type: "clip", ref: c }; return { type: "commit" }; }
          return { type: "message", text: "No room for a clip here (it would overlap another clip of the same speaker)" };
        }
        this.tl.sel = null;
        this.playhead = clamp(this.x2t(x), 0, T);
        return { type: "click", lane: h.lane, t: this.playhead };
      }
      case "label":
        return d.moved ? { type: "none" } : { type: "label-click", lane: h.lane };
      case "label-del":
        return d.moved ? { type: "none" } : { type: "label-del", lane: h.lane };
      default:
        return { type: "none" };
    }
  }

  /** A section dropped on a speaker lane (or below the lanes = a new speaker): that speaker gets a clip with exactly its range. */
  _copyToSpeaker({ entry, lane }) {
    const tl = this.tl, sec = entry.sec;
    let created = null, id;
    if (lane) id = lane.id;
    else {
      if (tl.speakers.length >= tl.maxOutputs) return { type: "message", text: `At most ${tl.maxOutputs} speakers have an output` };
      created = tl.addSpeaker("");
      id = created.id;
    }
    const c = tl.assignRange(id, sec.start, sec.end);
    if (!c) { if (created) tl.deleteSpeaker(created.id); return { type: "message", text: "That clip is too short to copy" }; }
    tl.sel = { type: "clip", ref: c };
    tl.selLane = { kind: "speaker", index: tl.speakerIndex(id) };
    return { type: "commit", message: created ? `New speaker “${created.name}” with a copy of clip ${entry.i + 1}` : `Copied clip ${entry.i + 1} to ${lane.label}` };
  }

  /** Blade tool: cut the section (audio lanes) or the speaker clip (speaker lanes) under the pointer. */
  _bladeCut(h, x) {
    const t = this.blade ? this.blade.t : this.snapP(this.x2t(x));
    const e = this.tl.entryAt(t, this.layout());
    if (!e) return { type: "none" };
    const src = e.sec.start + (t - e.p0);
    if (h.lane && h.lane.kind === "speaker") {
      const clip = h.type === "clip" ? h.piece.clip : null;
      if (!clip) return { type: "message", text: "Nothing to cut here: there is no clip under the blade" };
      return this.tl.splitClipAt(clip, src) ? { type: "commit", message: "Clip cut" } : { type: "message", text: "Too close to the clip's edge to cut" };
    }
    return this.tl.splitSectionAt(src) ? { type: "commit", message: "Cut" } : { type: "message", text: "Too close to a cut to cut again" };
  }

  /** The pointer left the canvas / the drag was cancelled with Esc: restore what the drag changed. */
  cancelDrag() {
    const d = this.drag;
    this.drag = null; this.band = null; this.ghost = null; this.preview = null; this.spkDrop = null; this.guide = null; this.tip = null;
    if (d && d.base) this.tl.fromEdit(d.base);
    return !!d;
  }

  /** While a drag is near the edge of the plot: how many seconds to pan this frame (0 = none). */
  autoPan(x) {
    if (!this.drag || !this.drag.moved) return 0;
    const t = this.drag.hit.type;
    if (!["section", "sec-edge", "clip", "clip-edge", "lane-empty"].includes(t)) return 0;
    const P = this.plot(), zone = 40;
    const per = 1 / this.pxPerSec();
    if (x < P.x0 + zone) return -clamp((P.x0 + zone - x) / zone, 0, 1) * 14 * per;
    if (x > P.x1 - zone) return clamp((x - (P.x1 - zone)) / zone, 0, 1) * 14 * per;
    return 0;
  }

  // ================================================================== insertion from the source viewer
  /** The cut between two clips (or an end of the sequence) nearest to x: where a dropped range would be inserted. */
  insertPointAt(x) {
    const layout = this.tl.programLayout();
    const t = this.x2t(x);
    let best = { index: 0, t: 0 }, bd = Infinity;
    layout.forEach((e, i) => {
      for (const [idx, pt] of [[i, e.p0], [i + 1, e.p1]]) {
        const dd = Math.abs(pt - t);
        if (dd < bd) { bd = dd; best = { index: idx, t: pt }; }
      }
    });
    return best;
  }
  setDropMark(t) { this.dropMark = t; }

  // ================================================================== commands (keyboard / buttons)
  selectedSection() { return this.tl.sel && this.tl.sel.type === "section" ? this.tl.sel.ref : null; }
  selectedClip() { return this.tl.sel && this.tl.sel.type === "clip" ? this.tl.sel.ref : null; }

  /** Cut at the playhead: the selected speaker clip, else the section under it. */
  splitAtPlayhead() {
    const e = this.tl.entryAt(this.playhead, this.layout());
    if (!e) return { ok: false, text: "Nothing to cut" };
    const src = e.sec.start + (this.playhead - e.p0);
    let clip = this.selectedClip();
    const lane = this.tl.selLane;
    if (!clip && !this.selectedSection() && lane && lane.kind === "speaker") {
      const sp = this.tl.speakers[lane.index];
      clip = sp ? this.tl.clipsOf(sp.id).find((c) => src > c.start && src < c.end) || null : null;
    }
    if (clip) {
      if (!(src > clip.start && src < clip.end)) return { ok: false, text: "The playhead is outside the selected clip" };
      return this.tl.splitClipAt(clip, src) ? { ok: true, text: "Clip cut" } : { ok: false, text: "Too close to the clip's edge to cut" };
    }
    return this.tl.splitSectionAt(src) ? { ok: true, text: "Cut" } : { ok: false, text: "The playhead is on a cut already" };
  }

  /** Ripple delete the selection. */
  deleteSelected() {
    const s = this.tl.sel;
    if (!s) return { ok: false, text: "Select a clip first" };
    if (s.type === "clip") return { ok: this.tl.deleteClip(s.ref), text: "Clip deleted" };
    if (this.tl.effSections().length <= 1) return { ok: false, text: "The sequence needs at least one clip. Use “Whole file” to start over" };
    this.tl.materialize();
    const ok = this.tl.deleteSection(s.ref);
    this.afterEdit();
    return { ok, text: "Clip deleted, the rest moved up" };
  }

  moveSelected(dir) {
    const sec = this.selectedSection();
    if (!sec) return { ok: false, text: "Select a clip first" };
    this.tl.materialize();
    const i = this.tl.sections.indexOf(sec);
    const ok = this.tl.moveSection(sec, i + dir);
    return { ok, text: ok ? `Moved to position ${i + dir + 1}` : "Already there" };
  }

  /** Previous / next cut relative to the playhead. */
  jumpCut(dir) {
    const pts = [0, ...this.tl.programLayout().map((e) => e.p1)];
    const ph = this.playhead;
    const cand = dir > 0 ? pts.filter((p) => p > ph + 1e-3).sort((a, b) => a - b)[0] : pts.filter((p) => p < ph - 1e-3).sort((a, b) => b - a)[0];
    if (cand == null) return null;
    this.playhead = cand;
    return cand;
  }

  // ================================================================== drawing
  _text(ctx, s, x, y, color, size = 11, maxW = 0, bold = false) {
    ctx.font = `${bold ? "600 " : ""}${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = color;
    if (maxW > 0) { while (s.length > 1 && ctx.measureText(s).width > maxW) s = s.slice(0, -2) + "…"; if (ctx.measureText(s).width > maxW) return; }
    ctx.fillText(s, x, y);
  }

  /** Waveform of `track` for source range [s0, s1] drawn into pixels [bx0, bx1] (the part inside the plot only). */
  _wave(ctx, track, s0, s1, bx0, bx1, y, h, color) {
    const P = this.plot();
    const xa = Math.max(Math.floor(bx0), Math.floor(P.x0)), xb = Math.min(Math.ceil(bx1), Math.ceil(P.x1));
    if (xb <= xa || !(bx1 > bx0)) return;
    const k = (s1 - s0) / (bx1 - bx0);                              // source seconds per pixel
    const pk = this.peaks && this.peaks.get(track, s0 + (xa - bx0) * k, s0 + (xb - bx0) * k, xb - xa);
    if (!pk || !pk.max || !pk.max.length) return;
    const n = pk.max.length, per = (pk.end - pk.start) / n;
    if (!(per > 0)) return;
    const mid = y + h / 2, amp = h / 2 - 1;
    ctx.fillStyle = color;
    for (let px = xa; px < xb; px++) {
      const ta = s0 + (px - bx0) * k, tb = ta + k;
      const i0 = clamp(Math.floor((ta - pk.start) / per), 0, n - 1);
      const i1 = clamp(Math.ceil((tb - pk.start) / per), i0 + 1, n);
      let mn = 127, mx = -128;
      for (let i = i0; i < i1; i++) { if (pk.min[i] < mn) mn = pk.min[i]; if (pk.max[i] > mx) mx = pk.max[i]; }
      if (mx < mn) continue;
      ctx.fillRect(px, mid - (mx / 128) * amp, 1, Math.max(1, ((mx - mn) / 128) * amp));
    }
  }

  _block(ctx, lane, e, p0, y, h, o = {}) {
    const th = this.theme;
    const x0 = this.t2x(p0), x1 = this.t2x(p0 + (e.sec.end - e.sec.start));
    const P = this.plot();
    if (x1 < P.x0 - 2 || x0 > P.x1 + 2) return;
    const main = lane.index === this.tl.selTrack;
    const pal = main ? th.clip : th.other;
    ctx.save();
    ctx.beginPath(); ctx.rect(P.x0, y, P.x1 - P.x0, h); ctx.clip();
    if (o.floating) ctx.globalAlpha = 0.88;
    ctx.fillStyle = pal[e.i % 2];
    ctx.fillRect(x0, y, Math.max(1, x1 - x0), h);
    const titled = h >= 44;
    const ty = titled ? y + TITLE_H : y;
    this._wave(ctx, lane.index, e.sec.start, e.sec.end, x0, x1, ty + 1, h - (ty - y) - 2, main ? th.wave : th.otherWave);
    if (titled) {
      ctx.fillStyle = o.selected ? th.clipTitleSel : (main ? th.clipTitle : th.otherTitle);
      ctx.fillRect(x0, y, Math.max(1, x1 - x0), TITLE_H);
      const tx = Math.max(x0, P.x0) + 5;
      const avail = Math.min(x1, P.x1) - tx - 3;
      this._text(ctx, `${e.i + 1}`, tx, y + TITLE_H / 2 + 0.5, "#ffffff", 11, avail, true);
      const num = 14 + String(e.i + 1).length * 4;
      this._text(ctx, `${fmtTime(e.sec.end - e.sec.start)}   src ${fmtTime(e.sec.start)}`, tx + num, y + TITLE_H / 2 + 0.5, "rgba(255,255,255,0.72)", 10, avail - num);
    }
    ctx.strokeStyle = th.line; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(1, x1 - x0 - 1), h - 1);
    if (o.selected) { ctx.strokeStyle = th.accent; ctx.lineWidth = 2; ctx.strokeRect(x0 + 1, y + 1, Math.max(1, x1 - x0 - 2), h - 2); }
    const he = this.hover && this.hover.type === "sec-edge" && this.hover.entry && this.hover.entry.sec === e.sec ? this.hover.side : null;
    if (he && !o.floating) { ctx.fillStyle = th.accent; ctx.fillRect(he === "start" ? x0 : x1 - 3, y, 3, h); }
    ctx.restore();
  }

  _piece(ctx, lane, pc, p0, p1, y, h, o = {}) {
    const x0 = this.t2x(p0), x1 = this.t2x(p1);
    const P = this.plot();
    if (x1 < P.x0 - 2 || x0 > P.x1 + 2) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(P.x0, y, P.x1 - P.x0, h); ctx.clip();
    if (o.alpha != null) ctx.globalAlpha = o.alpha;
    const w = Math.max(1, x1 - x0);
    ctx.fillStyle = lane.color + (o.selected ? "70" : "40");
    ctx.fillRect(x0, y + 2, w, h - 4);
    const sec = pc.entry.sec;
    const src = pc.a, srcEnd = pc.b;
    this._wave(ctx, this.tl.selTrack, src, srcEnd, x0, x1, y + 3, h - 6, lane.color);
    if (o.selected) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.strokeRect(x0 + 0.5, y + 2.5, Math.max(1, w - 1), h - 5); }
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    if (pc.clip.start >= sec.start - EPS) ctx.fillRect(x0, y + 5, 2, h - 10);
    if (pc.clip.end <= sec.end + EPS) ctx.fillRect(x1 - 2, y + 5, 2, h - 10);
    ctx.restore();
  }

  /** The copy that a section dragged down would leave on a speaker lane: its range, straight below the section. */
  _ghostRange(ctx, e, y, h, color) {
    const x0 = this.t2x(e.p0), x1 = this.t2x(e.p1), P = this.plot();
    ctx.save();
    ctx.beginPath(); ctx.rect(P.x0, y, P.x1 - P.x0, h); ctx.clip();
    ctx.fillStyle = color + "66"; ctx.fillRect(x0, y + 2, Math.max(1, x1 - x0), h - 4);
    this._wave(ctx, this.tl.selTrack, e.sec.start, e.sec.end, x0, x1, y + 3, h - 6, color);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, y + 2.5, Math.max(1, x1 - x0 - 1), h - 5);
    ctx.setLineDash([]);
    ctx.restore();
  }

  draw(ctx) {
    const th = this.theme, { w, h } = this, P = this.plot();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = "middle";
    const layout = this.layout();
    const T = this.total();
    const selSec = this.selectedSection(), selClip = this.selectedClip();
    const rects = this.laneRects();
    const laneBottom = h - NAV_H;

    // ---- lanes
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RULER_H, w, laneBottom - RULER_H); ctx.clip();
    rects.forEach((r, li) => {
      if (r.y + r.h < RULER_H || r.y > laneBottom) return;
      ctx.fillStyle = li % 2 ? th.laneAlt : th.lane;
      ctx.fillRect(0, r.y, w, r.h);
      ctx.fillStyle = th.line;
      ctx.fillRect(0, r.y + r.h - 1, w, 1);
      if (r.kind === "source") {
        for (const e of layout) {
          if (this.preview && e.sec === this.preview.dragSec) continue;
          this._block(ctx, r, e, e.p0, r.y + 2, r.h - 4, { selected: e.sec === selSec });
        }
        if (this.preview) {                                           // the slot the dragged clip would drop into
          const e = layout.find((q) => q.sec === this.preview.dragSec);
          if (e) {
            const xa = this.t2x(e.p0), xb = this.t2x(e.p1);
            ctx.fillStyle = th.ghost; ctx.fillRect(xa, r.y + 2, xb - xa, r.h - 4);
            ctx.strokeStyle = th.accent; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
            ctx.strokeRect(xa + 0.5, r.y + 2.5, Math.max(1, xb - xa - 1), r.h - 5);
            ctx.setLineDash([]);
          }
        }
      } else {
        for (const pc of this.tl.piecesOf(r.id, layout)) {
          const isGhosted = this.ghost && this.ghost.piece.clip === pc.clip;
          this._piece(ctx, r, pc, pc.p0, pc.p1, r.y, r.h, { selected: pc.clip === selClip, alpha: isGhosted ? 0.3 : null });
        }
        if (this.band && this.band.lane.id === r.id) {
          const xa = this.t2x(Math.min(this.band.a, this.band.b)), xb = this.t2x(Math.max(this.band.a, this.band.b));
          ctx.fillStyle = r.color + "55"; ctx.fillRect(xa, r.y + 2, xb - xa, r.h - 4);
          ctx.strokeStyle = r.color; ctx.lineWidth = 1; ctx.strokeRect(xa + 0.5, r.y + 2.5, Math.max(1, xb - xa - 1), r.h - 5);
        }
        if (this.ghost && this.ghost.lane.id === r.id) {
          const g = this.ghost, pc = g.piece;
          this._piece(ctx, r, pc, pc.p0 + g.dt, pc.p1 + g.dt, r.y, r.h, { selected: true, alpha: 0.85 });
        }
      }
      if (this.spkDrop && this.spkDrop.lane && r.kind === "speaker" && this.spkDrop.lane.id === r.id) {
        ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fillRect(P.x0, r.y, P.x1 - P.x0, r.h);
        this._ghostRange(ctx, this.spkDrop.entry, r.y, r.h, r.color);
      }
      if (this.ghost && this.ghost.lane.id === r.id && r.kind === "speaker" && this.ghost.lane.id !== this.ghost.piece.clip.speaker) {
        ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fillRect(P.x0, r.y, P.x1 - P.x0, r.h);
      }
    });
    // a new speaker row, offered below the last lane while a section is pulled down
    const last = rects[rects.length - 1];
    const newRowY = last ? last.y + last.h : RULER_H;
    if (this.spkDrop && !this.spkDrop.lane) {
      const col = this.tl.colorOf(this.tl.speakers.length);
      ctx.fillStyle = "rgba(255,255,255,0.05)"; ctx.fillRect(P.x0, newRowY, P.x1 - P.x0, SPK_LANE_H);
      ctx.strokeStyle = col; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
      ctx.strokeRect(P.x0 + 0.5, newRowY + 0.5, P.x1 - P.x0 - 1, SPK_LANE_H - 1);
      ctx.setLineDash([]);
      this._ghostRange(ctx, this.spkDrop.entry, newRowY, SPK_LANE_H, col);
    }
    // the floating clip while re-ordering (above every lane it spans)
    if (this.preview) {
      const e = layout.find((q) => q.sec === this.preview.dragSec);
      if (e) {
        const p0 = this.x2t(this.preview.floatX);
        for (const r of rects) if (r.kind === "source") this._block(ctx, r, { ...e }, p0, r.y + 2, r.h - 4, { selected: true, floating: true });
      }
    }
    if (rects.length === 0 || !(T > 0)) {
      this._text(ctx, this.tl.message || "Choose a file, or connect an audio node", P.x0 + 16, RULER_H + 40, th.dim, 13);
    } else if (this.tl.mode === "detected" && this.tl.speakers.length === 0 && !this.spkDrop) {
      const last = rects[rects.length - 1];
      this._text(ctx, "No speakers yet: press “Analyze speakers”, or add one with “+ Speaker” and draw its clips", P.x0 + 16, last.y + last.h + 22, th.dim, 12);
    }
    // blade line, snap guide, drop mark, playhead
    const vline = (t, color, wpx = 1, from = RULER_H) => {
      const x = this.t2x(t);
      if (x < P.x0 || x > P.x1) return;
      ctx.fillStyle = color; ctx.fillRect(Math.round(x) - Math.floor(wpx / 2), from, wpx, laneBottom - from);
    };
    if (this.tool === "blade" && this.blade) {
      vline(this.blade.t, "rgba(255,255,255,0.85)", 1);
      const hl = rects.find((r) => this.blade.lane && r.kind === this.blade.lane.kind && r.index === this.blade.lane.index);
      if (hl) { ctx.fillStyle = "rgba(255,255,255,0.07)"; ctx.fillRect(P.x0, hl.y, P.x1 - P.x0, hl.h); }
    }
    if (this.guide != null) vline(this.guide, th.snap, 1);
    if (this.dropMark != null) { vline(this.dropMark, th.accent, 3); }
    vline(this.playhead, th.playhead, 1);
    ctx.restore();

    // ---- track headers (opaque, so clips scrolled out to the left never show through)
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RULER_H, HEADER_W, laneBottom - RULER_H); ctx.clip();
    rects.forEach((r) => {
      if (r.y + r.h < RULER_H || r.y > laneBottom) return;
      const sel = this.isLaneSelected(r);
      ctx.fillStyle = sel ? th.headerSel : th.header;
      ctx.fillRect(0, r.y, HEADER_W - 1, r.h - 1);
      ctx.fillStyle = r.kind === "speaker" ? r.color : (r.index === this.tl.selTrack ? "#4fc38a" : "#5b6b86");
      ctx.fillRect(0, r.y, 4, r.h - 1);
      const mid = r.y + r.h / 2;
      let lx = 14;
      if (r.kind === "speaker") { ctx.fillStyle = r.color; ctx.beginPath(); ctx.arc(19, mid - 8, 4, 0, Math.PI * 2); ctx.fill(); lx = 29; }
      const room = HEADER_W - lx - (r.kind === "speaker" ? 26 : 8);
      this._text(ctx, r.label, lx, mid - 8, th.text, 12, room, true);
      this._text(ctx, r.sub, 14, mid + 9, th.dim, 10.5, HEADER_W - 22);
      if (r.kind === "source" && this._laneList().filter((l) => l.kind === "source").length > 1 && r.index === this.tl.selTrack) {
        this._text(ctx, "timeline", HEADER_W - 52, mid - 8, "#4fc38a", 10, 46);
      }
      if (r.kind === "speaker") this._text(ctx, "×", HEADER_W - 16, mid - 8, sel ? th.text : th.dim, 15);
    });
    ctx.restore();

    if (this.spkDrop && !this.spkDrop.lane) {                       // header of the row that would be created
      ctx.save();
      ctx.beginPath(); ctx.rect(0, RULER_H, HEADER_W, laneBottom - RULER_H); ctx.clip();
      ctx.fillStyle = th.header; ctx.fillRect(0, newRowY, HEADER_W - 1, SPK_LANE_H - 1);
      ctx.fillStyle = this.tl.colorOf(this.tl.speakers.length); ctx.fillRect(0, newRowY, 4, SPK_LANE_H - 1);
      this._text(ctx, "+ New speaker", 14, newRowY + SPK_LANE_H / 2 - 7, th.text, 12, HEADER_W - 24, true);
      this._text(ctx, `Speaker ${this.tl.speakers.length + 1}`, 14, newRowY + SPK_LANE_H / 2 + 9, th.dim, 10.5, HEADER_W - 24);
      ctx.restore();
    }

    // ---- vertical scrollbar
    const ms = this.maxScroll();
    if (ms > 0) {
      const vh = this.viewportHeight(), ch = this.contentHeight();
      const th2 = Math.max(24, (vh / ch) * vh);
      const ty = RULER_H + (this.scrollY / ms) * (vh - th2);
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(this.w - SB_W + 2, ty, SB_W - 4, th2);
    }

    // ---- ruler (on top of everything)
    ctx.fillStyle = th.ruler;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = th.line;
    ctx.fillRect(0, RULER_H - 1, w, 1);
    this._text(ctx, `Sequence  ${fmtTC(T, 0.1)}`, 12, RULER_H / 2, th.dim, 11);
    const span = this.vEnd - this.vStart;
    const step = niceStep(span, (P.x1 - P.x0) / 96);
    const mant = Math.round(step / 10 ** Math.floor(Math.log10(step)));
    const sub = mant === 2 ? 4 : 5;
    ctx.save();
    ctx.beginPath(); ctx.rect(P.x0, 0, P.x1 - P.x0, RULER_H); ctx.clip();
    ctx.lineWidth = 1;
    const first = Math.floor(this.vStart / (step / sub)) * (step / sub);
    for (let t = first, i = 0; t <= this.vEnd + 1e-9 && i < 4000; t += step / sub, i++) {
      const x = Math.round(this.t2x(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.strokeStyle = major ? "#5a5e69" : "#43464f";
      ctx.beginPath(); ctx.moveTo(x, RULER_H - (major ? 12 : 6)); ctx.lineTo(x, RULER_H - 1); ctx.stroke();
      if (major && t >= -1e-9) this._text(ctx, fmtTC(t, step), x + 4, 11, th.dim, 10.5);
    }
    // cut marks of the sequence
    for (const e of layout) {
      const x = this.t2x(e.p0);
      if (e.i > 0 && x >= P.x0 && x <= P.x1) { ctx.fillStyle = th.accent; ctx.fillRect(Math.round(x) - 1, RULER_H - 5, 2, 5); }
    }
    // playhead head
    const px = this.t2x(this.playhead);
    if (px >= P.x0 - 8 && px <= P.x1 + 8) {
      ctx.fillStyle = th.playhead;
      ctx.beginPath(); ctx.moveTo(px - 6, RULER_H - 13); ctx.lineTo(px + 6, RULER_H - 13); ctx.lineTo(px, RULER_H - 2); ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    // ---- bottom strip: the whole sequence and the part you see
    const ny = h - NAV_H;
    ctx.fillStyle = th.ruler; ctx.fillRect(0, ny, w, NAV_H);
    const ns = this.navSpan();
    const nx = (t) => P.x0 + (t / ns) * (P.x1 - P.x0);
    ctx.fillStyle = "#2c2f37"; ctx.fillRect(P.x0, ny + 3, P.x1 - P.x0, NAV_H - 6);
    layout.forEach((e) => {
      ctx.fillStyle = e.sec === selSec ? "#8a7a2f" : "#3a6a58";
      ctx.fillRect(nx(e.p0), ny + 3, Math.max(1, nx(e.p1) - nx(e.p0) - 1), NAV_H - 6);
    });
    ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1;
    ctx.strokeRect(nx(this.vStart) + 0.5, ny + 1.5, Math.max(3, nx(this.vEnd) - nx(this.vStart)), NAV_H - 3);
    ctx.fillStyle = th.playhead; ctx.fillRect(Math.round(nx(this.playhead)), ny + 1, 1, NAV_H - 2);
    this._text(ctx, "overview", 12, ny + NAV_H / 2, th.dim, 10);

    // ---- drag tooltip
    if (this.tip) {
      ctx.font = "11px system-ui, sans-serif";
      const tw = ctx.measureText(this.tip.text).width + 14;
      const tx = clamp(this.tip.x + 14, 4, w - tw - 4), ty = clamp(this.tip.y - 30, RULER_H + 2, h - 30);
      ctx.fillStyle = "rgba(10,10,12,0.92)";
      ctx.fillRect(tx, ty, tw, 21);
      ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, 20);
      this._text(ctx, this.tip.text, tx + 7, ty + 11, "#ffffff", 11);
    }
  }
}
