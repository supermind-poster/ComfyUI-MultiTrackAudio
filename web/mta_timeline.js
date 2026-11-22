// ComfyUI extension: the timeline editor + dynamic outputs of the "Audio Timeline" node.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { Timeline, fmtTime, parseEdit, estimateSave } from "./lib/timeline.js";

const NODE_TYPE = "MTA_AudioTimeline";
const TOOLBAR_H = 96;
const FIXED_OUTPUTS = 3;        // timeline, segments, saved_paths; speaker_1.. follow
const MAX_SPEAKERS = 16;        // the Python side has this many lane outputs
const INPUT_SLOT = 1, OUTPUT_SLOT = 2;   // litegraph slot types
const MODE_TRACKS = "tracks of the file";
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

function el(tag, styles = {}, props = {}) {
  const e = document.createElement(tag);
  Object.assign(e.style, styles);
  Object.assign(e, props);
  return e;
}
async function getJSON(path, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
  const r = await api.fetchApi(`${path}?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText || "request failed");
  return j;
}
async function postJSON(path, body) {
  const r = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText || "request failed");
  return j;
}

function setup(node) {
  const W = (name) => (node.widgets || []).find((w) => w.name === name);
  const val = (name, d = "") => { const w = W(name); return w && w.value !== undefined && w.value !== null ? w.value : d; };
  const tl = new Timeline();
  tl.maxOutputs = MAX_SPEAKERS;
  node.mtaTimeline = tl;                  // handle for tests / debugging
  node.properties = node.properties || {};
  const st = { seq: 0, key: "", busy: false, audioCtx: null, play: null, buffers: new Map(), timers: {}, raf: 0,
               srcKey: "", srcInfo: null, undo: [], redo: [], last: "" };

  // ------------------------------------------------------------------ DOM
  const root = el("div", { display: "flex", flexDirection: "column", gap: "3px", width: "100%", boxSizing: "border-box" });
  const bar = el("div", { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px", minHeight: "54px", alignContent: "flex-start" });
  const mkBtn = (label, title, onClick) => {
    const b = el("button", {
      padding: "2px 8px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flex: "0 0 auto",
      background: "var(--comfy-input-bg, #2a2a2a)", color: "var(--input-text, #ddd)",
      border: "1px solid var(--border-color, #4a4a4a)", borderRadius: "4px",
    }, { textContent: label, title, type: "button" });
    b.addEventListener("click", (e) => { e.stopPropagation(); try { onClick(); } catch (err) { console.error(err); } });
    return b;
  };
  const btnUpload = mkBtn("Upload", "Upload an audio / video file into ComfyUI/input", () => fileInput.click());
  const btnAnalyze = mkBtn("Analyze speakers", "Detect who speaks when, in the kept sections", () => analyze());
  const btnClear = mkBtn("Clear", "Remove sections, speakers and clips", () => clearAll());
  const btnUndo = mkBtn("↶ Undo", "Undo the last edit (Ctrl+Z)", () => undo());
  const btnRedo = mkBtn("↷ Redo", "Redo (Ctrl+Shift+Z)", () => redo());
  const btnSplit = mkBtn("✂ Split", "Cut at the playhead: the selected clip, else the section under it", () => doSplit());
  const btnDelete = mkBtn("Delete", "Delete the selected clip or section (Delete key)", () => doDelete());
  const btnAddSpk = mkBtn("+ Speaker", "Add an empty speaker lane, then draw its clips by dragging in the lane", () => addSpeaker());
  const btnDelSpk = mkBtn("− Speaker", "Delete the selected speaker lane with its clips", () => delSpeaker());
  const btnPlay = mkBtn("▶ Play", "Play the selected lane (a track, or one speaker) through the sections, from the playhead", () => togglePlay());
  const btnFit = mkBtn("Fit", "Show everything", () => { tl.fit(); scheduleDetail(); redraw(); });
  bar.append(btnUpload, btnAnalyze, btnClear, btnUndo, btnRedo, btnSplit, btnDelete, btnAddSpk, btnDelSpk, btnPlay, btnFit);
  const lineStyle = { fontSize: "11px", color: "var(--descrip-text, #9a9a9a)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: "2px", minHeight: "14px" };
  const status = el("div", lineStyle);
  const info = el("div", lineStyle);
  const fileInput = el("input", { display: "none" }, { type: "file", accept: "audio/*,video/*,.mov,.mxf,.mka,.mkv,.wav,.flac,.m4a,.aif,.aiff,.opus" });
  const wrap = el("div", { position: "relative", width: "100%", userSelect: "none", touchAction: "none" });
  const canvas = el("canvas", { display: "block", width: "100%", borderRadius: "4px", outline: "none" }, { tabIndex: 0 });
  wrap.append(canvas);
  root.append(bar, status, info, wrap, fileInput);

  const widget = node.addDOMWidget("timeline", "mta_timeline", root, {
    getValue: () => "",
    setValue: () => {},
    getMinHeight: () => TOOLBAR_H + 8 + tl.desiredHeight(),
    margin: 4,
  });
  widget.serialize = false;                       // UI only: not part of widgets_values / the prompt
  if (widget.options) widget.options.serialize = false;
  const wi = node.widgets.indexOf(widget);        // show it right below the file selection widgets
  const after = node.widgets.indexOf(W("file_path_override"));
  if (wi > -1 && after > -1) { node.widgets.splice(wi, 1); node.widgets.splice(after + 1, 0, widget); }

  // ------------------------------------------------------------------ drawing
  const dpr = () => window.devicePixelRatio || 1;
  function resize() {
    const w = Math.max(200, Math.floor(wrap.clientWidth || tl.w));
    const h = tl.desiredHeight();
    tl.w = w; tl.h = h;
    canvas.style.height = `${h}px`;
    const d = dpr();
    if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(h * d)) {
      canvas.width = Math.round(w * d); canvas.height = Math.round(h * d);
    }
  }
  function paint() {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    resize();
    const d = dpr();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    try {
      const bg = getComputedStyle(root).getPropertyValue("--comfy-input-bg").trim();
      if (bg) tl.theme.bg = bg;
    } catch (e) { /* theme is optional */ }
    tl.draw(ctx);
  }
  function redraw() {
    if (st.raf) return;
    st.raf = requestAnimationFrame(() => { st.raf = 0; paint(); });
  }
  let ro = null;
  if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(() => redraw()); ro.observe(wrap); }

  const setStatus = (text, kind = "") => {
    status.textContent = text || "";
    status.style.color = kind === "error" ? "#ff8a80" : kind === "busy" ? "#ffd54f" : "var(--descrip-text, #9a9a9a)";
    status.title = text || "";
  };
  const markChanged = () => { try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) { /* ignore */ } };
  function fitNode() {
    resize();
    try {
      const need = node.computeSize ? node.computeSize() : null;
      if (need && node.size) {
        const w = Math.max(node.size[0], 600), h = Math.max(node.size[1], need[1]);
        if (w !== node.size[0] || h !== node.size[1]) node.setSize([w, h]);
      }
    } catch (e) { /* sizing is best effort */ }
    markChanged();
  }

  // ------------------------------------------------------------------ dynamic outputs
  // Outputs: timeline, segments, saved_paths, then one per lane (speaker, or the file's other tracks). Only as many lane
  // outputs exist as there are lanes on the timeline; a connected output is never removed. Python always has MAX_SPEAKERS.
  function connectedLaneSlots() {
    let m = 0;
    (node.outputs || []).forEach((o, i) => { if (i >= FIXED_OUTPUTS && o.links && o.links.length) m = Math.max(m, i - FIXED_OUTPUTS + 1); });
    return m;
  }
  function syncOutputs() {
    if (!node.outputs || node.outputs.length < FIXED_OUTPUTS) return;
    const n = tl.laneOutputCount();
    const want = clamp(Math.max(n, connectedLaneSlots(), n === 0 ? 2 : 1), 1, MAX_SPEAKERS);
    while (node.outputs.length - FIXED_OUTPUTS < want) node.addOutput(`speaker_${node.outputs.length - FIXED_OUTPUTS + 1}`, "AUDIO");
    while (node.outputs.length - FIXED_OUTPUTS > want) {
      const last = node.outputs[node.outputs.length - 1];
      if (last.links && last.links.length) break;          // never cut a connected output
      node.removeOutput(node.outputs.length - 1);
    }
    tl.outputLabels(node.outputs.length - FIXED_OUTPUTS).forEach((l, k) => { node.outputs[FIXED_OUTPUTS + k].label = l; });
    markChanged();
  }

  // ------------------------------------------------------------------ the edit state: widget <-> model, undo / redo
  const editJson = () => (tl.isEmptyEdit() ? "" : JSON.stringify(tl.toEdit()));
  function writeEdit() { const w = W("edit"); if (w) w.value = editJson(); }
  function updateButtons() {
    const sel = tl.sel;
    btnUndo.disabled = !st.undo.length;
    btnRedo.disabled = !st.redo.length;
    const detected = tl.mode === "detected";
    btnAddSpk.disabled = !detected;
    btnDelSpk.disabled = !(detected && tl.selLane && tl.selLane.kind === "speaker");
    btnDelete.disabled = !sel;
    btnSplit.disabled = false;
    for (const b of [btnUndo, btnRedo, btnAddSpk, btnDelSpk, btnDelete]) b.style.opacity = b.disabled ? "0.45" : "1";
  }
  function updateInfo() {
    const fmt = String(val("save_format", ""));
    if (!fmt || fmt.startsWith("none")) { info.textContent = ""; return; }
    const tr = tl.trackByIndex(tl.selTrack);
    const srcRate = (st.srcInfo && st.srcInfo.sample_rate) || (tr && tr.rate) || 48000;
    const rateSel = String(val("save_sample_rate", ""));
    const rate = /^\d+$/.test(rateSel) ? Number(rateSel) : srcRate;
    const c = (tr && tr.channels) || (st.srcInfo && st.srcInfo.channels) || 2;
    const keep = String(val("multichannel", "")).startsWith("keep");
    const ch = val("save_mono", false) ? 1 : (keep ? c : Math.min(c, c > 2 ? 1 : 2));
    const lanes = tl.mode === "tracks" ? Math.max(tl.tracks.length - 1, 0) : tl.speakers.length;
    const tracks = lanes + (val("save_with_timeline", true) ? 1 : 0);
    const e = estimateSave({ depth: val("save_bit_depth", "16"), rate, channels: ch, seconds: tl.programLength(), tracks });
    info.textContent = `Save ${fmt.slice(0, 3)}: ${val("save_bit_depth", "16") === "32f" ? "32-bit float" : e.bits + "-bit"} · ${rate / 1000} kHz · ${ch === 1 ? "mono" : ch === 2 ? "stereo" : ch + " ch"} ≈ ${Math.round(e.kbps)} kbps per track · ${tracks} track${tracks === 1 ? "" : "s"} ≈ ${e.megabytes < 10 ? e.megabytes.toFixed(1) : Math.round(e.megabytes)} MB`;
  }
  function afterEdit() {
    writeEdit(); syncOutputs(); updateInfo(); updateButtons(); fitNode(); redraw(); markChanged();
  }
  function commit() {                       // call after every finished edit
    const now = editJson();
    if (now !== st.last) {
      st.undo.push(st.last);
      if (st.undo.length > 80) st.undo.shift();
      st.redo.length = 0;
      st.last = now;
    }
    afterEdit();
  }
  function applyJson(js) { tl.fromEdit(parseEdit(js)); st.last = js; afterEdit(); }
  function undo() { if (!st.undo.length) return; stopPlay(); st.redo.push(st.last); applyJson(st.undo.pop()); }
  function redo() { if (!st.redo.length) return; stopPlay(); st.undo.push(st.last); applyJson(st.redo.pop()); }
  function loadEditFromWidget() {
    tl.fromEdit(parseEdit(val("edit", "")));
    st.last = editJson();
    st.undo = []; st.redo = [];
    afterEdit();
  }
  function resetEdit() { tl.clearEdit(); st.undo = []; st.redo = []; st.last = ""; afterEdit(); }

  function hook(name, fn) {
    const w = W(name);
    if (!w) return;
    const prev = w.callback;
    w.callback = function () {
      const r = prev ? prev.apply(this, arguments) : undefined;
      try { fn.apply(this, arguments); } catch (e) { console.error("[MultiTrackAudio]", e); }
      return r;
    };
  }

  // ------------------------------------------------------------------ source: a file (all its tracks) or audio from the audio_in socket
  const inputConnected = () => { const i = (node.inputs || []).find((x) => x.name === "audio_in"); return !!(i && i.link != null); };
  const srcArgs = (track) => (inputConnected()
    ? { key: st.srcKey }
    : { file: val("audio", ""), path: val("file_path_override", ""), track: track === undefined ? tl.selTrack : track });
  const hasSource = () => (inputConnected() ? !!st.srcKey : !!(val("audio", "") || String(val("file_path_override", "")).trim()));
  const syncMode = () => { tl.mode = val("speakers_from", "") === MODE_TRACKS ? "tracks" : "detected"; tl.selTrack = Number(val("track_index", 0)) || 0; };

  async function refresh(force) {
    const connected = inputConnected();
    const a = srcArgs(0);
    const id = `${connected ? "key" : "file"}|${a.key || ""}|${a.file || ""}|${a.path || ""}`;
    if (!force && id === st.key) return;
    st.key = id;
    const seq = ++st.seq;
    stopPlay();
    st.buffers.clear();
    tl.reset();
    syncMode();
    if (connected && !st.srcKey) {
      tl.message = "Connected audio: run the workflow once and it appears here";
      setStatus("Run the workflow once to load the connected audio", "busy");
      redraw();
      return;
    }
    if (!connected && !hasSource()) { tl.message = "Choose a file, or connect an audio node"; setStatus(""); redraw(); return; }
    tl.message = "Reading audio…";
    setStatus("Reading audio…", "busy");
    redraw();
    try {
      if (connected) {
        const pk = await getJSON("/mta/peaks", { key: st.srcKey, n: 1500 });
        if (seq !== st.seq) return;
        tl.setInfo({ duration: pk.duration, tracks: [{ index: 0, title: "Connected audio", channels: st.srcInfo?.channels || 0, sample_rate: st.srcInfo?.sample_rate || 0 }] });
        tl.tracks[0].coarse = { start: 0, end: pk.duration, min: pk.min, max: pk.max };
        setStatus(`Connected audio · ${fmtTime(pk.duration)}`);
      } else {
        const p = await getJSON("/mta/probe", { file: a.file, path: a.path });
        if (seq !== st.seq) return;
        tl.setInfo(p);
        syncMode();
        const n = p.tracks.length;
        setStatus(`${n} audio track${n > 1 ? "s" : ""} · ${fmtTime(p.duration)}`);
      }
      fitNode();
      updateInfo();
      redraw();
      if (!connected) await Promise.all(tl.tracks.map((t) => loadCoarse(t, seq)));
    } catch (e) {
      if (seq !== st.seq) return;
      tl.message = String(e.message || e);
      setStatus(tl.message, "error");
      redraw();
    }
  }
  async function loadCoarse(track, seq) {
    try {
      const r = await getJSON("/mta/peaks", { ...srcArgs(track.index), n: 1500 });
      if (seq !== st.seq) return;
      track.coarse = { start: 0, end: r.duration, min: r.min, max: r.max };
      tl.setDuration(r.duration);
      redraw();
    } catch (e) { track.error = String(e.message || e); redraw(); }
  }
  function scheduleDetail() { clearTimeout(st.timers.detail); st.timers.detail = setTimeout(loadDetail, 160); }
  async function loadDetail() {
    if (!tl.tracks.length || !(tl.duration > 0)) return;
    const seq = st.seq;
    const span = tl.viewEnd - tl.viewStart;
    if (span >= tl.duration * 0.8) { tl.tracks.forEach((t) => (t.detail = null)); redraw(); return; }
    const pad = span * 0.25;
    const start = Math.max(0, tl.viewStart - pad), end = Math.min(tl.duration, tl.viewEnd + pad);
    const n = clamp(Math.round((tl.w - 130) * ((end - start) / span) * 1.5), 300, 6000);
    await Promise.all(tl.tracks.map(async (t) => {
      const d = t.detail;
      if (d && d.start <= tl.viewStart + 1e-6 && d.end >= tl.viewEnd - 1e-6) return;
      try {
        const r = await getJSON("/mta/peaks", { ...srcArgs(t.index), start, end, n });
        if (seq !== st.seq) return;
        t.detail = { start: r.start, end: r.end, min: r.min, max: r.max };
      } catch (e) { /* keep the coarse waveform */ }
    }));
    redraw();
  }

  // ------------------------------------------------------------------ analysis
  async function analyze() {
    if (st.busy) return;
    if (!tl.tracks.length) { setStatus(inputConnected() ? "Run the workflow once first" : "Choose an audio file first", "error"); return; }
    stopPlay();
    const modeW = W("speakers_from");
    if (tl.mode === "tracks" && modeW) { modeW.value = "detected speakers"; syncMode(); }
    const body = {
      ...srcArgs(), sections: tl.hasSections() ? tl.sections.map((s) => [s.start, s.end]) : [],
      model: val("model", ""), num_speakers: val("num_speakers", 0), min_speakers: val("min_speakers", 0),
      max_speakers: val("max_speakers", 0), exclusive: val("exclusive", true), device: val("device", "auto"),
      keep_model_loaded: val("keep_model_loaded", false),
    };
    st.busy = true;
    btnAnalyze.disabled = true;
    const t0 = Date.now();
    const tick = () => setStatus(`Analyzing speakers… ${Math.round((Date.now() - t0) / 1000)} s (the first run loads the model)`, "busy");
    tick();
    st.timers.analyze = setInterval(tick, 1000);
    try {
      const res = await postJSON("/mta/diarize", body);
      tl.applyAnalysis(res.clips, res.speakers);
      commit();
      const n = res.speakers.length;
      setStatus(n > MAX_SPEAKERS ? `${n} speakers found; only the first ${MAX_SPEAKERS} get an output` : `${n} speaker${n === 1 ? "" : "s"} found · ${res.clips.length} clips. Edit them on the timeline`, n > MAX_SPEAKERS ? "error" : "");
    } catch (e) {
      setStatus(String(e.message || e), "error");
    } finally {
      clearInterval(st.timers.analyze);
      st.busy = false;
      btnAnalyze.disabled = false;
    }
  }

  // ------------------------------------------------------------------ editing actions
  function clearAll() { stopPlay(); tl.clearEdit(); commit(); setStatus("Everything cleared (Undo brings it back)"); }
  function doDelete() {
    stopPlay();
    const s = tl.sel;
    if (!s) return;
    if (s.type === "clip") tl.deleteClip(s.ref);
    else if (s.type === "section") tl.deleteSection(s.ref);
    commit();
  }
  function doSplit() {
    const t = tl.playhead;
    if (t == null) { setStatus("Click the timeline to put the playhead where you want to cut", "error"); return; }
    stopPlay();
    let ok = false;
    const lane = tl.selLane && tl.selLane.kind === "speaker" ? tl.speakers[tl.selLane.index] : null;
    const clip = tl.sel && tl.sel.type === "clip" ? tl.sel.ref : (lane ? tl.clipsOf(lane.id).find((c) => t > c.start && t < c.end) : null);
    if (clip) ok = !!tl.splitClipAt(clip, t);
    else ok = !!tl.splitSectionAt(t);
    if (ok) commit(); else setStatus("Nothing to cut here (too close to an edge, or outside the sections)", "error");
  }
  function addSpeaker() {
    const name = window.prompt("Name of the new speaker (you can draw its clips in the lane)", "");
    if (name === null) return;
    const sp = tl.addSpeaker(name);
    tl.selLane = { kind: "speaker", index: tl.speakerIndex(sp.id) };
    commit();
  }
  function delSpeaker() {
    const lane = tl.selLane && tl.selLane.kind === "speaker" ? tl.speakers[tl.selLane.index] : null;
    if (!lane) return;
    const n = tl.clipsOf(lane.id).length;
    if (n && !window.confirm(`Delete "${lane.name}" and its ${n} clip${n === 1 ? "" : "s"}?`)) return;
    stopPlay();
    tl.deleteSpeaker(lane.id);
    commit();
  }
  function renameSpeaker(index) {
    const sp = tl.speakers[index];
    if (!sp) return;
    const name = window.prompt(`Name for ${sp.id}`, sp.name);
    if (name === null) return;
    if (tl.renameSpeaker(sp.id, name)) commit();
  }

  // ------------------------------------------------------------------ upload
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    setStatus(`Uploading ${f.name}…`, "busy");
    try {
      const body = new FormData();
      body.append("image", f);
      body.append("type", "input");
      body.append("overwrite", "true");
      const r = await api.fetchApi("/upload/image", { method: "POST", body });
      if (!r.ok) throw new Error(`upload failed (${r.status})`);
      const j = await r.json();
      const name = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
      const aw = W("audio");
      if (aw) {
        if (Array.isArray(aw.options?.values) && !aw.options.values.includes(name)) aw.options.values.push(name);
        aw.value = name;
      }
      const ow = W("file_path_override");
      if (ow) ow.value = "";
      resetEdit();
      await refresh(true);
    } catch (e) { setStatus(String(e.message || e), "error"); }
  });

  // ------------------------------------------------------------------ playback (WebAudio, 16 kHz mono preview), through the sections
  function audioCtx() {
    if (!st.audioCtx) st.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return st.audioCtx;
  }
  async function getBuffer(track, lo, hi) {
    const a = srcArgs(track);
    const key = `${a.key || ""}|${a.file || ""}|${a.path || ""}|${track}|${lo.toFixed(2)}|${hi.toFixed(2)}`;
    if (st.buffers.has(key)) return st.buffers.get(key);
    const q = new URLSearchParams({ ...a, start: lo, end: hi }).toString();
    const r = await api.fetchApi(`/mta/wav?${q}`);
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "could not load audio"); }
    const buf = await audioCtx().decodeAudioData(await r.arrayBuffer());
    if (st.buffers.size >= 4) st.buffers.delete(st.buffers.keys().next().value);
    st.buffers.set(key, buf);
    return buf;
  }
  /** What to play: source pieces [a, b] placed at program time `at` (the sections in output order; for a speaker only its clips). */
  function playPlan(lane) {
    const pieces = [];
    let P = 0;
    for (const s of tl.effSections()) {
      if (lane.kind === "source") pieces.push({ a: s.start, b: s.end, at: P });
      else {
        const sp = tl.speakers[lane.index];
        for (const c of sp ? tl.clipsOf(sp.id) : []) {
          const a = Math.max(c.start, s.start), b = Math.min(c.end, s.end);
          if (b - a > 0.02) pieces.push({ a, b, at: P + (a - s.start) });
        }
      }
      P += s.end - s.start;
    }
    return { pieces, total: P };
  }
  async function togglePlay() {
    if (st.play) { stopPlay(); return; }
    if (!tl.tracks.length) return;
    const lane = tl.selLane || { kind: "source", index: tl.selTrack };
    const track = lane.kind === "source" ? lane.index : tl.selTrack;
    const { pieces, total } = playPlan(lane);
    if (!pieces.length) { setStatus("Nothing to play in this lane", "error"); return; }
    const fromProg = tl.playhead != null ? (tl.sourceToProgram(tl.playhead) ?? 0) : 0;
    setStatus("Loading audio…", "busy");
    try {
      const lo = Math.min(...pieces.map((p) => p.a)), hi = Math.max(...pieces.map((p) => p.b));
      const buf = await getBuffer(track, lo, hi);
      const ctx = audioCtx();
      await ctx.resume();
      const when0 = ctx.currentTime + 0.06;
      const sources = [];
      for (const p of pieces) {
        let { a, at } = p;
        const b = p.b;
        if (at + (b - a) <= fromProg + 0.01) continue;
        if (at < fromProg) { a += fromProg - at; at = fromProg; }
        const len = b - a;
        const s = ctx.createBufferSource();
        s.buffer = buf;
        const g = ctx.createGain();
        const t = when0 + (at - fromProg), f = Math.min(0.008, len / 3);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(1, t + f);
        g.gain.setValueAtTime(1, t + len - f);
        g.gain.linearRampToValueAtTime(0, t + len);
        s.connect(g); g.connect(ctx.destination);
        s.start(t, a - lo, len);
        sources.push(s);
      }
      st.play = { ctx, sources, when0, fromProg, total };
      btnPlay.textContent = "■ Stop";
      setStatus(lane.kind === "source" ? `Playing track ${track}` : `Playing ${tl.speakers[lane.index]?.name || "speaker"}`);
      const loop = () => {
        if (!st.play) return;
        const pos = st.play.fromProg + (ctx.currentTime - st.play.when0);
        if (pos >= st.play.total) { stopPlay(true); return; }
        const src = tl.programToSource(Math.max(pos, st.play.fromProg));
        if (src != null) {
          tl.playhead = src;
          if (src > tl.viewEnd || src < tl.viewStart) { const sp = tl.viewEnd - tl.viewStart; tl.setView(src - sp * 0.1, src + sp * 0.9); }
        }
        paint();
        st.play.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { setStatus(String(e.message || e), "error"); }
  }
  function stopPlay(finished = false) {
    const p = st.play;
    if (!p) return;
    st.play = null;
    cancelAnimationFrame(p.raf);
    for (const s of p.sources) { try { s.stop(); } catch (e) { /* already stopped */ } }
    btnPlay.textContent = "▶ Play";
    if (finished) setStatus("");
    redraw();
  }

  // ------------------------------------------------------------------ pointer interaction
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    const k = r.width > 0 ? tl.w / r.width : 1;          // the graph may be zoomed (CSS transform)
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };
  function selectLane(lane) {
    tl.selLane = { kind: lane.kind, index: lane.index };
    if (lane.kind === "source" && lane.index !== tl.selTrack) {
      tl.selTrack = lane.index;
      const w = W("track_index");
      if (w) w.value = lane.index;
      syncOutputs(); updateInfo();
    }
    if (st.play) stopPlay();
  }
  function handle(ev) {
    switch (ev.type) {
      case "edit": case "band": redraw(); break;
      case "view": scheduleDetail(); redraw(); break;
      case "commit": stopPlay(); commit(); break;
      case "select": updateButtons(); redraw(); break;
      case "click":
        tl.playhead = clamp(ev.t, 0, tl.duration);
        if (ev.hit.lane) selectLane(ev.hit.lane);
        updateButtons(); redraw();
        break;
      case "click-label": selectLane(ev.lane); updateButtons(); redraw(); break;
      default: break;
    }
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    try { canvas.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    const p = local(e);
    tl.pointerDown(p.x, p.y);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    e.preventDefault(); e.stopPropagation();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = local(e);
    const ev = tl.pointerMove(p.x, p.y);
    if (ev.type === "hover") { canvas.style.cursor = ev.cursor; return; }
    handle(ev);
    e.stopPropagation();
  });
  canvas.addEventListener("pointerup", (e) => {
    const p = local(e);
    const ev = tl.pointerUp(p.x, p.y);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    e.stopPropagation();
    handle(ev);
    updateButtons();
    redraw();
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault(); e.stopPropagation();
    const p = local(e);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      tl.panBySeconds((e.deltaX || e.deltaY) / Math.max(1, tl.w - 130) * (tl.viewEnd - tl.viewStart));
    } else tl.zoomAt(p.x, e.deltaY > 0 ? 1.25 : 0.8);
    scheduleDetail(); redraw();
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    const p = local(e);
    const h = tl.hit(p.x, p.y);
    if (h.type === "label" && h.lane.kind === "speaker") renameSpeaker(h.lane.index);
    else if (h.type === "lane" || h.type === "ruler" || h.type === "overview") { tl.fit(); scheduleDetail(); redraw(); }
  });
  canvas.addEventListener("keydown", (e) => {      // only while the timeline has focus; never reaches ComfyUI's own shortcuts
    const k = e.key;
    if (k === "Delete" || k === "Backspace") { doDelete(); }
    else if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z")) { if (e.shiftKey) redo(); else undo(); }
    else if ((e.ctrlKey || e.metaKey) && (k === "y" || k === "Y")) { redo(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  });

  // ------------------------------------------------------------------ node hooks
  hook("audio", () => { resetEdit(); refresh(true); });
  hook("file_path_override", () => { clearTimeout(st.timers.path); st.timers.path = setTimeout(() => { resetEdit(); refresh(true); }, 400); });
  hook("track_index", () => { syncMode(); syncOutputs(); updateInfo(); redraw(); });
  hook("speakers_from", () => { syncMode(); syncOutputs(); updateInfo(); updateButtons(); fitNode(); redraw(); });
  for (const n of ["save_format", "save_bit_depth", "save_sample_rate", "multichannel", "save_mono", "save_with_timeline"]) hook(n, () => updateInfo());

  const prevConn = node.onConnectionsChange;
  node.onConnectionsChange = function (type, index, connected) {
    const r = prevConn ? prevConn.apply(this, arguments) : undefined;
    try {
      if (type === INPUT_SLOT && node.inputs && node.inputs[index] && node.inputs[index].name === "audio_in") {
        if (!connected) { st.srcKey = ""; node.properties.mta_key = ""; }
        else if (!st.srcKey) st.srcKey = node.properties.mta_key || "";
        init();
      } else if (type === OUTPUT_SLOT) syncOutputs();
    } catch (e) { console.error("[MultiTrackAudio]", e); }
    return r;
  };
  const prevExec = node.onExecuted;
  node.onExecuted = function (msg) {
    if (prevExec) prevExec.apply(this, arguments);
    try {
      const raw = msg && msg.mta_source && msg.mta_source[0];
      if (raw) {
        const info = JSON.parse(raw);
        st.srcInfo = info;
        if (inputConnected() && info.key && info.key !== st.srcKey) {
          const changed = !!st.srcKey;                // a different audio than before: the old edit doesn't fit
          st.srcKey = info.key;
          node.properties.mta_key = info.key;
          if (changed) resetEdit();
          refresh(true);
        } else if (inputConnected() && !tl.tracks.length) refresh(true);
        updateInfo();
      }
      const ed = msg && msg.mta_edit && msg.mta_edit[0];
      if (ed && tl.isEmptyEdit()) { tl.fromEdit(parseEdit(ed)); commit(); }   // the run analysed it for us
    } catch (e) { console.error("[MultiTrackAudio]", e); }
  };
  const prevCfg = node.onConfigure;
  node.onConfigure = function () {
    const r = prevCfg ? prevCfg.apply(this, arguments) : undefined;
    node.properties = node.properties || {};
    st.srcKey = node.properties.mta_key || "";
    init();
    return r;
  };
  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    stopPlay();
    if (ro) ro.disconnect();
    Object.values(st.timers).forEach((t) => { clearTimeout(t); clearInterval(t); });
    try { st.audioCtx && st.audioCtx.close(); } catch (e) { /* ignore */ }
    if (prevRemoved) prevRemoved.apply(this, arguments);
  };

  function init() {
    clearTimeout(st.timers.init);
    st.timers.init = setTimeout(() => {
      syncMode();
      loadEditFromWidget();
      refresh(true);
    }, 0);
  }
  if (node.size) node.setSize([Math.max(node.size[0], 600), Math.max(node.size[1], 640)]);
  updateButtons();
  init();
}

app.registerExtension({
  name: "MultiTrackAudio.AudioTimeline",
  async nodeCreated(node) {
    if (node.comfyClass !== NODE_TYPE) return;
    try { setup(node); } catch (e) { console.error("[MultiTrackAudio] timeline setup failed", e); }
  },
});
