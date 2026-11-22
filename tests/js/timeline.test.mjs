// Run: node --test tests/js/timeline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Timeline, GUTTER, fmtTime, niceStep, parseEdit } from "../../web/lib/timeline.js";

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const mk = (duration = 100, tracks = 1) => {
  const tl = new Timeline();
  tl.w = 700; tl.h = 330;
  tl.setInfo({ duration, tracks: Array.from({ length: tracks }, (_, i) => ({ index: i, title: i ? `t${i}` : "Mix", channels: 2, sample_rate: 48000 })) });
  return tl;
};
const withSpeakers = (tl) => {
  tl.applyAnalysis([
    { start: 0, end: 10, speaker: "B" }, { start: 10, end: 20, speaker: "A" }, { start: 20, end: 30, speaker: "B" }], ["B", "A"]);
  return tl;
};
const y0 = (tl, i) => tl.laneRects()[i].y + 4;      // a y inside lane i
const lane = (tl, id) => tl.laneRects().find((r) => r.id === id);

test("helpers and edit-text parsing", () => {
  assert.equal(fmtTime(65.34), "1:05.3");
  assert.equal(niceStep(100, 10), 10);
  assert.deepEqual(parseEdit("garbage"), { sections: [], speakers: [], clips: [] });
  const e = parseEdit('{"sections":[[1,2],[3,3]],"speakers":[{"id":"A"}],"clips":[{"start":0,"end":1,"speaker":"A"},{"start":2,"end":2,"speaker":"A"}]}');
  assert.deepEqual(e.sections, [[1, 2]]);
  assert.deepEqual(e.speakers, [{ id: "A", name: "A" }]);
  assert.equal(e.clips.length, 1);
});

// ============================================================================================= sections
test("no sections = the whole source; the program length", () => {
  const tl = mk();
  assert.deepEqual(tl.effSections(), [{ start: 0, end: 100 }]);
  assert.equal(tl.hasSections(), false);
  assert.equal(tl.programLength(), 100);
  tl.materialize();
  assert.equal(tl.hasSections(), true);
});

test("section edges are walled in by the other sections and the file", () => {
  const tl = mk();
  tl.sections = [{ start: 10, end: 30 }, { start: 40, end: 60 }];
  const [a, b] = tl.sections;
  tl.setSectionEdge(a, "end", 55);                      // can't run into the next section (40)
  assert.equal(a.end, 40);
  tl.setSectionEdge(b, "start", 5);                     // can't run back into the previous one (40)
  assert.equal(b.start, 40);
  tl.setSectionEdge(a, "start", -5);
  assert.equal(a.start, 0);
  tl.setSectionEdge(a, "start", 39.99);                 // keeps a minimum length
  assert.ok(a.end - a.start >= 0.05 - 1e-9);
  tl.setSectionEdge(b, "end", 500);
  assert.equal(b.end, 100);
});

test("drawing the first section replaces the whole source; later ones are appended in free space", () => {
  const tl = mk();
  const s1 = tl.addSection(30, 20);
  assert.deepEqual(tl.sections, [{ start: 20, end: 30 }]);
  assert.equal(tl.programLength(), 10);
  assert.equal(tl.addSection(25, 40), null, "starting inside an existing section is refused");
  const s2 = tl.addSection(10, 50);                     // runs into section 1: clipped to the free gap before it
  assert.deepEqual([s2.start, s2.end], [10, 20]);
  const s3 = tl.addSection(60, 70);
  assert.deepEqual(tl.sections, [s1, s2, s3], "appended in the order they were made");
  assert.equal(tl.addSection(70, 70.01), null, "too short");
});

test("delete (the last one brings the whole source back), reorder, razor", () => {
  const tl = mk();
  tl.sections = [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }];
  const [a, b, c] = tl.sections;
  assert.equal(tl.moveSection(c, 0), true);
  assert.deepEqual(tl.sections, [c, a, b]);
  assert.equal(tl.moveSection(c, 0), false);
  assert.equal(tl.moveSection(b, 99), false, "already last");
  tl.sel = { type: "section", ref: a };
  assert.equal(tl.deleteSection(a), true);
  assert.equal(tl.sel, null);
  tl.deleteSection(b); tl.deleteSection(c);
  assert.equal(tl.hasSections(), false);
  assert.equal(tl.programLength(), 100);

  const t2 = mk();
  const right = t2.splitSectionAt(40);                  // splitting the implicit whole section materialises it
  assert.deepEqual(t2.sections.map((s) => [s.start, s.end]), [[0, 40], [40, 100]]);
  assert.equal(right, t2.sections[1]);
  assert.equal(t2.splitSectionAt(40.01), null, "too close to an edge");
  assert.equal(t2.programLength(), 100, "the razor changes nothing audibly");
});

test("source <-> program time follows the output order", () => {
  const tl = mk();
  tl.sections = [{ start: 60, end: 80 }, { start: 10, end: 20 }];
  approx(tl.programLength(), 30);
  approx(tl.sourceToProgram(65), 5);
  approx(tl.sourceToProgram(15), 25);
  assert.equal(tl.sourceToProgram(40), null);
  approx(tl.programToSource(5), 65);
  approx(tl.programToSource(25), 15);
  assert.equal(tl.sectionAt(70), tl.sections[0]);
});

// ============================================================================================= speakers and clips
test("speakers: analysis keeps existing names; manual speakers; rename; delete removes the clips too", () => {
  const tl = withSpeakers(mk());
  tl.renameSpeaker("A", "Anna");
  tl.applyAnalysis([{ start: 0, end: 5, speaker: "A" }, { start: 5, end: 9, speaker: "C" }], ["A", "C"]);
  assert.deepEqual(tl.speakers.map((s) => s.name), ["Anna", "C"]);
  const m = tl.addSpeaker("Narrator");
  assert.equal(m.id, "MANUAL_1");
  assert.equal(tl.addSpeaker("").name, "Speaker 4");
  assert.equal(tl.addSpeaker("x").id, "MANUAL_3");
  assert.equal(tl.renameSpeaker("MANUAL_1", "  "), false);
  tl.deleteSpeaker("A");
  assert.deepEqual(tl.clips.map((c) => c.speaker), ["C"]);
  assert.equal(tl.deleteSpeaker("nope"), false);
});

test("clips never overlap their own speaker; edges are clamped by neighbours", () => {
  const tl = withSpeakers(mk());                         // B: 0-10, 20-30 | A: 10-20
  assert.equal(tl.addClip("B", 5, 8), null, "starts inside an existing clip");
  const c = tl.addClip("B", 12, 40);                     // free gap is 10-20 -> hmm: starts at 12, B has 20-30 next
  assert.deepEqual([c.start, c.end], [12, 20]);
  const d = tl.addClip("B", 35, 33);                     // reversed -> normalised
  assert.deepEqual([d.start, d.end], [33, 35]);
  tl.setClipEdge(d, "start", 25);                        // can't run into 20-30
  assert.equal(d.start, 30);
  tl.setClipEdge(d, "end", 500);
  assert.equal(d.end, 100);
  tl.setClipEdge(d, "start", 99.99);
  assert.ok(d.end - d.start >= 0.05 - 1e-9);
  assert.equal(tl.addClip("NOPE", 50, 60), null);
  assert.equal(tl.addClip("A", 50, 50.01), null, "too short");
});

test("reassigning a clip overwrites the target speaker where they overlap", () => {
  const tl = mk();
  tl.applyAnalysis([{ start: 0, end: 20, speaker: "A" }, { start: 30, end: 40, speaker: "A" }, { start: 10, end: 14, speaker: "B" }], ["A", "B"]);
  const moved = tl.clips.find((c) => c.speaker === "B");
  assert.equal(tl.reassignClip(moved, "A"), true);       // 10-14 now belongs to A: A's 0-20 is split around it
  const a = tl.clipsOf("A").map((c) => [c.start, c.end]);
  assert.deepEqual(a, [[0, 10], [10, 14], [14, 20], [30, 40]]);
  assert.equal(tl.clipsOf("B").length, 0);
  assert.equal(tl.reassignClip(moved, "A"), false, "same speaker");
  // partial overlaps trim, full cover deletes
  const t2 = mk();
  t2.applyAnalysis([{ start: 0, end: 10, speaker: "A" }, { start: 12, end: 14, speaker: "A" }, { start: 8, end: 13, speaker: "B" }], ["A", "B"]);
  t2.reassignClip(t2.clips.find((c) => c.speaker === "B"), "A");
  assert.deepEqual(t2.clipsOf("A").map((c) => [c.start, c.end]), [[0, 8], [8, 13], [13, 14]]);
});

test("razor and delete for clips", () => {
  const tl = withSpeakers(mk());
  const c = tl.clips[0];                                 // B 0-10
  assert.equal(tl.splitClipAt(c, 0.01), null);
  const r = tl.splitClipAt(c, 4);
  assert.deepEqual([c.start, c.end, r.start, r.end, r.speaker], [0, 4, 4, 10, "B"]);
  tl.sel = { type: "clip", ref: r };
  assert.equal(tl.deleteClip(r), true);
  assert.equal(tl.sel, null);
  assert.equal(tl.deleteClip(r), false);
});

test("the edit state round-trips; a clip whose speaker has no lane gets one", () => {
  const tl = withSpeakers(mk());
  tl.renameSpeaker("A", "Anna");
  tl.sections = [{ start: 5.12345, end: 50 }];
  const e = tl.toEdit();
  assert.deepEqual(e.sections, [[5.123, 50]]);
  const t2 = mk();
  t2.fromEdit(JSON.parse(JSON.stringify(e)));
  assert.deepEqual(t2.toEdit(), e);
  t2.fromEdit({ clips: [{ start: 0, end: 1, speaker: "ZZ" }] });
  assert.deepEqual(t2.speakers, [{ id: "ZZ", name: "ZZ" }]);
  assert.equal(new Timeline().isEmptyEdit(), true);
  assert.equal(t2.isEmptyEdit(), false);
  t2.clearEdit();
  assert.equal(t2.isEmptyEdit(), true);
});

test("output labels / lane count follow the mode", () => {
  const tl = withSpeakers(mk(100, 3));
  tl.renameSpeaker("A", "Anna");
  assert.deepEqual(tl.outputLabels(4), ["1: B", "2: Anna", "speaker_3", "speaker_4"]);
  assert.equal(tl.laneOutputCount(), 2);
  tl.mode = "tracks"; tl.selTrack = 1;
  assert.deepEqual(tl.outputLabels(3), ["1: Mix", "2: t2", "speaker_3"]);   // the file's other tracks, in order
  assert.equal(tl.laneOutputCount(), 2);
  assert.equal(tl.lanes().every((l) => l.kind === "source"), true);
});

// ============================================================================================= hit testing + gestures
test("hit testing: section edges, clip edges, clips, empty lane, output blocks, labels", () => {
  const tl = withSpeakers(mk());
  tl.sections = [{ start: 10, end: 60 }, { start: 70, end: 90 }];
  assert.equal(tl.hit(tl.ov2x(10), 5).type, "sec-edge");
  assert.equal(tl.hit(tl.ov2x(40), 5).type, "overview");
  assert.equal(tl.hit(tl.plot().x0 + 40, 30).type, "out-block");
  assert.equal(tl.hit(tl.t2x(60), 24 + 18 + 8).type, "sec-edge");           // ruler row
  assert.equal(tl.hit(tl.t2x(40), 24 + 18 + 8).type, "ruler");
  const spkA = lane(tl, "A"), spkB = lane(tl, "B");
  assert.equal(tl.hit(10, spkB.y + 3).type, "label");
  const h = tl.hit(tl.t2x(25), spkB.y + 3);                                    // inside B's 20-30 clip
  assert.equal(h.type, "clip");
  assert.equal(tl.hit(tl.t2x(30) - 2, spkB.y + 3).type, "clip-edge");          // right edge of that clip
  assert.equal(tl.hit(tl.t2x(15), spkB.y + 3).type, "lane-empty");
  assert.equal(tl.hit(tl.t2x(60) + 2, spkA.y + 3).type, "sec-edge");           // section edge wins where no clip edge is
  assert.equal(tl.hit(tl.t2x(45), y0(tl, 0)).type, "lane");
  assert.equal(tl.hit(tl.t2x(45), 9999).type, "none");
});

test("gesture: dragging a section edge", () => {
  const tl = mk();
  tl.sections = [{ start: 10, end: 60 }];
  const y = y0(tl, 0);
  assert.equal(tl.pointerDown(tl.t2x(10), y).type, "sec-edge");
  assert.equal(tl.pointerMove(tl.t2x(25), y).type, "edit");
  approx(tl.sections[0].start, 25, 1e-6);
  assert.equal(tl.pointerUp(tl.t2x(25), y).type, "commit");
  // from the overview bar too
  tl.pointerDown(tl.ov2x(60), 5);
  tl.pointerMove(tl.ov2x(80), 5);
  approx(tl.sections[0].end, 80, 1e-6);
  tl.pointerUp(0, 5);
  // dragging the edge of the implicit whole-source section materialises it
  const t2 = mk();
  t2.pointerDown(t2.ov2x(0), 5); t2.pointerMove(t2.ov2x(30), 5); t2.pointerUp(0, 5);
  assert.deepEqual(t2.sections.map((s) => [Math.round(s.start), s.end]), [[30, 100]]);
});

test("gesture: drawing sections on the ruler and a click on the ruler", () => {
  const tl = mk();
  const ry = 24 + 18 + 6;
  tl.pointerDown(tl.t2x(20), ry); assert.equal(tl.pointerMove(tl.t2x(35), ry).type, "band");
  assert.equal(tl.pointerUp(tl.t2x(35), ry).type, "commit");
  approx(tl.sections[0].start, 20, 1e-6); approx(tl.sections[0].end, 35, 1e-6);   // replaced the whole source
  tl.pointerDown(tl.t2x(50), ry); tl.pointerMove(tl.t2x(70), ry); tl.pointerUp(tl.t2x(70), ry);
  assert.equal(tl.sections.length, 2);
  assert.equal(tl.sel.type, "section");
  tl.pointerDown(tl.t2x(40), ry);                                              // a plain click only sets the playhead
  const up = tl.pointerUp(tl.t2x(40), ry);
  assert.equal(up.type, "click"); approx(up.t, 40, 1e-6);
});

test("gesture: reordering sections by dragging their blocks in the output strip", () => {
  const tl = mk();
  tl.sections = [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }];
  const [a, b, c] = tl.sections;
  const y = 24 + 8;
  const blocks = tl.outBlocks();
  tl.pointerDown(blocks[2].x + 5, y);
  tl.pointerMove(blocks[0].x + 2, y);                    // drag the last block over the first one
  assert.deepEqual(tl.sections, [c, a, b]);
  assert.equal(tl.pointerUp(blocks[0].x + 2, y).type, "commit");
  assert.equal(tl.sel.ref, c);
  tl.pointerDown(tl.outBlocks()[1].x + 5, y);            // click selects
  assert.equal(tl.pointerUp(0, y).type, "select");
  assert.equal(tl.sel.ref, a);
  approx(tl.programLength(), 30);
});

test("gesture: clips - draw, trim, select, move to another speaker", () => {
  const tl = withSpeakers(mk());
  tl.addSpeaker("Narrator");                             // MANUAL_1, an empty lane
  const man = lane(tl, "MANUAL_1");
  // draw a new clip in the empty lane
  tl.pointerDown(tl.t2x(40), man.y + 4);
  assert.equal(tl.pointerMove(tl.t2x(55), man.y + 4).type, "band");
  assert.equal(tl.pointerUp(tl.t2x(55), man.y + 4).type, "commit");
  const c = tl.clipsOf("MANUAL_1")[0];
  approx(c.start, 40, 1e-6); approx(c.end, 55, 1e-6);
  assert.equal(tl.sel.ref, c);
  // trim its end
  tl.pointerDown(tl.t2x(55), man.y + 4);
  tl.pointerMove(tl.t2x(48), man.y + 4);
  tl.pointerUp(tl.t2x(48), man.y + 4);
  approx(c.end, 48, 1e-6);
  // a click on a clip selects it and reports a click
  tl.pointerDown(tl.t2x(44), man.y + 4);
  assert.equal(tl.pointerUp(tl.t2x(44), man.y + 4).type, "click");
  // drag it onto lane B: it is reassigned
  tl.pointerDown(tl.t2x(44), man.y + 4);
  tl.pointerMove(tl.t2x(44), lane(tl, "B").y + 4);
  assert.equal(tl.dropLane.id, "B");
  assert.equal(tl.pointerUp(tl.t2x(44), lane(tl, "B").y + 4).type, "commit");
  assert.equal(c.speaker, "B");
  assert.equal(tl.dropLane, null);
  // dragging horizontally inside the same lane changes nothing (the audio is not moved)
  tl.pointerDown(tl.t2x(44), lane(tl, "B").y + 4);
  tl.pointerMove(tl.t2x(70), lane(tl, "B").y + 4);
  assert.equal(tl.pointerUp(tl.t2x(70), lane(tl, "B").y + 4).type, "none");
  approx(c.start, 40, 1e-6);
});

test("gesture: a source lane pans, the overview recentres, a label click is reported", () => {
  const tl = mk();
  tl.setView(20, 40);
  const y = y0(tl, 0);
  tl.pointerDown(tl.t2x(30), y);
  assert.equal(tl.pointerMove(tl.t2x(30) + 100, y).type, "view");
  assert.ok(tl.viewStart < 20);
  assert.equal(tl.pointerUp(0, y).type, "none");
  tl.setView(0, 10);
  tl.pointerDown(tl.ov2x(60), 5);
  assert.equal(tl.pointerMove(tl.ov2x(60), 5).type, "view");
  approx((tl.viewStart + tl.viewEnd) / 2, 60, 1e-6);
  tl.pointerUp(0, 5);
  tl.pointerDown(30, y);
  assert.equal(tl.pointerUp(30, y).type, "click-label");
  assert.equal(tl.pointerMove(10, 10).type, "hover");
});

test("zoom keeps the time under the cursor fixed and respects bounds", () => {
  const tl = mk();
  const x = GUTTER + 200;
  const before = tl.x2t(x);
  tl.zoomAt(x, 0.5);
  approx(tl.x2t(x), before, 1e-6);
  for (let i = 0; i < 40; i++) tl.zoomAt(x, 0.5);
  assert.ok(tl.viewEnd - tl.viewStart >= 0.02 - 1e-9);
  for (let i = 0; i < 60; i++) tl.zoomAt(x, 2);
  assert.deepEqual([tl.viewStart, tl.viewEnd], [0, 100]);
});

test("lanes: all file tracks, then speakers; layout fits the canvas", () => {
  const tl = withSpeakers(mk(100, 2));
  assert.deepEqual(tl.lanes().map((l) => l.kind), ["source", "source", "speaker", "speaker"]);
  tl.h = tl.desiredHeight();
  const r = tl.laneRects();
  assert.ok(r.every((x, i) => i === 0 || x.y > r[i - 1].y));
  assert.ok(r.at(-1).y + r.at(-1).h <= tl.h && tl.desiredHeight() <= 480);
  tl.reset();
  assert.equal(tl.lanes().filter((l) => l.kind === "source").length, 0);
});

test("draw() runs in every state against a recording context", () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === "measureText" ? () => ({ width: 10 }) : (...a) => { calls.push(k); }), set: () => true });
  const tl = withSpeakers(mk(100, 2));
  tl.tracks.forEach((t) => (t.coarse = { start: 0, end: 100, min: Array(300).fill(-40), max: Array(300).fill(60) }));
  tl.sections = [{ start: 60, end: 80 }, { start: 10, end: 30 }];
  tl.sel = { type: "section", ref: tl.sections[0] };
  tl.playhead = 33;
  tl.band = { kind: "section", a: 1, b: 5 };
  tl.draw(ctx);
  tl.band = { kind: "clip", a: 1, b: 5, lane: lane(tl, "A") };
  tl.sel = { type: "clip", ref: tl.clips[0] };
  tl.dropLane = lane(tl, "A");
  tl.draw(ctx);
  tl.mode = "tracks"; tl.draw(ctx);
  tl.reset(); tl.clearEdit(); tl.draw(ctx);
  assert.ok(calls.includes("fillRect"));
});
