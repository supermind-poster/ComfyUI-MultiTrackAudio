// The source viewer (pure, like sequence.js): the whole file in SOURCE time. Parts the sequence uses carry their
// position number, parts that were cut away are dimmed. Mark a range in a cut-away part, then add it to the sequence
// (or drag it onto the sequence). This is how you bring back something you removed.
import { fmtTime, niceStep } from "./timeline.js";
import { fmtTC, HEADER_W, SEQ_THEME } from "./sequence.js";

const RULER_H = 22;
const EDGE_PX = 6;
const MOVE_PX = 4;
const MIN_SEC = 0.05;
const MIN_SPAN = 0.02;
const EPS = 1e-9;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

export class SourceView {
  constructor(tl, peaks) {
    this.tl = tl;
    this.peaks = peaks;
    this.w = 1000;
    this.h = 130;
    this.vStart = 0;
    this.vEnd = 1;
    this.mark = null;             // {a, b} marked range, source seconds
    this.playSrc = null;          // where the sequence playhead is, in source time (null = in a cut-away part)
    this.drag = null;
    this.hover = null;
    this.theme = SEQ_THEME;
  }

  // ---- geometry / view
  plot() { return { x0: HEADER_W, x1: Math.max(HEADER_W + 60, this.w - 10) }; }
  t2x(t) { const p = this.plot(); return p.x0 + ((t - this.vStart) / (this.vEnd - this.vStart)) * (p.x1 - p.x0); }
  x2t(x) { const p = this.plot(); return this.vStart + ((x - p.x0) / (p.x1 - p.x0)) * (this.vEnd - this.vStart); }
  duration() { return this.tl.duration; }
  fit() { this.vStart = 0; this.vEnd = Math.max(this.duration(), 0.1); }
  setView(a, b) {
    const d = Math.max(this.duration(), 0.1);
    const span = clamp(b - a, Math.min(MIN_SPAN, d), d);
    const s = clamp(a, 0, d - span);
    this.vStart = s; this.vEnd = s + span;
  }
  zoomAt(x, f) {
    const t = this.x2t(x);
    const span = (this.vEnd - this.vStart) * f;
    const s = t - (t - this.vStart) * f;
    this.setView(s, s + span);
  }
  panBySeconds(dt) { this.setView(this.vStart + dt, this.vEnd + dt); }
  pxPerSec() { const p = this.plot(); return (p.x1 - p.x0) / (this.vEnd - this.vStart); }

  // ---- the mark
  getMark() { return this.mark ? { a: this.mark.a, b: this.mark.b } : null; }
  clearMark() { this.mark = null; }
  setMark(a, b) {
    if (b < a) [a, b] = [b, a];
    const gap = this.tl.gapAt((a + b) / 2);
    if (!gap) { this.mark = null; return null; }
    a = clamp(a, gap.start, gap.end);
    b = clamp(b, gap.start, gap.end);
    this.mark = b - a >= MIN_SEC ? { a, b } : null;
    return this.mark;
  }
  /** After the sequence changed: a mark that now overlaps a used part is gone. */
  validate() {
    const m = this.mark;
    if (!m) return;
    for (const s of this.tl.effSections()) if (m.a < s.end - EPS && m.b > s.start + EPS) { this.mark = null; return; }
  }

  // ---- hit testing
  hit(x, y) {
    const P = this.plot();
    if (x < HEADER_W) return { type: "label" };
    if (x > P.x1) return { type: "none" };
    if (y < RULER_H) return { type: "ruler", t: this.x2t(x) };
    const t = clamp(this.x2t(x), 0, this.duration());
    const m = this.mark;
    if (m) {
      for (const side of ["a", "b"]) if (Math.abs(x - this.t2x(m[side])) <= EDGE_PX) return { type: "mark-edge", side, t };
      if (t >= m.a && t <= m.b) return { type: "mark", t };
    }
    const entry = this.tl.programLayout().find((e) => t >= e.sec.start && t < e.sec.end);
    if (entry) return { type: "used", entry, t };
    const gap = this.tl.gapAt(t);
    return gap ? { type: "gap", gap, t } : { type: "none" };
  }
  cursorAt(x, y) {
    const h = this.hit(x, y);
    return h.type === "mark-edge" ? "ew-resize" : h.type === "mark" ? "grab" : h.type === "gap" ? "crosshair" : h.type === "used" ? "pointer" : "default";
  }

  // ---- gestures
  pointerDown(x, y) {
    const h = this.hit(x, y);
    this.drag = { hit: h, x0: x, y0: y, lastX: x, moved: false, t0: h.t };
    return h;
  }
  pointerMove(x, y) {
    const d = this.drag;
    if (!d) { this.hover = this.hit(x, y); return { type: "hover", cursor: this.cursorAt(x, y) }; }
    if (Math.abs(x - d.x0) > MOVE_PX || Math.abs(y - d.y0) > MOVE_PX) d.moved = true;
    const h = d.hit;
    switch (h.type) {
      case "gap": {
        if (!d.moved) return { type: "none" };
        const g = h.gap;
        const a = clamp(d.t0, g.start, g.end), b = clamp(this.x2t(x), g.start, g.end);
        this.mark = Math.abs(b - a) >= MIN_SEC ? { a: Math.min(a, b), b: Math.max(a, b) } : null;
        return { type: "mark" };
      }
      case "mark-edge": {
        if (!d.moved || !this.mark) return { type: "none" };
        const m = this.mark;
        const gap = this.tl.gapAt((m.a + m.b) / 2);
        if (!gap) return { type: "none" };
        const t = clamp(this.x2t(x), gap.start, gap.end);
        if (h.side === "a") m.a = Math.min(t, m.b - MIN_SEC); else m.b = Math.max(t, m.a + MIN_SEC);
        m.a = Math.max(m.a, gap.start); m.b = Math.min(m.b, gap.end);
        return { type: "mark" };
      }
      case "mark":
        return d.moved ? { type: "mark-drag" } : { type: "none" };       // the editor takes over: drag it onto the sequence
      case "ruler": case "used": {
        if (!d.moved) return { type: "none" };
        const dt = -((x - d.lastX) / (this.plot().x1 - this.plot().x0)) * (this.vEnd - this.vStart);
        d.lastX = x;
        this.panBySeconds(dt);
        return { type: "view" };
      }
      default:
        return { type: "none" };
    }
  }
  pointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return { type: "none" };
    const h = d.hit;
    switch (h.type) {
      case "gap":
        if (!d.moved) { this.mark = { a: h.gap.start, b: h.gap.end }; if (h.gap.end - h.gap.start < MIN_SEC) this.mark = null; return { type: "mark", whole: true }; }
        return { type: "mark" };
      case "mark-edge": return { type: "mark" };
      case "used":
        if (!d.moved) { this.tl.sel = { type: "section", ref: h.entry.sec }; return { type: "select-section", entry: h.entry }; }
        return { type: "view" };
      case "ruler":
        return { type: "view" };
      default:
        return { type: "none" };
    }
  }
  cancelDrag() { const had = !!this.drag; this.drag = null; return had; }

  // ---- drawing
  _text(ctx, s, x, y, color, size = 11, maxW = 0, bold = false) {
    ctx.font = `${bold ? "600 " : ""}${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = color;
    if (maxW > 0) { while (s.length > 1 && ctx.measureText(s).width > maxW) s = s.slice(0, -2) + "…"; if (ctx.measureText(s).width > maxW) return; }
    ctx.fillText(s, x, y);
  }

  draw(ctx) {
    const th = this.theme, { w, h } = this, P = this.plot();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = th.bg; ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = "middle";
    const dur = this.duration();
    const laneY = RULER_H, laneH = h - RULER_H;

    ctx.fillStyle = th.lane; ctx.fillRect(P.x0, laneY, P.x1 - P.x0, laneH);
    // waveform of the timeline track
    ctx.save();
    ctx.beginPath(); ctx.rect(P.x0, laneY, P.x1 - P.x0, laneH); ctx.clip();
    if (dur > 0) {
      const pk = this.peaks && this.peaks.get(this.tl.selTrack, this.vStart, this.vEnd, P.x1 - P.x0);
      if (pk && pk.max && pk.max.length) {
        const n = pk.max.length, per = (pk.end - pk.start) / n;
        const mid = laneY + laneH / 2, amp = laneH / 2 - 3;
        ctx.fillStyle = "#7d8696";
        for (let px = Math.floor(P.x0); px < P.x1; px++) {
          const ta = this.x2t(px), tb = this.x2t(px + 1);
          const i0 = clamp(Math.floor((ta - pk.start) / per), 0, n - 1);
          const i1 = clamp(Math.ceil((tb - pk.start) / per), i0 + 1, n);
          let mn = 127, mx = -128;
          for (let i = i0; i < i1; i++) { if (pk.min[i] < mn) mn = pk.min[i]; if (pk.max[i] > mx) mx = pk.max[i]; }
          if (mx < mn) continue;
          ctx.fillRect(px, mid - (mx / 128) * amp, 1, Math.max(1, ((mx - mn) / 128) * amp));
        }
      } else this._text(ctx, "loading waveform…", P.x0 + 12, laneY + laneH / 2, th.dim, 11);
      // used parts: tinted, with their position in the sequence
      for (const e of this.tl.programLayout()) {
        const xa = this.t2x(e.sec.start), xb = this.t2x(e.sec.end);
        if (xb < P.x0 || xa > P.x1) continue;
        const sel = this.tl.sel && this.tl.sel.type === "section" && this.tl.sel.ref === e.sec;
        ctx.fillStyle = sel ? "rgba(255,213,79,0.26)" : "rgba(79,195,138,0.20)";
        ctx.fillRect(xa, laneY, xb - xa, laneH);
        ctx.fillStyle = sel ? th.accent : "#3f9a74";
        ctx.fillRect(xa, laneY, Math.max(1, xb - xa), 14);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillRect(xa, laneY, 1, laneH);
        ctx.fillRect(xb - 1, laneY, 1, laneH);
        const tx = Math.max(xa, P.x0) + 5;
        this._text(ctx, `${e.i + 1}`, tx, laneY + 7.5, sel ? "#222" : "#fff", 10.5, Math.min(xb, P.x1) - tx - 2, true);
      }
      // cut-away parts: dimmed, hatched edge so they read as "available"
      for (const g of this.tl.freeGaps()) {
        const xa = Math.max(this.t2x(g.start), P.x0), xb = Math.min(this.t2x(g.end), P.x1);
        if (xb <= xa) continue;
        ctx.fillStyle = "rgba(10,10,12,0.55)";
        ctx.fillRect(xa, laneY, xb - xa, laneH);
        if (xb - xa > 90) this._text(ctx, "not used · click to mark", xa + 8, laneY + laneH - 10, "rgba(255,255,255,0.45)", 10);
      }
      // the mark
      const m = this.mark;
      if (m) {
        const xa = this.t2x(m.a), xb = this.t2x(m.b);
        ctx.fillStyle = "rgba(255,213,79,0.24)"; ctx.fillRect(xa, laneY, xb - xa, laneH);
        ctx.strokeStyle = th.accent; ctx.lineWidth = 2; ctx.strokeRect(xa + 1, laneY + 1, Math.max(1, xb - xa - 2), laneH - 2);
        ctx.fillStyle = th.accent;
        ctx.fillRect(xa - 1, laneY, 4, laneH); ctx.fillRect(xb - 3, laneY, 4, laneH);
        const label = `${(m.b - m.a).toFixed(2)} s`;
        this._text(ctx, label, Math.max(xa, P.x0) + 8, laneY + 24, "#fff", 11, xb - xa - 12, true);
      }
      if (this.playSrc != null) {
        const x = this.t2x(this.playSrc);
        if (x >= P.x0 && x <= P.x1) { ctx.fillStyle = th.playhead; ctx.fillRect(Math.round(x), laneY, 1, laneH); }
      }
    } else {
      this._text(ctx, this.tl.message || "Choose a file, or connect an audio node", P.x0 + 14, laneY + laneH / 2, th.dim, 12);
    }
    ctx.restore();

    // ruler
    ctx.fillStyle = th.ruler; ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = th.line; ctx.fillRect(0, RULER_H - 1, w, 1);
    if (dur > 0) {
      const step = niceStep(this.vEnd - this.vStart, (P.x1 - P.x0) / 96);
      ctx.save();
      ctx.beginPath(); ctx.rect(P.x0, 0, P.x1 - P.x0, RULER_H); ctx.clip();
      ctx.lineWidth = 1; ctx.strokeStyle = "#5a5e69";
      for (let t = Math.ceil(this.vStart / step) * step, i = 0; t <= this.vEnd + 1e-9 && i < 2000; t += step, i++) {
        const x = Math.round(this.t2x(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, RULER_H - 9); ctx.lineTo(x, RULER_H - 1); ctx.stroke();
        this._text(ctx, fmtTC(t, step), x + 4, 9, th.dim, 10);
      }
      ctx.restore();
    }

    // header
    ctx.fillStyle = th.header; ctx.fillRect(0, 0, HEADER_W - 1, h);
    ctx.fillStyle = "#5b6b86"; ctx.fillRect(0, RULER_H, 4, h - RULER_H);
    this._text(ctx, "SOURCE", 14, 11, th.dim, 10.5, 0, true);
    const tr = this.tl.trackByIndex(this.tl.selTrack);
    this._text(ctx, tr ? `T${tr.index}${tr.title ? " " + tr.title : ""}` : "", 14, RULER_H + 20, th.text, 12, HEADER_W - 24, true);
    this._text(ctx, dur > 0 ? `${fmtTime(dur)} total` : "", 14, RULER_H + 37, th.dim, 10.5, HEADER_W - 24);
    const used = this.tl.programLength();
    if (dur > 0) this._text(ctx, `${fmtTime(used)} in the sequence`, 14, RULER_H + 53, th.dim, 10.5, HEADER_W - 24);
  }
}

