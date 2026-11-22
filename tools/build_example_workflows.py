#!/usr/bin/env python3
"""Regenerate example_workflows/*.json.

The workflows are built from the real node definitions (INPUT_TYPES / RETURN_TYPES), so slot indices and
widgets_values can't drift from the code. Run after changing a node's inputs:

    python tools/build_example_workflows.py
"""
from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from loadpkg import ROOT, load_package  # noqa: E402

OUT = ROOT / "example_workflows"
NODES = load_package().NODE_CLASS_MAPPINGS

# Built-in ComfyUI nodes used for previews: (inputs, outputs). Widgets of these are UI-only.
BUILTIN = {
    "PreviewAudio": ([("audio", "AUDIO")], [("audio", "AUDIO")]),
    "PreviewAny": ([("source", "*")], [("STRING", "STRING")]),
    "MarkdownNote": ([], []),
    "LoadAudio": ([], [("AUDIO", "AUDIO")]),
}
BUILTIN_WIDGETS = {"LoadAudio": [("audio", "COMBO", True, "example.wav", False)]}
SCALARS = ("INT", "FLOAT", "STRING", "BOOLEAN")


def describe_inputs(type_):
    """[(name, type, is_widget, default, multiline)] in the order the frontend creates them."""
    if type_ in BUILTIN_WIDGETS:
        return list(BUILTIN_WIDGETS[type_])
    if type_ in BUILTIN:
        return [(n, t, False, None, False) for n, t in BUILTIN[type_][0]]
    it = NODES[type_].INPUT_TYPES()
    out = []
    for section in ("required", "optional"):
        for name, spec in it.get(section, {}).items():
            typ, opts = spec[0], (spec[1] if len(spec) > 1 else {})
            if isinstance(typ, (list, tuple)):  # combo
                default = opts.get("default", typ[0] if typ else "")
                out.append((name, "COMBO", True, default, False))
            elif typ in SCALARS:
                default = opts.get("default", "" if typ == "STRING" else 0)
                out.append((name, typ, True, default, bool(opts.get("multiline"))))
            else:
                out.append((name, typ, False, None, False))
    return out


def describe_outputs(type_):
    if type_ in BUILTIN:
        return BUILTIN[type_][1]
    cls = NODES[type_]
    return list(zip(getattr(cls, "RETURN_NAMES", cls.RETURN_TYPES), cls.RETURN_TYPES))


class Graph:
    def __init__(self, name):
        self.name, self.nodes, self.links = name, [], []
        self.next_node = self.next_link = 1

    def add(self, type_, pos, values=None, title=None, size=None, outputs=None):
        """outputs: keep only the first N outputs (the node's speaker outputs are added/removed by the UI)."""
        values = dict(values or {})
        ins, outs = describe_inputs(type_), describe_outputs(type_)
        if outputs:
            outs = outs[:outputs]
        widgets = [i for i in ins if i[2]]
        unknown = set(values) - {w[0] for w in widgets}
        assert not unknown, f"{type_}: unknown widget(s) {unknown}"
        wvals = []
        for name, _t, _w, default, _m in widgets:
            wvals.append(values.get(name, default))
        n_extra = sum(80 for w in widgets if w[4])
        height = 46 + 22 * max(len([i for i in ins if not i[2]]), len(outs)) + 28 * len(widgets) + n_extra
        node = {
            "id": self.next_node, "type": type_, "pos": list(pos),
            "size": list(size or (380, max(height, 90))),
            "flags": {}, "order": 0, "mode": 0,
            "inputs": [dict({"name": n, "localized_name": n, "type": t, "link": None},
                            **({"widget": {"name": n}} if w else {})) for n, t, w, _d, _m in ins],
            "outputs": [{"name": n, "localized_name": n, "type": t, "links": None, "slot_index": i}
                        for i, (n, t) in enumerate(outs)],
            "properties": {"Node name for S&R": type_},
        }
        if type_ not in BUILTIN or type_ in BUILTIN_WIDGETS:
            node["widgets_values"] = wvals
        if title:
            node["title"] = title
        self.next_node += 1
        self.nodes.append(node)
        return node

    def note(self, pos, size, text):
        n = self.add("MarkdownNote", pos, size=size)
        n["widgets_values"] = [text]
        n["color"], n["bgcolor"] = "#432", "#653"
        return n

    def connect(self, src, out_name, dst, in_name):
        oi = next(i for i, o in enumerate(src["outputs"]) if o["name"] == out_name)
        ii = next(i for i, p in enumerate(dst["inputs"]) if p["name"] == in_name)
        typ = src["outputs"][oi]["type"]
        assert dst["inputs"][ii]["link"] is None, f"{in_name} already linked"
        lid = self.next_link
        self.next_link += 1
        src["outputs"][oi]["links"] = (src["outputs"][oi]["links"] or []) + [lid]
        dst["inputs"][ii]["link"] = lid
        self.links.append([lid, src["id"], oi, dst["id"], ii, typ])

    def finish(self):
        # execution order: topological, notes first
        indeg = {n["id"]: 0 for n in self.nodes}
        for _l, s, _so, d, _di, _t in self.links:
            indeg[d] += 1
        ready = [n["id"] for n in self.nodes if indeg[n["id"]] == 0]
        order = []
        while ready:
            cur = ready.pop(0)
            order.append(cur)
            for _l, s, _so, d, _di, _t in self.links:
                if s == cur:
                    indeg[d] -= 1
                    if indeg[d] == 0:
                        ready.append(d)
        for pos, nid in enumerate(order):
            next(n for n in self.nodes if n["id"] == nid)["order"] = pos
        return {
            "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "ComfyUI-MultiTrackAudio/" + self.name)),
            "revision": 0,
            "last_node_id": self.next_node - 1, "last_link_id": self.next_link - 1,
            "nodes": self.nodes, "links": self.links, "groups": [], "config": {},
            "extra": {"ds": {"scale": 0.75, "offset": [60, 40]}}, "version": 0.4,
        }

    def save(self):
        OUT.mkdir(exist_ok=True)
        p = OUT / f"{self.name}.json"
        p.write_text(json.dumps(self.finish(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("wrote", p.relative_to(ROOT))




def fmt(prefix):
    """The save_format option that starts with `prefix` (e.g. 'mka', 'mov')."""
    opts = NODES["MTA_AudioTimeline"].INPUT_TYPES()["required"]["save_format"][0]
    return next(o for o in opts if o.startswith(prefix))


NODE = "MTA_AudioTimeline"
NODE_SIZE = (680, 760)


def wf_load_audio():
    g = Graph("01_load_audio_to_speakers")
    g.note((40, 0), (1040, 330),
           "# 01 · Load Audio → Audio Timeline → one audio per speaker\n"
           "1. Pick a file in **Load Audio** and queue the workflow **once**: the connected audio then appears on the "
           "timeline of *Audio Timeline*.\n"
           "2. **Sections** = the parts you keep. Drag on the ruler to mark one (drag more to add), drag their edges to trim, "
           "drag the blocks in the *output* strip to reorder, ✂ Split at the playhead, Delete to remove.\n"
           "3. **Analyze speakers** (set *num_speakers* if you know it). Then fix the result like in an editor: drag a clip's "
           "edges to trim, drag a clip onto another speaker's lane to reassign it, drag in an empty lane to draw a clip, "
           "**+ Speaker** for a manual one, double-click a name to rename. **Undo/Redo** are there.\n"
           "4. The node gets one audio output per lane (`speaker_1`, `speaker_2`, …); connect what you need. "
           "Click a lane + **Play** to listen.\n\n"
           "*Speaker detection needs a one-time setup, see the README.*")
    load = g.add("LoadAudio", (40, 370), {"audio": "dialogue.wav"}, size=(300, 120))
    n = g.add(NODE, (400, 370), {"num_speakers": 2}, size=NODE_SIZE, outputs=5)
    p_t = g.add("PreviewAudio", (1120, 370), title="Timeline (the sections, joined)")
    p_1 = g.add("PreviewAudio", (1120, 510), title="Speaker 1")
    p_2 = g.add("PreviewAudio", (1120, 650), title="Speaker 2")
    g.connect(load, "AUDIO", n, "audio_in")
    g.connect(n, "timeline", p_t, "audio")
    g.connect(n, "speaker_1", p_1, "audio")
    g.connect(n, "speaker_2", p_2, "audio")
    g.save()


def wf_save():
    g = Graph("02_file_edit_and_save_multitrack")
    g.note((40, 0), (1040, 260),
           "# 02 · Straight from a file, edit, save a multi-track file\n"
           "Choose the file in **audio** (a file in `ComfyUI/input`): the timeline shows it at once, no run needed. Edit "
           "sections and speakers, then queue: with **save_format** `mka` (or `mov`) the timeline and every speaker are "
           "written as one audio stream each into `ComfyUI/output/speakers/`.\n\n"
           "**Size:** *save_bit_depth* and *save_sample_rate* set the bitrate (rate × bits × channels); the line under the "
           "buttons estimates it. This example saves 16-bit / 22.05 kHz. The duration never changes, whatever you pick. "
           "*save_mono* (advanced) halves stereo.\n"
           "Only the first track of a file is analysed; pick another with *track_index* (click a track lane).")
    n = g.add(NODE, (40, 300), {"audio": "dialogue.wav", "num_speakers": 2, "save_format": fmt("mka"),
                                "save_bit_depth": "16", "save_sample_rate": "22050",
                                "filename_prefix": "speakers/dialogue"}, size=NODE_SIZE, outputs=5)
    paths = g.add("PreviewAny", (760, 300), title="Saved file")
    p_t = g.add("PreviewAudio", (760, 440), title="Timeline")
    g.connect(n, "saved_paths", paths, "source")
    g.connect(n, "timeline", p_t, "audio")
    g.save()


def wf_tracks():
    g = Graph("03_tracks_of_the_file")
    g.note((40, 0), (1040, 260),
           "# 03 · A file that already has separate tracks (mov / mka)\n"
           "With **speakers_from = tracks of the file** nothing is analysed: the track chosen by *track_index* (usually 0, the "
           "full dialogue) becomes `timeline`, and the file's *other* tracks come out as `speaker_1`, `speaker_2`… as they "
           "are. All tracks are shown as lanes, so you see at a glance what the file contains. The sections you mark apply to "
           "every track, so they stay in step.\n\n"
           "*Channels are not tracks:* a multichannel WAV is one track. Audio with more than two channels is mixed to mono "
           "(ComfyUI's own audio nodes play such audio too slow); *multichannel = keep all channels* (advanced) leaves it as is.")
    n = g.add(NODE, (40, 300), {"audio": "multitrack.mov", "speakers_from": "tracks of the file"}, size=NODE_SIZE, outputs=5)
    p_t = g.add("PreviewAudio", (760, 300), title="Timeline track")
    p_1 = g.add("PreviewAudio", (760, 440), title="Other track 1")
    p_2 = g.add("PreviewAudio", (760, 580), title="Other track 2")
    g.connect(n, "timeline", p_t, "audio")
    g.connect(n, "speaker_1", p_1, "audio")
    g.connect(n, "speaker_2", p_2, "audio")
    g.save()


if __name__ == "__main__":
    for f in (wf_load_audio, wf_save, wf_tracks):
        f()
