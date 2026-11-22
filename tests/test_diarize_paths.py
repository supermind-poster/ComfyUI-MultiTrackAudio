"""Model path handling of the diarization node (no pyannote needed)."""
import importlib
import os
import sys

import pytest


@pytest.fixture
def dz(pkg):
    return importlib.import_module(pkg.__name__ + ".diarize")


def make_model(path):
    os.makedirs(path)
    open(os.path.join(path, "config.yaml"), "w").write("version: 4\n")
    return str(path)


def test_clean_strips_quotes_and_spaces(dz):
    assert dz.clean_model_string('  "C:\\a b\\m"  ') == "C:\\a b\\m"
    assert dz.clean_model_string("'x/y'") == "x/y"
    assert dz.clean_model_string("") == ""


def test_quoted_folder_path_is_accepted(dz, tmp_path):
    m = make_model(tmp_path / "pyannote" / "speaker-diarization-community-1")
    assert dz.resolve_model(f'"{m}"') == (m, True)
    assert dz.resolve_model(os.path.join(m, "config.yaml")) == (os.path.join(m, "config.yaml"), True)


def test_wrong_path_gives_clear_error_not_hf_error(dz, tmp_path):
    """The reported bug: quoted path whose 'pyannote\\' separator was lost."""
    make_model(tmp_path / "models" / "pyannote")  # sibling that exists
    bad = str(tmp_path / "models" / "pyannotespeaker-diarization-community-1")
    with pytest.raises(RuntimeError, match="Model folder not found") as e:
        dz.resolve_model(f'"{bad}"')
    assert "Repo id" not in str(e.value)
    assert "separator is probably missing" in str(e.value)


def test_folder_without_config_and_nested_config(dz, tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    (empty / "readme.txt").write_text("x")
    with pytest.raises(RuntimeError, match="no config.yaml"):
        dz.resolve_model(str(empty))
    outer = tmp_path / "outer"
    inner = make_model(outer / "speaker-diarization-community-1")
    assert dz.resolve_model(str(outer)) == (inner, True)  # one level down is found


def test_repo_id_passthrough_and_local_autodetect(dz, tmp_path, monkeypatch):
    fp = sys.modules["folder_paths"]
    monkeypatch.setattr(fp, "models_dir", str(tmp_path / "models"), raising=False)
    rid = "pyannote/speaker-diarization-community-1"
    assert dz.resolve_model(rid) == (rid, False)  # nothing local -> download from the hub
    local = make_model(tmp_path / "models" / "pyannote" / "speaker-diarization-community-1")
    assert dz.resolve_model(rid) == (local, True)  # found in ComfyUI/models/pyannote
    assert dz.resolve_model("") == (local, True)  # empty -> default model


def test_speechbrain_lazy_module_patch(dz):
    """The patched ensure_module refuses callers named inspect.py (no recursion) and imports otherwise."""
    class Lazy:  # same attribute layout as speechbrain.utils.importutils.LazyModule
        def __init__(self, name, target, package):
            self.target, self.lazy_module, self.package = target, None, package

        def ensure_module(self, stacklevel):
            raise AssertionError("must be replaced")

        def __getattr__(self, attr):
            return getattr(self.ensure_module(1), attr)

    assert dz.patch_lazy_module_class(Lazy) is True
    lazy = Lazy("x", "json", None)
    assert lazy.dumps([1]) == "[1]"  # normal use imports the target

    # access coming from a frame whose file is called inspect.py (python_embeded) -> AttributeError, not recursion
    ns = {}
    exec(compile("def probe(obj):\n    return getattr(obj, 'definitely_missing', 'default')\n", "inspect.py", "exec"), ns)
    fresh = Lazy("y", "json", None)
    assert ns["probe"](fresh) == "default"
    assert fresh.lazy_module is None  # and the module was not imported by that probe


def test_speechbrain_patch_skips_unknown_layout(dz):
    class Other:
        def __init__(self, something): ...
    assert dz.patch_lazy_module_class(Other) is False
