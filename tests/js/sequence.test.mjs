// Run: node --test tests/js/sequence.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Timeline } from "../../web/lib/timeline.js";
import { SequenceView, HEADER_W, fmtTC, fmtPrecise, parseTime } from "../../web/lib/sequence.js";
import { SourceView } from "../../web/lib/source.js";
import { PeakCache } from "../../web/lib/peaks.js";

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const mk = (duration = 100) => {
  const tl = new Timeline();
  tl.setInfo({ duration, tracks: [{ index: 0, title: "Mix", channels: 2, sample_rate: 48000 }] });
  const v = new SequenceView(tl, null);
  v.w = 1168; v.h = 400;                       // plot = 1000 px wide
  v.fit();
  return { tl, v };
};
const laneY = (v, i) => v.laneRects()[i].y + 10;
const rec = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 10 }) : () => {}), set: (t, k, val) => { t[k] = val; return true; } });

test("time helpers", () => {
  assert.equal(fmtTC(65.34, 0.1), "1:05.3");
  assert.equal(fmtTC(59.96, 0.1), "1:00.0");
  assert.equal(fmtTC(3725, 1), "1:02:05");
  assert.equal(fmtPrecise(1.2345), "0:01.235");
  assert.equal(parseTime("1:02.5"), 62.5);
  assert.equal(parseTime("12,5"), 12.5);
  assert.ok(Number.isNaN(parseTime("abc")));
});

test("model: whole file is canonical, layout, gaps, insert", () => {
  const { tl } = mk();
  tl.materialize();
  assert.equal(tl.isEmptyEdit(), true, "one section covering the file = nothing cut");
  tl.sections = [{ start: 10, end: 20 }, { start: 50, end: 70 }];
  assert.deepEqual(tl.programLayout().map((e) => [e.p0, e.p1]), [[0, 10], [10, 30]]);
  assert.deepEqual(tl.freeGaps(), [{ start: 0, end: 10 }, { start: 20, end: 50 }, { start: 70, end: 100 }]);
  assert.equal(tl.insertSection(15, 30, 1), null, "overlaps a used part");
  const s = tl.insertSection(25, 30, 1);
  assert.deepEqual(tl.sections.map((x) => x.start), [10, 25, 50]);
  assert.equal(tl.entryAt(12).sec, s === null ? null : tl.sections[1]);
});

test("model: pieces of speaker clips follow the sequence order", () => {
  const { tl } = mk();
  tl.sections = [{ start: 60, end: 80 }, { start: 10, end: 30 }];
  tl.applyAnalysis([{ start: 12, end: 20, speaker: "A" }, { start: 70, end: 75, speaker: "A" }], ["A"]);
  const p = tl.piecesOf("A");
  assert.deepEqual(p.map((x) => [x.p0, x.p1]), [[10, 15], [22, 30]]);
});

test("ripple trim moves what follows; drag edge in output time", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 0, end: 40 }, { start: 50, end: 90 }];
  v.fit();
  const y = laneY(v, 0);
  const xe = v.t2x(40);
  assert.equal(v.pointerDown(xe - 2, y).hit.type, "sec-edge");
  v.pointerMove(xe - 2 - 100, y);               // 100 px left = shorter
  const dt = 100 / v.pxPerSec();
  approx(tl.sections[0].end, 40 - dt, 1e-3);
  approx(tl.programLength(), 80 - dt, 1e-3);    // the second clip moved up
  assert.equal(v.pointerUp(0, y).type, "commit");
  // the walls: the first clip can't run into the second one's source
  v.pointerDown(v.t2x(tl.sections[0].end), y);
  v.pointerMove(v.w, y);
  assert.ok(tl.sections[0].end <= 50 + 1e-9);
});

test("at a join the pointer picks the clip it is inside", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 0, end: 40 }, { start: 50, end: 90 }];
  v.fit();
  const x = v.t2x(40), y = laneY(v, 0);
  const l = v.hit(x - 2, y), r = v.hit(x + 2, y);
  assert.deepEqual([l.type, l.side, l.entry.i], ["sec-edge", "end", 0]);
  assert.deepEqual([r.type, r.side, r.entry.i], ["sec-edge", "start", 1]);
});

test("re-order: the others make room, drop commits the new order", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 0, end: 20 }, { start: 30, end: 50 }, { start: 60, end: 80 }];
  const [a, b, c] = tl.sections;
  v.fit();
  const y = laneY(v, 0);
  const x0 = v.t2x(10);                          // inside A
  assert.equal(v.pointerDown(x0, y).hit.type, "section");
  const x1 = v.t2x(55);                          // drag A to the middle of C's slot
  assert.equal(v.pointerMove(x1, y).type, "band");
  assert.deepEqual(v.preview.layout.map((e) => e.sec), [b, c, a], "preview shows A after C");
  assert.deepEqual(tl.sections, [a, b, c], "the model is untouched until the drop");
  const up = v.pointerUp(x1, y);
  assert.equal(up.type, "commit");
  assert.deepEqual(tl.sections, [b, c, a]);
  assert.equal(v.preview, null);
});

test("a click only selects and seeks; a tiny drag is not a re-order", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 0, end: 20 }, { start: 30, end: 50 }];
  v.fit();
  const y = laneY(v, 0), x = v.t2x(25);
  v.pointerDown(x, y);
  const ev = v.pointerUp(x + 1, y);
  assert.equal(ev.type, "click");
  assert.equal(tl.sel.ref, tl.sections[1]);
  approx(v.playhead, 25, 0.1);
});

test("Esc during a trim restores the edit", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 0, end: 40 }, { start: 50, end: 90 }];
  v.fit();
  const y = laneY(v, 0);
  v.pointerDown(v.t2x(40) - 2, y);
  v.pointerMove(v.t2x(40) - 120, y);
  assert.ok(tl.sections[0].end < 40);
  v.cancelDrag();
  approx(tl.sections[0].end, 40);
});

test("blade cuts the clip under the pointer; split at playhead; delete ripples; the last clip stays", () => {
  const { tl, v } = mk();
  tl.materialize();
  v.tool = "blade";
  v.snap = false;
  const y = laneY(v, 0), x = v.t2x(30);
  v.pointerMove(x, y);
  assert.ok(v.blade);
  v.pointerDown(x, y);
  assert.equal(v.pointerUp(x, y).type, "commit");
  assert.deepEqual(tl.sections.map((s) => [Math.round(s.start), Math.round(s.end)]), [[0, 30], [30, 100]]);
  v.tool = "select";
  v.playhead = 60;
  assert.equal(v.splitAtPlayhead().ok, true);
  assert.equal(tl.sections.length, 3);
  assert.equal(v.splitAtPlayhead().ok, false, "already a cut there");
  tl.sel = { type: "section", ref: tl.sections[1] };    // 30..60
  assert.equal(v.deleteSelected().ok, true);
  assert.deepEqual(tl.programLayout().map((e) => [Math.round(e.p0), Math.round(e.p1)]), [[0, 30], [30, 70]]);
  tl.sections = [tl.sections[0]];
  tl.sel = { type: "section", ref: tl.sections[0] };
  assert.equal(v.deleteSelected().ok, false);
});

test("move a section by keyboard; jump between cuts", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }];
  const [a, b, c] = tl.sections;
  tl.sel = { type: "section", ref: c };
  assert.equal(v.moveSelected(-1).ok, true);
  assert.deepEqual(tl.sections, [a, c, b]);
  assert.equal(v.moveSelected(1).ok, true);
  assert.equal(v.moveSelected(1).ok, false);
  v.playhead = 5;
  assert.equal(v.jumpCut(1), 10);
  assert.equal(v.jumpCut(-1), 0);
});

test("speaker clips: draw in an empty lane, trim, move, hand over", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 0, end: 50 }, { start: 60, end: 100 }];
  tl.applyAnalysis([{ start: 5, end: 15, speaker: "A" }], ["A", "B"]);
  v.fit(); v.snap = false;
  const ya = laneY(v, 1), yb = laneY(v, 2);
  // draw a clip for B
  v.pointerDown(v.t2x(20), yb);
  v.pointerMove(v.t2x(30), yb);
  assert.ok(v.band);
  assert.equal(v.pointerUp(v.t2x(30), yb).type, "commit");
  const cb = tl.clipsOf("B")[0];
  approx(cb.start, 20, 0.2); approx(cb.end, 30, 0.2);
  // trim A's clip end
  const ca = tl.clipsOf("A")[0];
  assert.equal(v.pointerDown(v.t2x(15) - 2, ya).hit.type, "clip-edge");
  v.pointerMove(v.t2x(18), ya);
  approx(ca.end, 18, 0.2);
  v.pointerUp(v.t2x(18), ya);
  // move A's clip right by 10 s and give it to B in one gesture
  v.pointerDown(v.t2x(10), ya);
  v.pointerMove(v.t2x(10) + 10 * v.pxPerSec(), yb);
  assert.equal(v.ghost.lane.id, "B");
  assert.equal(v.pointerUp(v.t2x(20), yb).type, "commit");
  assert.equal(tl.clipsOf("A").length, 0);
  assert.ok(tl.clipsOf("B").some((c) => Math.abs(c.start - 15) < 0.3));
});

test("a speaker clip can't be dragged out of its clip's section", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 0, end: 20 }, { start: 60, end: 100 }];
  tl.applyAnalysis([{ start: 5, end: 10, speaker: "A" }], ["A"]);
  v.fit(); v.snap = false;
  const y = laneY(v, 1);
  v.pointerDown(v.t2x(7), y);
  v.pointerMove(v.t2x(7) + 600, y);
  assert.ok(v.ghost.dt <= 10 + 1e-6);
  v.pointerUp(0, y);
  assert.ok(tl.clips[0].end <= 20 + 1e-6);
});

test("snapping pulls to cuts and the playhead; Alt turns it off", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 0, end: 40 }, { start: 50, end: 90 }];
  v.fit();
  v.playhead = 40;
  const near = 40 + 3 / v.pxPerSec();
  assert.equal(v.snapP(near), 40);
  assert.ok(v.guide != null);
  assert.equal(v.snapP(near, null, true), near);
  v.snap = false;
  assert.equal(v.snapP(near), near);
});

test("zoom, pan and view limits", () => {
  const { v } = mk();
  v.zoomAt(HEADER_W + 500, 0.5);
  assert.ok(v.vEnd - v.vStart < 60);
  v.panBySeconds(-1000);
  assert.equal(v.vStart, 0);
  v.zoomAt(HEADER_W, 1e-9);
  assert.ok(v.vEnd - v.vStart >= 0.02 - 1e-9);
  v.fit();
  assert.ok(v.vEnd > 100);
});

test("source viewer: marks live in cut-away parts only; drop index", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 10, end: 40 }, { start: 60, end: 90 }];
  const s = new SourceView(tl, null);
  s.w = 1168; s.h = 130; s.fit();
  assert.equal(s.hit(s.t2x(20), 60).type, "used");
  assert.equal(s.hit(s.t2x(50), 60).type, "gap");
  s.pointerDown(s.t2x(45), 60);
  s.pointerMove(s.t2x(80), 60);                 // runs on past the gap: clamped to it
  s.pointerUp();
  assert.deepEqual(s.getMark(), { a: 45, b: 60 });
  tl.sections.push({ start: 50, end: 55 });
  s.validate();
  assert.equal(s.getMark(), null, "the mark now overlaps a used part");
  s.pointerDown(s.t2x(95), 60); s.pointerUp();   // a click marks the whole gap
  assert.deepEqual(s.getMark(), { a: 90, b: 100 });
  const t2 = mk();
  t2.tl.sections = [{ start: 0, end: 20 }, { start: 30, end: 50 }];
  t2.v.fit();
  assert.deepEqual(t2.v.insertPointAt(t2.v.t2x(25)), { index: 1, t: 20 }, "nearest cut");
  assert.deepEqual(t2.v.insertPointAt(t2.v.t2x(39)), { index: 2, t: 40 }, "the end of the sequence");
  assert.equal(t2.v.insertPointAt(t2.v.t2x(1)).index, 0);
});

test("drawing works with a recording context (no exceptions) in every state", () => {
  const { tl, v } = mk();
  tl.setInfo({ duration: 100, tracks: [{ index: 0, title: "Mix", channels: 2, sample_rate: 48000 }, { index: 1, title: "x", channels: 1, sample_rate: 16000 }] });
  tl.sections = [{ start: 0, end: 20 }, { start: 30, end: 50 }];
  tl.applyAnalysis([{ start: 2, end: 8, speaker: "A" }], ["A"]);
  const ctx = rec();
  v.draw(ctx);
  v.tool = "blade"; v.blade = { t: 5, lane: v.laneRects()[0] }; v.draw(ctx);
  v.pointerDown(v.t2x(10), laneY(v, 0)); v.pointerMove(v.t2x(40), laneY(v, 0)); v.draw(ctx);
  const s = new SourceView(tl, null); s.w = 1168; s.h = 130; s.fit(); s.draw(ctx);
});

test("peak cache: coarse when zoomed out, one detail request when zoomed in, de-duplicated", async () => {
  const calls = [];
  const pc = new PeakCache(async (tr, a, b, n) => { calls.push([tr, a, b, n]); return { start: a, end: b, min: new Array(n).fill(-5), max: new Array(n).fill(5) }; });
  pc.delay = 0;
  pc.setCoarse(0, { start: 0, end: 100, min: new Array(1500).fill(-1), max: new Array(1500).fill(1) });
  assert.equal(pc.get(0, 0, 100, 1000).max.length, 1500, "coarse is sharp enough");
  const first = pc.get(0, 10, 12, 1000);
  assert.equal(first.max.length, 1500, "answers at once with the coarse copy");
  pc.get(0, 10, 12, 1000);
  await pc.flush();
  assert.equal(calls.length, 1, "asked once");
  const d = pc.get(0, 10, 12, 1000);
  assert.ok(d.max.length > 1500 || d.end - d.start < 100, "now the detail piece");
  pc.pause(); pc.get(0, 70, 71, 1000);
  await pc.flush();
  assert.equal(calls.length, 1, "nothing is fetched while paused");
  pc.reset();
  assert.equal(pc.get(0, 0, 1, 100), null);
});

test("dragging a section down copies it to a speaker; below the lanes it makes a new speaker", () => {
  const { tl, v } = mk();
  tl.sections = [{ start: 10, end: 30 }, { start: 50, end: 80 }];
  tl.applyAnalysis([{ start: 12, end: 20, speaker: "A" }, { start: 25, end: 29, speaker: "A" }], ["A"]);
  v.fit(); v.snap = false;
  const rects = v.laneRects();
  const x = v.t2x(10);                                    // inside the first clip (program 0..20), source lane
  const down = (yEnd) => { v.pointerDown(x, rects[0].y + 10); v.pointerMove(x + 3, yEnd); };
  // onto A's lane: A gets one clip exactly covering the section (its two clips there are replaced)
  down(rects[1].y + 10);
  assert.equal(v.spkDrop.lane.id, "A");
  assert.deepEqual(tl.sections.map((s) => s.start), [10, 50], "nothing is re-ordered");
  assert.equal(v.pointerUp(x, rects[1].y + 10).type, "commit");
  assert.deepEqual(tl.clipsOf("A").map((c) => [c.start, c.end]), [[10, 30]]);
  assert.equal(tl.sections.length, 2, "the section stays");
  // below the last lane: a new speaker with the default name
  down(rects[1].y + rects[1].h + 20);
  assert.equal(v.spkDrop.lane, null);
  const ev = v.pointerUp(x, rects[1].y + rects[1].h + 20);
  assert.equal(ev.type, "commit");
  assert.deepEqual(tl.speakers.map((s) => s.name), ["A", "Speaker 2"]);
  assert.deepEqual(tl.clipsOf("MANUAL_1").map((c) => [c.start, c.end]), [[10, 30]]);
  // with no speakers at all the empty area below the audio lane is the target
  const t2 = mk();
  t2.tl.materialize(); t2.v.fit();
  const r0 = t2.v.laneRects()[0];
  t2.v.pointerDown(t2.v.t2x(30), r0.y + 10);
  t2.v.pointerMove(t2.v.t2x(30) + 2, r0.y + r0.h + 15);
  assert.equal(t2.v.pointerUp(0, 0).type, "commit");
  assert.deepEqual(t2.tl.speakers.map((s) => s.name), ["Speaker 1"]);
  assert.deepEqual(t2.tl.clipsOf("MANUAL_1").map((c) => [c.start, c.end]), [[0, 100]]);
  // dragging back up is a normal re-order again; tracks mode never copies
  const t3 = mk();
  t3.tl.sections = [{ start: 0, end: 20 }, { start: 30, end: 50 }]; t3.v.fit();
  const q = t3.v.laneRects()[0];
  t3.v.pointerDown(t3.v.t2x(10), q.y + 10);
  t3.v.pointerMove(t3.v.t2x(10), q.y + q.h + 20); assert.ok(t3.v.spkDrop);
  t3.v.pointerMove(t3.v.t2x(35), q.y + 10); assert.equal(t3.v.spkDrop, null); assert.ok(t3.v.preview);
  t3.v.cancelDrag();
  t3.tl.mode = "tracks";
  t3.v.pointerDown(t3.v.t2x(10), q.y + 10); t3.v.pointerMove(t3.v.t2x(10), q.y + q.h + 20);
  assert.equal(t3.v.spkDrop, null);
});
