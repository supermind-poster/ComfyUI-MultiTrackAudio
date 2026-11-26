// The full-window sequence editor (DOM glue). No ComfyUI imports: everything it needs comes in through `host`
// (see mta_timeline.js). It edits the SAME Timeline model as the compact widget on the node.
//
// host = {
//   tl,                                   the Timeline model
//   fetchPeaks(track, start, end, n),     -> Promise<peaks>
//   getBuffer(track, lo, hi),             -> Promise<AudioBuffer>   (16 kHz preview of the source, [lo, hi] seconds)
//   audioCtx(),                           shared AudioContext
//   commit(), undo(), redo(),             the shared edit history (writes the node's `edit` widget)
//   canUndo(), canRedo(), isBusy(),
//   analyze(), addSpeaker(), deleteSpeaker(lane), renameSpeaker(index), selectLane(lane),
//   fileLabel(), onClose(),
// }
import { SequenceView, HEADER_W, fmtTC, fmtPrecise, parseTime } from "./sequence.js";
import { SourceView } from "./source.js";
import { PeakCache } from "./peaks.js";

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const SVG = (d, extra = "") => `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" ${extra}>${d}</svg>`;
const ICON = {
  select: SVG('<path d="M3.5 2l8.5 6.4-4.1.8 2.4 4.6-1.8.9-2.4-4.6L3.5 12.4z"/>'),
  blade: SVG('<path d="M7.2 1h1.6v14H7.2z"/><path d="M3 4.2L6.2 8 3 11.8zM13 4.2L9.8 8 13 11.8z" opacity=".75"/>'),
  play: SVG('<path d="M4 2.5v11L13 8z"/>'),
  pause: SVG('<path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/>'),
  toStart: SVG('<path d="M2.5 2.5h1.6v11H2.5zM13.5 2.5v11L5.5 8z"/>'),
  toEnd: SVG('<path d="M11.9 2.5h1.6v11h-1.6zM2.5 2.5v11L10.5 8z"/>'),
  undo: SVG('<path d="M6 3L2 7l4 4V8.2c3.3-.4 5.4.5 7 3.3-.4-4-2.8-6.6-7-6.9z"/>'),
  redo: SVG('<path d="M10 3l4 4-4 4V8.2c-3.3-.4-5.4.5-7 3.3.4-4 2.8-6.6 7-6.9z"/>'),
  snap: SVG('<path d="M3 2h4v6a1 1 0 002 0V2h4v6a5 5 0 01-10 0z"/><path d="M3 2h4v2.2H3zM9 2h4v2.2H9z" fill="#fff" opacity=".55"/>'),
  trash: SVG('<path d="M5.5 2h5l.5 1.5H14V5H2V3.5h3zM3.5 6h9l-.7 8H4.2z"/>'),
  fit: SVG('<path d="M1.5 3.5h1.4v9H1.5zM13.1 3.5h1.4v9h-1.4zM4.5 7.2h4.7L8 6l1-1 3 3-3 3-1-1 1.2-1.2H4.5z"/>'),
  plus: SVG('<path d="M7.2 3h1.6v4.2H13v1.6H8.8V13H7.2V8.8H3V7.2h4.2z"/>'),
  minus: SVG('<path d="M3 7.2h10v1.6H3z"/>'),
  close: SVG('<path d="M3.5 2.3L8 6.8l4.5-4.5 1.2 1.2L9.2 8l4.5 4.5-1.2 1.2L8 9.2l-4.5 4.5-1.2-1.2L6.8 8 2.3 3.5z"/>'),
  earlier: SVG('<path d="M7 3L2 8l5 5V9.2h7V6.8H7z"/>'),
  later: SVG('<path d="M9 3l5 5-5 5V9.2H2V6.8h7z"/>'),
  scissors: SVG('<path d="M4.2 2a2.2 2.2 0 011.9 3.3L8 8l1.9-2.7A2.2 2.2 0 1112 5.3L9.4 8.7 14 14h-2.2L8 10.1 4.2 14H2l4.6-5.3L4 5.3A2.2 2.2 0 014.2 2z" opacity=".95"/>'),
};

const CSS = `
.mta-ed-back{position:fixed;inset:0;z-index:99999;background:rgba(6,7,9,.62);display:flex;align-items:center;justify-content:center;padding:1.2vh 1vw;box-sizing:border-box}
.mta-ed{width:100%;height:100%;max-width:2400px;display:flex;flex-direction:column;background:#16171a;color:#dcdfe5;border:1px solid #34373f;border-radius:8px;
  box-shadow:0 18px 60px rgba(0,0,0,.6);font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden;outline:none;user-select:none}
.mta-ed *{box-sizing:border-box}
.mta-ed-row{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#1d1f24;border-bottom:1px solid #0e0f12;flex:0 0 auto;min-height:38px}
.mta-ed-row.tools{background:#202228}
.mta-ed-title{font-weight:600;font-size:13px;letter-spacing:.2px}
.mta-ed-sub{color:#8a8f9a;max-width:34vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mta-ed-sp{flex:1 1 auto}
.mta-ed-sep{width:1px;height:20px;background:#3a3d46;margin:0 4px}
.mta-ed button,.mta-ed select,.mta-ed input[type=text]{font:inherit;color:#dcdfe5}
.mta-ed .b{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;background:#2b2e36;border:1px solid #3b3f49;border-radius:5px;cursor:pointer;white-space:nowrap}
.mta-ed .b:hover:not(:disabled){background:#353945;border-color:#4a4f5b}
.mta-ed .b:disabled{opacity:.4;cursor:default}
.mta-ed .b.on{background:#3a4f78;border-color:#5b7fc0;color:#fff}
.mta-ed .b.primary{background:#2d6b52;border-color:#3f9a74;color:#fff}
.mta-ed .b.primary:hover:not(:disabled){background:#357e61}
.mta-ed .b.icon{padding:0;width:28px;justify-content:center}
.mta-ed .b kbd{font:10px/1 ui-monospace,monospace;color:#9aa0ac;background:#1a1b1f;border:1px solid #3b3f49;border-radius:3px;padding:2px 4px;margin-left:2px}
.mta-ed .tc{font:600 15px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:#ffd54f;background:#101114;border:1px solid #33363e;border-radius:5px;padding:6px 10px;min-width:150px;text-align:center}
.mta-ed .tc small{color:#8a8f9a;font-weight:400;font-size:12px}
.mta-ed .pane{position:relative;flex:0 0 auto;background:#16171a;overflow:hidden}
.mta-ed .pane.grow{flex:1 1 auto;min-height:130px}
.mta-ed canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;outline:none}
.mta-ed-split{flex:0 0 7px;background:#101114;cursor:row-resize;border-top:1px solid #2a2c33;border-bottom:1px solid #2a2c33}
.mta-ed-split:hover{background:#2b3c5a}
.mta-ed-srcbar{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#1d1f24;border-top:1px solid #0e0f12;border-bottom:1px solid #0e0f12;flex:0 0 auto}
.mta-ed-srcbar .info{color:#8a8f9a;margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mta-ed-insp{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#1d1f24;border-top:1px solid #0e0f12;flex:0 0 auto;min-height:40px;flex-wrap:wrap}
.mta-ed-insp label{color:#8a8f9a;display:inline-flex;align-items:center;gap:5px}
.mta-ed-insp input[type=text]{width:86px;height:24px;background:#111215;border:1px solid #3b3f49;border-radius:4px;padding:0 6px;font-family:ui-monospace,Menlo,Consolas,monospace;user-select:text}
.mta-ed-insp input[type=text]:focus{border-color:#5b7fc0;outline:none}
.mta-ed-insp select{height:24px;background:#111215;border:1px solid #3b3f49;border-radius:4px}
.mta-ed-insp .v{color:#dcdfe5;font-family:ui-monospace,Menlo,Consolas,monospace}
.mta-ed-insp .hint{color:#8a8f9a}
.mta-ed-status{display:flex;gap:12px;align-items:center;padding:5px 10px;background:#121316;border-top:1px solid #0e0f12;color:#8a8f9a;flex:0 0 auto;min-height:26px}
.mta-ed-status .msg{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mta-ed-status .msg.warn{color:#ffb74d}.mta-ed-status .msg.error{color:#ff8a80}.mta-ed-status .msg.busy{color:#ffd54f}
.mta-ed input[type=range]{width:120px;accent-color:#5b7fc0}
.mta-ed-help{position:absolute;right:14px;top:46px;z-index:5;background:#1b1d22;border:1px solid #444955;border-radius:8px;padding:12px 16px;box-shadow:0 10px 30px rgba(0,0,0,.55);
  display:grid;grid-template-columns:auto auto;gap:4px 18px;max-width:560px;color:#cfd3db}
.mta-ed-help b{grid-column:1/-1;margin-bottom:4px;font-size:12px}
.mta-ed-help kbd{font:11px ui-monospace,monospace;background:#101114;border:1px solid #3b3f49;border-radius:3px;padding:1px 5px;color:#ffd54f}
.mta-ed-chip{position:fixed;z-index:100000;pointer-events:none;background:#ffd54f;color:#1a1a1a;font:600 11px system-ui,sans-serif;padding:3px 8px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.5)}
`;

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") Object.assign(e.style, v);
    else if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e[k] = v;
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

export class Editor {
  constructor(host) {
    this.host = host;
    this.tl = host.tl;
    this.peaks = new PeakCache((tr, a, b, n) => host.fetchPeaks(tr, a, b, n), () => this.redraw());
    this.seq = new SequenceView(this.tl, this.peaks);
    this.src = new SourceView(this.tl, this.peaks);
    this.isOpen = false;
    this.play = null;
    this.srcH = 150;
    this.raf = 0;
    this.lastP = { x: 0, y: 0 };
    this.lastMods = {};
    this.pan = null;
    this.srcDrag = null;
    this.status = { text: "", kind: "" };
    this._onKey = (e) => this.onKey(e);
  }

  // ================================================================== open / close
  open() {
    if (this.isOpen) return;
    if (!document.getElementById("mta-ed-style")) document.head.append(h("style", { id: "mta-ed-style", textContent: CSS }));
    const tl = this.tl;
    this.seed();
    this.seq.fit(); this.src.fit();
    const ph = tl.playhead != null ? tl.sourceToProgram(tl.playhead) : null;
    this.seq.playhead = ph != null ? ph : 0;
    this.build();
    this.isOpen = true;
    document.body.append(this.back);
    window.addEventListener("keydown", this._onKey, true);
    this.root.focus({ preventScroll: true });
    this.measure();
    this.setStatus("Drag clips to re-order · drag a clip down onto a speaker lane to copy it there · B = blade · Space = play · ? = all shortcuts");
    this.refreshAll();
    this.ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { this.measure(); this.redraw(); }) : null;
    if (this.ro) { this.ro.observe(this.seqPane); this.ro.observe(this.srcPane); }
  }

  close() {
    if (!this.isOpen) return;
    this.stopPlay();
    this.seq.cancelDrag(); this.src.cancelDrag();
    const t = this.tl.programToSource(this.seq.playhead);
    if (t != null) this.tl.playhead = t;
    window.removeEventListener("keydown", this._onKey, true);
    if (this.ro) this.ro.disconnect();
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.back.remove();
    this.isOpen = false;
    this.host.onClose && this.host.onClose();
  }

  /** Give the peak cache what the compact widget has already loaded. */
  seed() {
    this.peaks.reset();
    for (const t of this.tl.tracks) if (t.coarse) this.peaks.setCoarse(t.index, t.coarse);
  }
  /** The source changed under us (a file loaded, the coarse waveform arrived). */
  sourceChanged() {
    if (!this.isOpen) return;
    this.seed();
    this.seq.fit(); this.src.fit();
    this.refreshAll();
  }
  /** The model was edited elsewhere (analysis finished, undo/redo, a run): re-sync. */
  modelChanged() {
    if (!this.isOpen) return;
    this.seq.afterEdit();
    this.src.validate();
    this.refreshAll();
  }

  // ================================================================== DOM
  btn(icon, label, title, onClick, cls = "") {
    const b = h("button", { class: `b ${cls}${label ? "" : " icon"}`, type: "button", title, html: `${icon || ""}${label ? `<span>${label}</span>` : ""}` });
    b.addEventListener("click", (e) => { e.stopPropagation(); try { onClick(e); } catch (err) { console.error("[MultiTrackAudio]", err); } this.root && this.root.focus({ preventScroll: true }); });
    return b;
  }

  build() {
    const B = (icon, label, title, fn, cls) => this.btn(icon, label, title, fn, cls);
    this.b = {};
    const b = this.b;
    b.start = B(ICON.toStart, "", "Go to start (Home)", () => this.seekTo(0, true));
    b.play = B(ICON.play, "", "Play / pause (Space). Plays the selected lane through the sequence", () => this.togglePlay(), "primary");
    b.end = B(ICON.toEnd, "", "Go to end (End)", () => this.seekTo(this.seq.total(), true));
    this.tc = h("div", { class: "tc" });
    b.analyze = B("", "Analyze speakers", "Detect who speaks when, in the sequence", () => this.analyze());
    b.done = B(ICON.close, "Done", "Close the editor (Esc). Everything is already saved in the node", () => this.close());

    b.select = B(ICON.select, "Select<kbd>V</kbd>", "Select / move / trim (V)", () => this.setTool("select"));
    b.blade = B(ICON.blade, "Blade<kbd>B</kbd>", "Click a clip to cut it there (B)", () => this.setTool("blade"));
    b.undo = B(ICON.undo, "", "Undo (Ctrl+Z)", () => this.undo());
    b.redo = B(ICON.redo, "", "Redo (Ctrl+Shift+Z)", () => this.redo());
    b.split = B(ICON.scissors, "Split<kbd>S</kbd>", "Cut at the playhead (S): the selected speaker clip, else the clip under it", () => this.run(this.seq.splitAtPlayhead()));
    b.del = B(ICON.trash, "Delete<kbd>⌫</kbd>", "Delete the selection; for a clip the rest moves up (Delete)", () => this.run(this.seq.deleteSelected()));
    b.earlier = B(ICON.earlier, "", "Move the selected clip one place earlier (Alt+←)", () => this.run(this.seq.moveSelected(-1)));
    b.later = B(ICON.later, "", "Move the selected clip one place later (Alt+→)", () => this.run(this.seq.moveSelected(1)));
    b.snap = B(ICON.snap, "Snap<kbd>N</kbd>", "Snap to cuts, clip edges and the playhead (N). Hold Alt while dragging to turn it off for a moment", () => this.toggleSnap());
    b.addSpk = B(ICON.plus, "Speaker", "Add an empty speaker lane, then draw its clips in the lane", () => { this.host.addSpeaker(); this.afterHost(); });
    b.zout = B(ICON.minus, "", "Zoom out (-)", () => this.zoom(1.4));
    b.zin = B(ICON.plus, "", "Zoom in (+)", () => this.zoom(1 / 1.4));
    b.fit = B(ICON.fit, "Fit<kbd>⇧Z</kbd>", "Show the whole sequence (Shift+Z)", () => { this.seq.fit(); this.redraw(); });
    b.help = B("", "?", "Keyboard shortcuts (F1)", () => this.toggleHelp());
    this.zoomSlider = h("input", { type: "range", min: "0", max: "100", value: "0", title: "Zoom" });
    this.zoomSlider.addEventListener("input", () => this.zoomToSlider());

    const top = h("div", { class: "mta-ed-row" },
      h("span", { class: "mta-ed-title" }, "Audio Timeline"), h("span", { class: "mta-ed-sub" }, this.host.fileLabel ? this.host.fileLabel() : ""),
      h("span", { class: "mta-ed-sp" }), b.start, b.play, b.end, this.tc, h("span", { class: "mta-ed-sp" }), b.analyze, b.done);
    const tools = h("div", { class: "mta-ed-row tools" },
      b.select, b.blade, h("span", { class: "mta-ed-sep" }), b.undo, b.redo, h("span", { class: "mta-ed-sep" }),
      b.split, b.del, b.earlier, b.later, h("span", { class: "mta-ed-sep" }), b.snap, b.addSpk,
      h("span", { class: "mta-ed-sp" }), b.zout, this.zoomSlider, b.zin, b.fit, b.help);

    // source pane
    b.addEnd = B(ICON.plus, "Add to end", "Append the marked range to the end of the sequence", () => this.addMark("end"));
    b.addAt = B(ICON.later, "Insert at cut", "Insert the marked range at the cut nearest to the playhead (or drag the marked range onto the sequence)", () => this.addMark("playhead"));
    b.clearMark = B("", "Clear mark", "Forget the marked range", () => { this.src.clearMark(); this.refreshAll(); });
    b.whole = B("", "Whole file", "Start over: the sequence becomes the whole file again (Undo brings it back)", () => this.wholeFile());
    this.srcInfo = h("span", { class: "info" });
    const srcBar = h("div", { class: "mta-ed-srcbar" }, h("b", {}, "Source"), this.srcInfo, b.addEnd, b.addAt, b.clearMark, b.whole);
    this.srcCanvas = h("canvas", {});
    this.srcPane = h("div", { class: "pane", style: { height: `${this.srcH}px` } }, this.srcCanvas);
    this.split = h("div", { class: "mta-ed-split", title: "Drag to resize" });
    this.seqCanvas = h("canvas", { tabIndex: 0 });
    this.seqPane = h("div", { class: "pane grow" }, this.seqCanvas);
    this.insp = h("div", { class: "mta-ed-insp" });
    this.msg = h("span", { class: "msg" });
    this.stats = h("span", {});
    const status = h("div", { class: "mta-ed-status" }, this.msg, this.stats);

    this.root = h("div", { class: "mta-ed", tabIndex: -1, role: "dialog", ariaLabel: "Audio Timeline editor" },
      top, tools, srcBar, this.srcPane, this.split, this.seqPane, this.insp, status);
    this.back = h("div", { class: "mta-ed-back" }, this.root);
    this.back.addEventListener("pointerdown", (e) => { if (e.target === this.back) { /* a click outside must not close: it is easy to hit by accident */ e.stopPropagation(); } });
    this.back.addEventListener("contextmenu", (e) => e.preventDefault());
    for (const t of ["keyup", "keypress"]) this.back.addEventListener(t, (e) => e.stopPropagation());

    this.wireSeq();
    this.wireSrc();
    this.wireSplit();
  }

  // ================================================================== sizing / painting
  measure() {
    if (!this.isOpen) return;
    const fit = (canvas, pane, view) => {
      const w = Math.max(200, pane.clientWidth), hh = Math.max(40, pane.clientHeight);
      view.w = w; view.h = hh;
      const d = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(hh * d)) { canvas.width = Math.round(w * d); canvas.height = Math.round(hh * d); }
    };
    fit(this.seqCanvas, this.seqPane, this.seq);
    fit(this.srcCanvas, this.srcPane, this.src);
  }
  redraw() {
    if (!this.isOpen || this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }
  paint() {
    if (!this.isOpen) return;
    this.measure();
    const d = window.devicePixelRatio || 1;
    for (const [canvas, view] of [[this.srcCanvas, this.src], [this.seqCanvas, this.seq]]) {
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      try { view.draw(ctx); } catch (e) { console.error("[MultiTrackAudio] draw failed", e); }
    }
    this.updateTimecode();
  }
  updateTimecode() {
    const s = this.seq;
    this.tc.innerHTML = `${fmtPrecise(s.playhead)} <small>/ ${fmtPrecise(s.total())}</small>`;
    const p = this.tl.programToSource(s.playhead);
    this.src.playSrc = p;
  }

  /** Everything that depends on the model: buttons, inspector, stats. */
  refreshAll() {
    if (!this.isOpen) return;
    const tl = this.tl, b = this.b;
    this.seq.afterEdit();
    b.undo.disabled = !this.host.canUndo();
    b.redo.disabled = !this.host.canRedo();
    b.select.classList.toggle("on", this.seq.tool === "select");
    b.blade.classList.toggle("on", this.seq.tool === "blade");
    b.snap.classList.toggle("on", this.seq.snap);
    const sel = tl.sel;
    b.del.disabled = !sel;
    b.earlier.disabled = b.later.disabled = !(sel && sel.type === "section" && tl.effSections().length > 1);
    b.addSpk.disabled = tl.mode !== "detected";
    b.analyze.disabled = !!(this.host.isBusy && this.host.isBusy());
    const m = this.src.getMark();
    b.addEnd.disabled = b.addAt.disabled = !m;
    b.clearMark.disabled = !m;
    b.whole.disabled = !tl.hasSections();
    this.srcInfo.textContent = m
      ? `Marked ${fmtPrecise(m.a)} – ${fmtPrecise(m.b)}  (${(m.b - m.a).toFixed(2)} s)`
      : (tl.freeGaps().length ? "Click a dimmed part to mark it, then add it to the sequence" : "Everything is in the sequence. Trim or delete clips to free up source material");
    this.stats.textContent = `${tl.effSections().length} clip${tl.effSections().length === 1 ? "" : "s"} · ${fmtTC(tl.programLength(), 0.1)}` + (tl.mode === "detected" ? ` · ${tl.speakers.length} speaker${tl.speakers.length === 1 ? "" : "s"}` : "");
    this.zoomSlider.value = String(this.sliderFromView());
    this.updateInspector();
    this.redraw();
  }

  setStatus(text, kind = "") {
    this.status = { text, kind };
    if (!this.msg) return;
    this.msg.textContent = text || "";
    this.msg.className = `msg ${kind}`;
    this.msg.title = text || "";
  }

  // ================================================================== inspector
  timeInput(value, onApply) {
    const i = h("input", { type: "text", value: fmtPrecise(value), spellcheck: false });
    const apply = () => { const t = parseTime(i.value); if (Number.isFinite(t)) onApply(t); else i.value = fmtPrecise(value); };
    i.addEventListener("change", apply);
    i.addEventListener("keydown", (e) => { if (e.key === "Enter") { apply(); i.blur(); this.root.focus(); } else if (e.key === "Escape") { i.value = fmtPrecise(value); i.blur(); this.root.focus(); e.stopPropagation(); } });
    return i;
  }
  updateInspector() {
    const tl = this.tl, el = this.insp;
    el.textContent = "";
    const sel = tl.sel;
    if (sel && sel.type === "section" && tl.effSections().includes(sel.ref)) {
      const sec = sel.ref;
      const lay = tl.programLayout().find((e) => e.sec === sec);
      const n = tl.effSections().length;
      el.append(h("b", {}, `Clip ${lay.i + 1} of ${n}`),
        h("label", {}, "In ", this.timeInput(sec.start, (t) => { tl.setSectionRange(sec, t, sec.end); this.commit("Trimmed"); })),
        h("label", {}, "Out ", this.timeInput(sec.end, (t) => { tl.setSectionRange(sec, sec.start, t); this.commit("Trimmed"); })),
        h("label", {}, "Length ", h("span", { class: "v" }, `${(sec.end - sec.start).toFixed(3)} s`)),
        h("label", {}, "Starts at ", h("span", { class: "v" }, fmtPrecise(lay.p0))),
        h("span", { class: "hint" }, "In/Out are positions in the source file; type a time (1:02.5) and press Enter"));
    } else if (sel && sel.type === "clip" && tl.clips.includes(sel.ref)) {
      const c = sel.ref;
      const sp = tl.speakerOf(c.speaker);
      const spk = h("select", {}, ...tl.speakers.map((s) => h("option", { value: s.id, selected: s.id === c.speaker }, s.name)));
      spk.addEventListener("change", () => { if (tl.reassignClip(c, spk.value)) this.commit("Clip given to another speaker"); });
      el.append(h("b", {}, `${sp ? sp.name : "Speaker"} · clip`),
        h("label", {}, "Start ", this.timeInput(c.start, (t) => { tl.setClipRange(c, t, c.end); this.commit(); })),
        h("label", {}, "End ", this.timeInput(c.end, (t) => { tl.setClipRange(c, c.start, t); this.commit(); })),
        h("label", {}, "Length ", h("span", { class: "v" }, `${(c.end - c.start).toFixed(3)} s`)),
        h("label", {}, "Speaker ", spk),
        h("span", { class: "hint" }, "Start/End are source times. Drag the clip onto another lane to hand it over"));
    } else {
      el.append(h("span", { class: "hint" }, "Select a clip to see and type exact values. Drag a clip left/right to re-order, drag its edges to trim, press B to cut."));
    }
  }

  // ================================================================== actions
  /** A finished edit: tell the host (writes the widget, keeps undo history), then refresh everything. */
  commit(message = "") {
    this.stopPlay();
    this.host.commit();
    this.src.validate();
    this.refreshAll();
    if (message) this.setStatus(message);
  }
  run(res) {
    if (!res) return;
    if (res.ok) this.commit(res.text); else this.setStatus(res.text, "warn");
  }
  afterHost() { this.modelChanged(); this.root && this.root.focus({ preventScroll: true }); }
  undo() { this.stopPlay(); this.host.undo(); this.modelChanged(); this.setStatus("Undone"); }
  redo() { this.stopPlay(); this.host.redo(); this.modelChanged(); this.setStatus("Redone"); }
  setTool(t) { this.seq.tool = t; this.seq.blade = null; this.refreshAll(); }
  toggleSnap() { this.seq.snap = !this.seq.snap; this.refreshAll(); this.setStatus(this.seq.snap ? "Snapping on" : "Snapping off"); }
  wholeFile() {
    this.stopPlay();
    this.tl.sections = [];
    this.tl.sel = null;
    this.commit("The sequence is the whole file again");
    this.seq.fit();
    this.redraw();
  }

  async analyze() {
    if (this.host.isBusy && this.host.isBusy()) return;
    this.refreshAll();
    try { await this.host.analyze(); } finally { this.modelChanged(); }
  }

  addMark(where) {
    const m = this.src.getMark();
    if (!m) return;
    const index = where === "end" ? this.tl.effSections().length : this.seq.insertPointAt(this.seq.t2x(this.seq.playhead)).index;
    this.insertMark(index);
  }
  insertMark(index) {
    const m = this.src.getMark();
    if (!m) return;
    const s = this.tl.insertSection(m.a, m.b, index);
    if (!s) { this.setStatus("That part of the source is already in the sequence", "warn"); return; }
    this.tl.sel = { type: "section", ref: s };
    this.src.clearMark();
    this.commit(`Added to the sequence at position ${index + 1}`);
    const e = this.tl.programLayout().find((x) => x.sec === s);
    if (e) this.seq.ensureVisible(e.p0);
    this.redraw();
  }

  // ---- view
  zoom(factor) {
    const s = this.seq;
    const c = s.playhead >= s.vStart && s.playhead <= s.vEnd ? s.playhead : (s.vStart + s.vEnd) / 2;
    s.zoomAround(c, factor);
    this.refreshAll();
  }
  sliderFromView() {
    const s = this.seq, span = s.vEnd - s.vStart, max = s.maxSpan();
    return Math.round(clamp(Math.log(max / span) / Math.log(max / 0.05), 0, 1) * 100);
  }
  zoomToSlider() {
    const s = this.seq, max = s.maxSpan();
    const k = Number(this.zoomSlider.value) / 100;
    const span = max * Math.pow(0.05 / max, k);
    const c = s.playhead >= s.vStart && s.playhead <= s.vEnd ? s.playhead : (s.vStart + s.vEnd) / 2;
    const f = (c - s.vStart) / (s.vEnd - s.vStart);
    s.setView(c - span * f, c + span * (1 - f));
    this.redraw();
  }

  // ---- playhead / playback
  seekTo(t, final = false) {
    const s = this.seq;
    s.playhead = clamp(t, 0, s.total());
    s.ensureVisible(s.playhead);
    if (this.play && final) { const at = s.playhead; this.stopPlay(); this.startPlay(at); }
    this.redraw();
  }
  async togglePlay() { if (this.play) this.stopPlay(); else await this.startPlay(); }
  async startPlay(from = this.seq.playhead) {
    const tl = this.tl, ctxHost = this.host;
    const lane = tl.selLane || { kind: "source", index: tl.selTrack };
    const track = lane.kind === "source" ? lane.index : tl.selTrack;
    const layout = tl.programLayout();
    const total = this.seq.total();
    let pieces = [];
    if (lane.kind === "source") pieces = layout.map((e) => ({ a: e.sec.start, b: e.sec.end, at: e.p0 }));
    else { const sp = tl.speakers[lane.index]; pieces = sp ? tl.piecesOf(sp.id, layout).map((pc) => ({ a: pc.a, b: pc.b, at: pc.p0 })) : []; }
    if (!pieces.length) { this.setStatus("Nothing to play in this lane", "warn"); return; }
    if (from >= total - 0.02) from = 0;
    this.setStatus("Loading audio…", "busy");
    const token = (this._playToken = (this._playToken || 0) + 1);
    try {
      const lo = Math.min(...pieces.map((p) => p.a)), hi = Math.max(...pieces.map((p) => p.b));
      const buf = await ctxHost.getBuffer(track, lo, hi);
      if (token !== this._playToken || !this.isOpen) return;
      const ctx = ctxHost.audioCtx();
      await ctx.resume();
      const when0 = ctx.currentTime + 0.06;
      const sources = [];
      for (const p of pieces) {
        let { a, at } = p;
        const b = p.b;
        if (at + (b - a) <= from + 0.01) continue;
        if (at < from) { a += from - at; at = from; }
        const len = b - a;
        const s = ctx.createBufferSource();
        s.buffer = buf;
        const g = ctx.createGain();
        const t = when0 + (at - from), f = Math.min(0.008, len / 3);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(1, t + f);
        g.gain.setValueAtTime(1, t + len - f);
        g.gain.linearRampToValueAtTime(0, t + len);
        s.connect(g); g.connect(ctx.destination);
        s.start(t, a - lo, len);
        sources.push(s);
      }
      this.play = { ctx, sources, when0, from, total, raf: 0 };
      this.b.play.innerHTML = ICON.pause;
      this.setStatus(lane.kind === "source" ? `Playing track ${track}` : `Playing ${(tl.speakers[lane.index] || {}).name || "speaker"}`);
      const loop = () => {
        const p = this.play;
        if (!p) return;
        const pos = p.from + (p.ctx.currentTime - p.when0);
        if (pos >= p.total) { this.stopPlay(true); return; }
        this.seq.playhead = Math.max(pos, p.from);
        this.seq.ensureVisible(this.seq.playhead);
        this.paint();
        p.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {
      this.setStatus(String((e && e.message) || e), "error");
    }
  }
  stopPlay(finished = false) {
    this._playToken = (this._playToken || 0) + 1;
    const p = this.play;
    if (!p) return;
    this.play = null;
    cancelAnimationFrame(p.raf);
    for (const s of p.sources) { try { s.stop(); } catch (e) { /* already stopped */ } }
    if (this.b && this.b.play) this.b.play.innerHTML = ICON.play;
    if (finished) this.setStatus("");
    this.redraw();
  }

  // ================================================================== pointer wiring: sequence
  local(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  mods(e) { return { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }; }

  wireSeq() {
    const c = this.seqCanvas, s = this.seq;
    c.addEventListener("pointerdown", (e) => {
      this.root.focus({ preventScroll: true });
      const p = this.local(c, e);
      if (e.button === 1 || (e.button === 0 && e.shiftKey && e.altKey)) {          // middle button: pan
        this.pan = { x: p.x, vStart: s.vStart, vEnd: s.vEnd };
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      this.lastP = p; this.lastMods = this.mods(e);
      c.setPointerCapture(e.pointerId);
      this.peaks.pause();
      const ev = s.pointerDown(p.x, p.y, this.lastMods);
      this.handleSeq(ev, p);
      this.startAutoPan();
      e.preventDefault();
    });
    c.addEventListener("pointermove", (e) => {
      const p = this.local(c, e);
      if (this.pan) {
        const span = this.pan.vEnd - this.pan.vStart, P = s.plot();
        const dt = -((p.x - this.pan.x) / (P.x1 - P.x0)) * span;
        s.setView(this.pan.vStart + dt, this.pan.vEnd + dt);
        this.redraw();
        return;
      }
      this.lastP = p; this.lastMods = this.mods(e);
      const ev = s.pointerMove(p.x, p.y, this.lastMods);
      if (ev.type === "hover") { c.style.cursor = ev.cursor; this.redraw(); return; }
      this.handleSeq(ev, p);
    });
    const up = (e) => {
      const p = this.local(c, e);
      try { c.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
      if (this.pan) { this.pan = null; this.peaks.resume(); this.redraw(); return; }
      if (!s.drag) { this.peaks.resume(); return; }
      const ev = s.pointerUp(p.x, p.y, this.mods(e));
      this.peaks.resume();
      this.stopAutoPan();
      this.handleSeq(ev, p);
      this.updateInspector();
      this.refreshButtonsOnly();
      this.redraw();
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", (e) => { if (s.drag) { s.cancelDrag(); this.stopAutoPan(); this.peaks.resume(); this.refreshAll(); } });
    c.addEventListener("pointerleave", () => { if (!s.drag) { s.hover = null; s.blade = null; s.guide = null; this.redraw(); } });
    c.addEventListener("wheel", (e) => {
      e.preventDefault(); e.stopPropagation();
      const p = this.local(c, e);
      if (e.altKey || p.x < HEADER_W) { s.scrollBy(e.deltaY); }
      else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const P = s.plot();
        s.panBySeconds(((e.deltaX || e.deltaY) / (P.x1 - P.x0)) * (s.vEnd - s.vStart));
      } else s.zoomAt(p.x, Math.exp(clamp(e.deltaY, -120, 120) * 0.002));
      this.zoomSlider.value = String(this.sliderFromView());
      this.redraw();
    }, { passive: false });
    c.addEventListener("dblclick", (e) => {
      const p = this.local(c, e);
      const hit = s.hit(p.x, p.y);
      if (hit.type === "label" && hit.lane.kind === "speaker") { this.host.renameSpeaker(hit.lane.index); this.afterHost(); }
      else if (hit.type === "section") {
        const en = hit.entry, pad = (en.p1 - en.p0) * 0.08;
        s.setView(en.p0 - pad, en.p1 + pad);
        this.refreshAll();
      } else if (hit.type === "ruler" || hit.type === "lane-empty" || hit.type === "nav") { s.fit(); this.refreshAll(); }
    });
  }

  refreshButtonsOnly() {
    const sel = this.tl.sel, b = this.b;
    b.del.disabled = !sel;
    b.earlier.disabled = b.later.disabled = !(sel && sel.type === "section" && this.tl.effSections().length > 1);
  }

  handleSeq(ev, p) {
    const s = this.seq, tl = this.tl;
    switch (ev.type) {
      case "seek": s.ensureVisible(s.playhead); this.redraw(); break;
      case "seek-end": if (this.play) { const at = s.playhead; this.stopPlay(); this.startPlay(at); } this.redraw(); break;
      case "edit": this.updateInspector(); this.redraw(); break;
      case "band": case "view": this.redraw(); break;
      case "commit": this.commit(ev.message || ""); break;
      case "select": this.refreshAll(); break;
      case "click":
        if (ev.lane) this.softSelectLane(ev.lane);
        if (this.play) { const at = s.playhead; this.stopPlay(); this.startPlay(at); }
        this.refreshAll();
        break;
      case "label-click": this.host.selectLane(ev.lane); this.softSelectLane(ev.lane, true); this.refreshAll(); break;
      case "label-del": {
        const lane = ev.lane;
        this.host.deleteSpeaker(lane);
        this.afterHost();
        break;
      }
      case "message": this.setStatus(ev.text, "warn"); this.redraw(); break;
      default: break;
    }
  }
  /** A click on a lane selects it for playback without changing which track is the timeline. */
  softSelectLane(lane, header = false) {
    const cur = this.tl.selLane;
    if (!cur || cur.kind !== lane.kind || cur.index !== lane.index) {
      this.tl.selLane = { kind: lane.kind, index: lane.index };
      if (this.play) this.stopPlay();
    }
  }

  startAutoPan() {
    if (this.autoRaf) return;
    const tick = () => {
      const s = this.seq;
      if (!s.drag) { this.autoRaf = 0; return; }
      const dt = s.autoPan(this.lastP.x);
      if (dt) {
        s.panBySeconds(dt);
        const ev = s.pointerMove(this.lastP.x, this.lastP.y, this.lastMods);
        if (ev.type !== "hover") this.handleSeq(ev, this.lastP);
      }
      this.autoRaf = requestAnimationFrame(tick);
    };
    this.autoRaf = requestAnimationFrame(tick);
  }
  stopAutoPan() { cancelAnimationFrame(this.autoRaf); this.autoRaf = 0; }

  // ================================================================== pointer wiring: source
  wireSrc() {
    const c = this.srcCanvas, v = this.src;
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.root.focus({ preventScroll: true });
      const p = this.local(c, e);
      c.setPointerCapture(e.pointerId);
      this.peaks.pause();
      v.pointerDown(p.x, p.y);
      e.preventDefault();
    });
    c.addEventListener("pointermove", (e) => {
      const p = this.local(c, e);
      if (this.srcDrag) { this.moveSrcDrag(e); return; }
      const ev = v.pointerMove(p.x, p.y);
      if (ev.type === "hover") { c.style.cursor = ev.cursor; return; }
      if (ev.type === "mark-drag") { this.beginSrcDrag(e); return; }
      this.refreshSrcOnly();
    });
    c.addEventListener("pointerup", (e) => {
      try { c.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
      this.peaks.resume();
      if (this.srcDrag) { this.endSrcDrag(e); return; }
      const p = this.local(c, e);
      const ev = v.pointerUp(p.x, p.y);
      if (ev.type === "select-section") {
        this.seq.playhead = ev.entry.p0;
        this.seq.ensureVisible(ev.entry.p0);
        this.refreshAll();
      } else this.refreshAll();
    });
    c.addEventListener("pointercancel", () => { v.cancelDrag(); this.cancelSrcDrag(); this.peaks.resume(); this.refreshAll(); });
    c.addEventListener("wheel", (e) => {
      e.preventDefault(); e.stopPropagation();
      const p = this.local(c, e);
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const P = v.plot();
        v.panBySeconds(((e.deltaX || e.deltaY) / (P.x1 - P.x0)) * (v.vEnd - v.vStart));
      } else v.zoomAt(p.x, Math.exp(clamp(e.deltaY, -120, 120) * 0.002));
      this.redraw();
    }, { passive: false });
    c.addEventListener("dblclick", (e) => { const p = this.local(c, e); const hit = v.hit(p.x, p.y); if (hit.type === "ruler" || hit.type === "none" || hit.type === "used") { v.fit(); this.redraw(); } });
  }
  refreshSrcOnly() {
    const m = this.src.getMark();
    this.b.addEnd.disabled = this.b.addAt.disabled = this.b.clearMark.disabled = !m;
    this.srcInfo.textContent = m ? `Marked ${fmtPrecise(m.a)} – ${fmtPrecise(m.b)}  (${(m.b - m.a).toFixed(2)} s)` : "";
    this.redraw();
  }

  // drag the marked range from the source onto the sequence
  beginSrcDrag(e) {
    const m = this.src.getMark();
    if (!m) return;
    this.src.cancelDrag();
    this.chip = h("div", { class: "mta-ed-chip" }, `＋ ${(m.b - m.a).toFixed(2)} s`);
    document.body.append(this.chip);
    this.srcDrag = { pt: null };
    this.moveSrcDrag(e);
  }
  moveSrcDrag(e) {
    const d = this.srcDrag;
    if (!d) return;
    this.chip.style.left = `${e.clientX + 14}px`;
    this.chip.style.top = `${e.clientY + 12}px`;
    const r = this.seqCanvas.getBoundingClientRect();
    const inside = e.clientX >= r.left + HEADER_W && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    d.pt = inside ? this.seq.insertPointAt(e.clientX - r.left) : null;
    this.seq.setDropMark(d.pt ? d.pt.t : null);
    this.redraw();
  }
  endSrcDrag(e) {
    const d = this.srcDrag;
    this.cancelSrcDrag();
    if (d && d.pt) this.insertMark(d.pt.index);
    else this.refreshAll();
  }
  cancelSrcDrag() {
    if (this.chip) { this.chip.remove(); this.chip = null; }
    this.srcDrag = null;
    this.seq.setDropMark(null);
  }

  // ---- the splitter between the source and the sequence
  wireSplit() {
    const s = this.split;
    let st = null;
    s.addEventListener("pointerdown", (e) => { st = { y: e.clientY, h: this.srcH }; s.setPointerCapture(e.pointerId); e.preventDefault(); });
    s.addEventListener("pointermove", (e) => {
      if (!st) return;
      const room = this.root.clientHeight - 360;
      this.srcH = clamp(st.h + (e.clientY - st.y), 70, Math.max(120, room));
      this.srcPane.style.height = `${this.srcH}px`;
      this.measure(); this.redraw();
    });
    s.addEventListener("pointerup", (e) => { st = null; try { s.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ } });
  }

  // ================================================================== keyboard
  toggleHelp() {
    if (this.helpEl) { this.helpEl.remove(); this.helpEl = null; return; }
    const rows = [
      ["Space", "play / pause"], ["Home / End", "start / end"], ["← →", "nudge playhead (Shift = 1 s)"], ["↑ ↓", "previous / next cut"],
      ["V · B", "select tool · blade tool"], ["S", "cut at the playhead"], ["Delete", "delete (the rest moves up)"], ["Alt + ← →", "move the clip earlier / later"],
      ["Drag a clip down", "copy it to a speaker lane (below the lanes = a new speaker)"],
      ["N", "snapping on / off (Alt while dragging = off)"], ["Ctrl+Z · Ctrl+Shift+Z", "undo · redo"], ["Wheel", "zoom at the pointer"], ["Shift + wheel", "scroll sideways"],
      ["Alt + wheel", "scroll the lanes"], ["Middle drag", "scroll sideways"], ["+ −  ·  Shift+Z", "zoom · fit"], ["Esc", "cancel the drag / close"],
      ["Double-click a clip", "zoom to it"], ["Double-click a speaker name", "rename"],
    ];
    this.helpEl = h("div", { class: "mta-ed-help" }, h("b", {}, "Shortcuts"), ...rows.flatMap(([k, d]) => [h("span", {}, h("kbd", {}, k)), h("span", {}, d)]));
    this.root.append(this.helpEl);
  }

  onKey(e) {
    if (!this.isOpen) return;
    e.stopPropagation();                                           // ComfyUI never sees keys while the editor is open
    const tag = (e.target && e.target.tagName) || "";
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (typing) { if (e.key === "Escape") { e.target.blur(); this.root.focus(); e.preventDefault(); } return; }
    const code = e.code, ctrl = e.ctrlKey || e.metaKey;
    const done = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const s = this.seq;
    if (code === "Escape") {
      if (this.helpEl) this.toggleHelp();
      else if (s.drag || this.srcDrag) { s.cancelDrag(); this.cancelSrcDrag(); this.stopAutoPan(); this.refreshAll(); }
      else this.close();
      return done();
    }
    if (ctrl && code === "KeyZ") { if (e.shiftKey) this.redo(); else this.undo(); return done(); }
    if (ctrl && code === "KeyY") { this.redo(); return done(); }
    if (ctrl && code === "KeyB") { this.run(s.splitAtPlayhead()); return done(); }
    if (ctrl || (e.altKey && !(code === "ArrowLeft" || code === "ArrowRight"))) return;       // leave browser shortcuts alone
    switch (code) {
      case "Space": this.togglePlay(); return done();
      case "Home": this.seekTo(0, true); return done();
      case "End": this.seekTo(s.total(), true); return done();
      case "ArrowLeft": case "ArrowRight": {
        const dir = code === "ArrowLeft" ? -1 : 1;
        if (e.altKey) this.run(s.moveSelected(dir)); else this.seekTo(s.playhead + dir * (e.shiftKey ? 1 : 0.1), true);
        return done();
      }
      case "ArrowUp": case "ArrowDown": { const t = s.jumpCut(code === "ArrowUp" ? -1 : 1); if (t != null) this.seekTo(t, true); return done(); }
      case "Delete": case "Backspace": this.run(s.deleteSelected()); return done();
      case "KeyV": this.setTool("select"); return done();
      case "KeyB": this.setTool("blade"); return done();
      case "KeyS": this.run(s.splitAtPlayhead()); return done();
      case "KeyN": this.toggleSnap(); return done();
      case "Equal": case "NumpadAdd": this.zoom(1 / 1.4); return done();
      case "Minus": case "NumpadSubtract": this.zoom(1.4); return done();
      case "KeyZ": if (e.shiftKey) { s.fit(); this.refreshAll(); return done(); } break;
      case "F1": this.toggleHelp(); return done();
      case "Slash": if (e.shiftKey) { this.toggleHelp(); return done(); } break;
      default: break;
    }
  }
}
