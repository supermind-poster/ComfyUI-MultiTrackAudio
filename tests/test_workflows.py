"""example_workflows/*.json must stay consistent with the node definition."""
import json
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = sorted((ROOT / "example_workflows").glob("*.json"))
SCALARS = ("INT", "FLOAT", "STRING", "BOOLEAN")
BUILTIN = {"PreviewAudio", "PreviewAny", "MarkdownNote", "LoadAudio"}


def test_workflows_exist():
    assert len(FILES) >= 3


def declared(cls):
    out = []
    it = cls.INPUT_TYPES()
    for sec in ("required", "optional"):
        for name, spec in it.get(sec, {}).items():
            typ = spec[0]
            kind = "COMBO" if isinstance(typ, (list, tuple)) else typ
            out.append((name, kind, kind == "COMBO" or kind in SCALARS, spec))
    return out


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_workflow_consistent(pkg, path):
    wf = json.loads(path.read_text(encoding="utf-8"))
    N = pkg.NODE_CLASS_MAPPINGS
    nodes = {n["id"]: n for n in wf["nodes"]}
    assert len(nodes) == len(wf["nodes"]), "duplicate node ids"
    assert wf["last_node_id"] >= max(nodes)
    assert len({n["order"] for n in wf["nodes"]}) == len(nodes), "duplicate order values"
    assert any(n["type"] in N for n in wf["nodes"]), "workflow doesn't use the pack's node"

    for n in wf["nodes"]:
        t = n["type"]
        assert t in N or t in BUILTIN, f"unknown node type {t}"
        if t not in N:
            continue
        cls = N[t]
        decl = declared(cls)
        assert [i["name"] for i in n["inputs"]] == [d[0] for d in decl], t
        assert [("widget" in i) for i in n["inputs"]] == [d[2] for d in decl], t
        widgets = [d for d in decl if d[2]]
        wvals = n["widgets_values"]
        assert len(wvals) == len(widgets), f"{t}: widgets_values has {len(wvals)}, expected {len(widgets)}"
        for (name, kind, _w, spec), v in zip(widgets, wvals):
            if kind == "COMBO" and name != "audio":  # 'audio' is the user's own file
                assert v in spec[0], f"{t}.{name}={v!r} not in {spec[0]}"
            if kind == "INT":
                assert isinstance(v, int) and not isinstance(v, bool), f"{t}.{name}"
                opts = spec[1] if len(spec) > 1 else {}
                assert opts.get("min", v) <= v <= opts.get("max", v), f"{t}.{name}={v} out of range"
            if kind == "FLOAT":
                assert isinstance(v, (int, float)), f"{t}.{name}"
            if kind == "BOOLEAN":
                assert isinstance(v, bool), f"{t}.{name}"
            if kind == "STRING":
                assert isinstance(v, str), f"{t}.{name}"
        # the UI adds/removes trailing speaker outputs, so a saved node has a prefix of the full output list
        k = len(n["outputs"])
        assert 4 <= k <= len(cls.RETURN_NAMES), t
        assert [o["name"] for o in n["outputs"]] == list(cls.RETURN_NAMES[:k]), t
        assert [o["type"] for o in n["outputs"]] == list(cls.RETURN_TYPES[:k]), t

    seen = set()
    for lid, src, so, dst, di, typ in wf["links"]:
        assert lid not in seen and lid <= wf["last_link_id"]
        seen.add(lid)
        assert lid in (nodes[src]["outputs"][so]["links"] or []), f"link {lid} missing at source"
        assert nodes[dst]["inputs"][di]["link"] == lid, f"link {lid} missing at target"
        assert nodes[src]["outputs"][so]["type"] == typ
        assert nodes[dst]["inputs"][di]["type"] in (typ, "*"), f"link {lid}: {typ} -> {nodes[dst]['inputs'][di]['type']}"
    for n in wf["nodes"]:
        for o in n["outputs"]:
            assert all(l in seen for l in (o["links"] or []))
        for i in n["inputs"]:
            assert i["link"] is None or i["link"] in seen
