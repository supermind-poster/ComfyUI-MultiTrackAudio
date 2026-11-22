"""Server-side helpers for the timeline UI: preview cache, waveform peaks, wav slices, speaker analysis.

A source is either a file (its first audio track) or audio that arrived through the node's `audio_in` socket.
Either way a 16 kHz mono int16 "preview" is cached on disk (.npy, memory-mapped afterwards); peaks for any zoom
level, playback slices and the diarization input are cut from it, so the browser never has to download or decode
the real media file. Audio from a socket exists only while the graph runs, so the node stores its preview under a
content key and tells the UI (see nodes.py).
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import tempfile
import threading
import wave
from fractions import Fraction
from typing import Dict, List

import numpy as np
import av

from . import core
from .core import Segment, _as_list

PREVIEW_SR = 16000
EXTS = (".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".aif", ".aiff", ".wma",
        ".mov", ".mp4", ".mkv", ".mka", ".mxf", ".webm", ".avi", ".ts", ".m2ts")
_FFError = getattr(av.error, "FFmpegError", Exception)
_KEY_RE = re.compile(r"^[0-9a-f]{16,40}$")
_LOCKS: Dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


# --------------------------------------------------------------------------- #
# paths
# --------------------------------------------------------------------------- #
def _fp():
    try:
        import folder_paths
        return folder_paths
    except Exception:
        return None


def input_files() -> List[str]:
    fp = _fp()
    d = fp.get_input_directory() if fp else "."
    try:
        files = sorted(f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f)) and f.lower().endswith(EXTS))
    except OSError:
        files = []
    return files or [""]


def resolve_path(audio: str, override: str = "") -> str:
    override = (override or "").strip().strip('"').strip("'")
    if override:
        if not os.path.isfile(override):
            raise FileNotFoundError(f"File not found: {override}")
        return override
    if not audio:
        raise ValueError("No audio file selected")
    fp = _fp()
    p = fp.get_annotated_filepath(audio) if fp else audio
    if not os.path.isfile(p):
        raise FileNotFoundError(f"File not found: {audio}")
    return p


def file_stamp(audio: str, override: str = "") -> str:
    try:
        p = resolve_path(audio, override)
        st = os.stat(p)
        return f"{p}|{st.st_mtime_ns}|{st.st_size}"
    except Exception:
        return "missing"


def cache_dir() -> str:
    fp = _fp()
    base = fp.get_temp_directory() if fp else tempfile.gettempdir()
    d = os.path.join(base, "mta_cache")
    os.makedirs(d, exist_ok=True)
    return d


def _file_cache(path: str, track: int) -> str:
    st = os.stat(path)
    key = f"{os.path.abspath(path)}|{st.st_mtime_ns}|{st.st_size}|{track}|v3"
    return os.path.join(cache_dir(), hashlib.sha1(key.encode()).hexdigest() + ".npy")


def _key_cache(key: str) -> str:
    if not _KEY_RE.match(key or ""):
        raise ValueError("Invalid audio key")
    return os.path.join(cache_dir(), f"in_{key}.npy")


def _locked_build(cache_file: str, build) -> np.ndarray:
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(cache_file, threading.Lock())
    with lock:
        if not os.path.isfile(cache_file):
            arr = build()
            tmp = cache_file + f".{os.getpid()}.tmp.npy"
            np.save(tmp, arr)
            os.replace(tmp, cache_file)
        return np.load(cache_file, mmap_mode="r")


# --------------------------------------------------------------------------- #
# previews
# --------------------------------------------------------------------------- #
def _nb_channels(stream) -> int:
    ctx = stream.codec_context
    for getter in (lambda: ctx.channels, lambda: ctx.layout.nb_channels, lambda: len(ctx.layout.channels)):
        try:
            n = int(getter())
            if n > 0:
                return n
        except Exception:
            pass
    return 0


def _decode_preview(path: str, track: int = 0) -> np.ndarray:
    """Stream-decode one audio track to 16 kHz mono int16 (works for any channel layout)."""
    with av.open(path) as c:
        audio = list(c.streams.audio)
        if not audio:
            raise ValueError("The file has no audio track")
        if not 0 <= track < len(audio):
            raise IndexError(f"track {track} does not exist: the file has {len(audio)} audio track(s)")
        pre = av.AudioResampler(format="fltp")  # normalise sample format, keep channels and rate
        post = None
        parts: List[np.ndarray] = []
        pos = 0

        def feed(res):
            nonlocal post, pos
            for g in _as_list(res):
                mono = g.to_ndarray().mean(axis=0, keepdims=True).astype(np.float32)
                fr = av.AudioFrame.from_ndarray(mono, format="fltp", layout="mono")
                fr.sample_rate = g.sample_rate
                fr.pts = pos
                fr.time_base = Fraction(1, g.sample_rate)
                pos += mono.shape[1]
                if post is None:
                    post = av.AudioResampler(format="s16", layout="mono", rate=PREVIEW_SR)
                for o in _as_list(post.resample(fr)):
                    parts.append(o.to_ndarray().reshape(-1))

        for packet in c.demux(audio[track]):
            try:
                frames = packet.decode()
            except _FFError:
                continue
            for f in frames:
                feed(pre.resample(f))
        feed(pre.resample(None))
        if post is not None:
            for o in _as_list(post.resample(None)):
                parts.append(o.to_ndarray().reshape(-1))
    if not parts:
        raise RuntimeError("The audio track decoded to zero samples")
    return np.concatenate(parts).astype(np.int16)


def file_preview(path: str, track: int = 0) -> np.ndarray:
    return _locked_build(_file_cache(path, track), lambda: _decode_preview(path, track))


def _preview_from_waveform(data: np.ndarray, sr: int) -> np.ndarray:
    mono = data.mean(axis=0, keepdims=True).astype(np.float32)
    mono = core.resample(mono, sr, PREVIEW_SR)[0]
    return np.clip(np.rint(mono * 32767.0), -32768, 32767).astype(np.int16)


def _content_key(data: np.ndarray, sr: int) -> str:
    flat = np.ascontiguousarray(data).reshape(-1)
    idx = np.linspace(0, max(flat.size - 1, 0), min(flat.size, 65536)).astype(np.int64)
    h = hashlib.sha1()
    h.update(np.asarray(list(data.shape) + [sr], dtype=np.int64).tobytes())
    h.update(np.ascontiguousarray(flat[idx]).tobytes())
    return h.hexdigest()[:24]


def store_input_preview(data: np.ndarray, sr: int) -> str:
    """Cache the preview of audio that came through a socket; returns the key the UI uses to ask for it."""
    key = _content_key(data, sr)
    _locked_build(_key_cache(key), lambda: _preview_from_waveform(data, sr))
    return key


def get_preview(q: dict) -> np.ndarray:
    """The preview array of the source described by a request: {'key'} (socket audio) or {'file', 'path'}."""
    key = (q.get("key") or "").strip()
    if key:
        f = _key_cache(key)
        if not os.path.isfile(f):
            raise FileNotFoundError("The connected audio is not cached yet: run the workflow once.")
        return np.load(f, mmap_mode="r")
    return file_preview(resolve_path(q.get("file", ""), q.get("path", "")), int(float(q.get("track") or 0)))


# --------------------------------------------------------------------------- #
# what the UI asks for
# --------------------------------------------------------------------------- #
def probe_info(path: str) -> dict:
    tracks = core.probe_tracks(path)
    if not tracks:
        raise ValueError("The file has no audio track")
    return {"name": os.path.basename(path), "duration": max(t["duration"] for t in tracks), "tracks": tracks}


def peaks(arr: np.ndarray, start: float = 0.0, end: float = 0.0, n: int = 1000) -> dict:
    dur = len(arr) / PREVIEW_SR
    start = min(max(0.0, start), dur)
    end = dur if end <= 0 or end > dur else end
    i0 = int(start * PREVIEW_SR)
    i1 = max(i0 + 1, int(end * PREVIEW_SR))
    seg = np.asarray(arr[i0:i1])
    n = max(1, min(int(n), len(seg)))
    step = max(1, len(seg) // n)
    n = len(seg) // step
    body = seg[:n * step].reshape(n, step)
    return {"start": round(start, 4), "end": round(end, 4), "duration": round(dur, 4),
            "min": (body.min(axis=1) >> 8).astype(int).tolist(),
            "max": (body.max(axis=1) >> 8).astype(int).tolist()}


def wav_slice(arr: np.ndarray, start: float = 0.0, end: float = 0.0) -> bytes:
    dur = len(arr) / PREVIEW_SR
    end = dur if end <= 0 or end > dur else end
    seg = np.asarray(arr[int(max(0.0, start) * PREVIEW_SR):int(end * PREVIEW_SR)], dtype="<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(PREVIEW_SR)
        w.writeframes(seg.tobytes())
    return buf.getvalue()


def program_preview(arr: np.ndarray, sections) -> np.ndarray:
    """The preview of the program: the sections of the source joined in order (empty = everything)."""
    dur = len(arr) / PREVIEW_SR
    sec = core.normalize_sections(sections, dur)
    lay = core.section_layout(sec, PREVIEW_SR, len(arr))
    if len(lay) == 1 and lay[0][0] == 0 and lay[0][1] == len(arr):
        return np.asarray(arr)
    return np.concatenate([np.asarray(arr[i0:i1]) for i0, i1, _ in lay])


def analyze(arr: np.ndarray, sections=None, model: str = "", num_speakers: int = 0, min_speakers: int = 0,
            max_speakers: int = 0, exclusive: bool = True, device: str = "auto",
            keep_loaded: bool = False) -> List[Segment]:
    """Speaker diarization of the program (the given sections joined). Returns segments in PROGRAM time."""
    from . import diarize
    prog = program_preview(arr, sections)
    if len(prog) / PREVIEW_SR < 0.5:
        raise ValueError("The selected sections are too short to analyse")
    mono = (prog.astype(np.float32) / 32768.0)[None, :]
    try:
        return diarize.diarize(mono, PREVIEW_SR, model or diarize.DEFAULT_MODEL, num_speakers, min_speakers,
                               max_speakers, exclusive, device)
    finally:
        if not keep_loaded:
            diarize.unload()
