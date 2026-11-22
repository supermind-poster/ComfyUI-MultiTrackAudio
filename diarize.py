"""Speaker diarization via pyannote.audio (optional dependency, imported lazily)."""
from __future__ import annotations

import difflib
import gc
import os
import re
import sys
from typing import List

import numpy as np

from .core import Segment

DEFAULT_MODEL = "pyannote/speaker-diarization-community-1"
_CACHE: dict = {}


_PATHLIKE = re.compile(r"^[A-Za-z]:|^[\\/]|^\.{1,2}[\\/]|^~|[\\]")


def clean_model_string(model: str) -> str:
    """Trim spaces and surrounding quotes (Windows 'Copy as path' adds them), expand ~ and %VARS%."""
    m = (model or "").strip()
    while len(m) >= 2 and m[0] == m[-1] and m[0] in "\"'":
        m = m[1:-1].strip()
    return os.path.expanduser(os.path.expandvars(m))


def _models_dir():
    try:
        import folder_paths
        return getattr(folder_paths, "models_dir", None)
    except Exception:
        return None


def _local_checkpoint(folder: str) -> str:
    """A folder that holds (or directly contains one level below) the pipeline's config.yaml."""
    if os.path.isfile(os.path.join(folder, "config.yaml")):
        return folder
    subs = [os.path.join(folder, d) for d in sorted(os.listdir(folder))
            if os.path.isfile(os.path.join(folder, d, "config.yaml"))]
    if len(subs) == 1:
        return subs[0]
    listing = ", ".join(sorted(os.listdir(folder))[:12]) or "(empty)"
    raise RuntimeError(f"The folder '{folder}' has no config.yaml, so it is not a pyannote pipeline. "
                       f"Download the WHOLE repository there (see README / tools/download_model.py). "
                       f"It contains: {listing}")


def resolve_model(model: str):
    """-> (checkpoint, is_local). Accepts a Hugging Face id, a folder, or a config.yaml path."""
    m = clean_model_string(model) or DEFAULT_MODEL
    if os.path.isfile(m):
        return m, True
    if os.path.isdir(m):
        return _local_checkpoint(m), True
    if _PATHLIKE.search(m):  # looks like a path, but it doesn't exist: say so instead of asking Hugging Face
        parent = os.path.dirname(m)
        hint = ""
        if parent and os.path.isdir(parent):
            entries = os.listdir(parent)
            base = os.path.basename(m)
            glued = [e for e in entries if e and len(e) < len(base) and base.startswith(e)
                     and os.path.isdir(os.path.join(parent, e))]
            if glued:  # e.g. '...\\models\\pyannotespeaker-diarization' where 'pyannote' is a folder
                hint = (f" '{glued[0]}' exists in '{parent}': a path separator is probably missing after it "
                        f"('{glued[0]}\\{base[len(glued[0]):]}').")
            else:
                close = difflib.get_close_matches(base, entries, n=3, cutoff=0.5)
                if close:
                    hint = f" Similar entries in '{parent}': {', '.join(close)}."
        raise RuntimeError(f"Model folder not found: '{m}'. Check the path (every backslash matters).{hint}")
    base = _models_dir()  # a local copy in ComfyUI/models/pyannote/<name> wins over downloading
    if base and "/" in m:
        cand = os.path.join(base, "pyannote", m.split("/", 1)[1])
        if os.path.isdir(cand) and os.path.isfile(os.path.join(cand, "config.yaml")):
            return cand, True
    return m, False


# --------------------------------------------------------------------------- #
# speechbrain workaround
# --------------------------------------------------------------------------- #
_SB_PATCHED = False


def patch_lazy_module_class(cls) -> bool:
    """Replace `LazyModule.ensure_module` of speechbrain with a version that can't recurse forever.

    speechbrain's original asks `inspect.getframeinfo()` who is importing the lazy module (it must refuse
    when the caller is inspect.py). getframeinfo -> getsourcefile -> getmodule then walks sys.modules and reads
    `__file__` of every lazy module -> ensure_module again -> ... RecursionError. That only stays harmless when
    inspect.py has an existing absolute path; in ComfyUI's python_embeded the stdlib lives in a zip and the file
    name is just "inspect.py". lightning's `inspect.stack()` (called while loading a pyannote model) then blows up.
    Checking the caller's file name directly gives the same behaviour without the recursion.
    """
    import importlib
    import inspect as _inspect

    try:  # only patch the layout we know (name/target/package attributes)
        params = _inspect.signature(cls.__init__).parameters
        if not {"name", "target", "package"} <= set(params) or not hasattr(cls, "ensure_module"):
            return False
    except (TypeError, ValueError):
        return False

    def ensure_module(self, stacklevel):
        try:
            caller = sys._getframe(stacklevel + 1)
        except ValueError:
            caller = None
        if caller is not None and os.path.basename(caller.f_code.co_filename) == "inspect.py":
            raise AttributeError()  # inspect is probing attributes; pretend there is none
        if self.lazy_module is None:
            try:
                if self.package is None:
                    self.lazy_module = importlib.import_module(self.target)
                else:
                    self.lazy_module = importlib.import_module(f".{self.target}", self.package)
            except Exception as e:
                raise ImportError(f"Lazy import of {self!r} failed") from e
        return self.lazy_module

    cls.ensure_module = ensure_module
    return True


def patch_speechbrain_lazy_modules() -> bool:
    global _SB_PATCHED
    if _SB_PATCHED:
        return True
    try:
        from speechbrain.utils.importutils import LazyModule
    except Exception:
        return False  # speechbrain not installed (or a layout without LazyModule): nothing to fix
    _SB_PATCHED = patch_lazy_module_class(LazyModule)
    return _SB_PATCHED


def _hf_token(model: str):
    tok = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    if tok:
        return tok
    try:
        from huggingface_hub import get_token
        return get_token()  # token saved by `huggingface-cli login` / `hf auth login`
    except Exception:
        return None


def _device(choice: str):
    import torch
    if choice == "cpu":
        return torch.device("cpu")
    try:
        import comfy.model_management as mm
        dev = mm.get_torch_device()
    except Exception:
        dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device("cpu") if dev.type == "mps" else dev  # pyannote on MPS is unreliable


def _load(model: str, device):
    checkpoint, is_local = resolve_model(model)
    key = (checkpoint, str(device))
    if key in _CACHE:
        return _CACHE[key]
    try:
        from pyannote.audio import Pipeline
    except ImportError as e:
        raise RuntimeError(
            "pyannote.audio is not installed in the Python environment that runs ComfyUI.\n"
            "Install it with:  python -m pip install pyannote.audio\n"
            "(see the README: it may change your torch version, check pip's output first)") from e
    patch_speechbrain_lazy_modules()
    token = None if is_local else _hf_token(checkpoint)
    try:
        try:
            pipe = Pipeline.from_pretrained(checkpoint, token=token)
        except TypeError:  # older pyannote.audio releases
            pipe = Pipeline.from_pretrained(checkpoint, use_auth_token=token)
    except Exception as e:
        if is_local:
            raise RuntimeError(f"Could not load the local pipeline '{checkpoint}': {e}") from e
        raise RuntimeError(
            f"Could not load pipeline '{checkpoint}': {e}\n"
            "The pyannote models are gated: accept the model's conditions on huggingface.co, then make a "
            "token available via the HF_TOKEN environment variable or `huggingface-cli login`. "
            "Or download the model once with tools/download_model.py; it is then found automatically in "
            "ComfyUI/models/pyannote/.") from e
    if pipe is None:
        raise RuntimeError(f"Pipeline '{checkpoint}' could not be loaded (missing Hugging Face token or "
                           "model conditions not accepted).")
    pipe.to(device)
    _CACHE.clear()  # keep at most one pipeline in memory
    _CACHE[key] = pipe
    return pipe


def unload() -> None:
    _CACHE.clear()
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def diarize(mono: np.ndarray, sample_rate: int, model: str = DEFAULT_MODEL, num_speakers: int = 0,
            min_speakers: int = 0, max_speakers: int = 0, exclusive: bool = True,
            device: str = "auto") -> List[Segment]:
    """mono: float32 [1, T]. Returns speech segments labelled by speaker."""
    import torch
    pipe = _load(model, _device(device))
    kwargs = {}
    if num_speakers > 0:
        kwargs["num_speakers"] = int(num_speakers)
    else:
        if min_speakers > 0:
            kwargs["min_speakers"] = int(min_speakers)
        if max_speakers > 0:
            kwargs["max_speakers"] = int(max_speakers)

    wave = torch.from_numpy(np.ascontiguousarray(mono, dtype=np.float32))
    with torch.no_grad():
        out = pipe({"waveform": wave, "sample_rate": int(sample_rate)}, **kwargs)

    ann = None
    if exclusive:  # pyannote.audio >= 4: no overlapping speech, tracks sum back to the mix
        ann = getattr(out, "exclusive_speaker_diarization", None)
        if ann is None:
            print("[MultiTrackAudio] this pipeline has no exclusive diarization; "
                  "overlapped speech will appear on more than one track.")
    if ann is None:
        ann = getattr(out, "speaker_diarization", out)

    segs: List[Segment] = []
    if hasattr(ann, "itertracks"):
        for turn, _, spk in ann.itertracks(yield_label=True):
            segs.append(Segment(float(turn.start), float(turn.end), str(spk)))
    else:
        for turn, spk in ann:
            segs.append(Segment(float(turn.start), float(turn.end), str(spk)))
    return segs
