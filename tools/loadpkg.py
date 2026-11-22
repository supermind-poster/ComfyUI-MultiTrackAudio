"""Import the node package outside of ComfyUI (for tests and the workflow generator).

If `torch` / `folder_paths` are not importable (no ComfyUI around), tiny stand-ins are installed so that
nodes.py can be imported and its INPUT_TYPES / execute logic exercised. Real modules are never shadowed.
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def _make_torch():
    m = types.ModuleType("torch")

    class Tensor:
        def __init__(self, a): self.a = a
        def dim(self): return self.a.ndim
        def __getitem__(self, i): return Tensor(self.a[i])
        def detach(self): return self
        def cpu(self): return self
        def float(self): return Tensor(self.a.astype(np.float32))
        def numpy(self): return self.a
        def unsqueeze(self, d): return Tensor(np.expand_dims(self.a, d))
        @property
        def shape(self): return self.a.shape

    m.Tensor = Tensor
    m.from_numpy = lambda a: Tensor(a)
    return m


def _make_folder_paths():
    import os
    import re

    m = types.ModuleType("folder_paths")
    base = tempfile.mkdtemp(prefix="mta_stub_")
    m.IN, m.OUT = base + "/input", base + "/output"
    for d in (m.IN, m.OUT):
        os.makedirs(d, exist_ok=True)
    m.TEMP = base + "/temp"
    os.makedirs(m.TEMP, exist_ok=True)
    m.models_dir = base + "/models"
    m.get_temp_directory = lambda: m.TEMP
    m.get_input_directory = lambda: m.IN
    m.get_output_directory = lambda: m.OUT
    m.get_annotated_filepath = lambda n: os.path.join(m.IN, n)
    m.exists_annotated_filepath = lambda n: os.path.exists(os.path.join(m.IN, n))

    def get_save_image_path(prefix, out, *_a):
        sub, fn = os.path.dirname(prefix), os.path.basename(prefix)
        folder = os.path.join(out, sub)
        os.makedirs(folder, exist_ok=True)
        c = 1
        for f in os.listdir(folder):
            if f.startswith(fn + "_"):
                mt = re.match(r"(\d+)", f[len(fn) + 1:])
                if mt:
                    c = max(c, int(mt.group(1)) + 1)
        return folder, fn, c, sub, prefix

    m.get_save_image_path = get_save_image_path
    return m


def load_package(name: str = "mta_pkg"):
    if importlib.util.find_spec("torch") is None:
        sys.modules["torch"] = _make_torch()
    if importlib.util.find_spec("folder_paths") is None:
        sys.modules["folder_paths"] = _make_folder_paths()
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, ROOT / "__init__.py",
                                                  submodule_search_locations=[str(ROOT)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod
