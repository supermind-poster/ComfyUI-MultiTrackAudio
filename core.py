"""Pure numpy + PyAV helpers (no torch / ComfyUI imports, so they are unit-testable).

Data model
----------
Track   : float32 samples shaped [channels, samples] + sample rate
Segment : (start, end, speaker) in seconds
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from fractions import Fraction
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import av

_FFError = getattr(av.error, "FFmpegError", Exception)


@dataclass
class Track:
    data: np.ndarray  # float32 [channels, samples]
    sample_rate: int
    title: str = ""
    language: str = ""

    @property
    def channels(self) -> int:
        return int(self.data.shape[0])

    @property
    def samples(self) -> int:
        return int(self.data.shape[1])

    @property
    def duration(self) -> float:
        return self.samples / float(self.sample_rate)


@dataclass
class Segment:
    start: float
    end: float
    speaker: str


def _as_list(x) -> list:
    if x is None:
        return []
    return list(x) if isinstance(x, (list, tuple)) else [x]


# --------------------------------------------------------------------------- #
# reading
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


def _title(stream) -> str:
    md = dict(stream.metadata or {})
    t = md.get("title") or md.get("handler_name") or ""
    return "" if t == "SoundHandler" else t


def probe_tracks(path: str) -> List[dict]:
    """The audio tracks (streams) of a file."""
    out: List[dict] = []
    with av.open(path) as c:
        for i, s in enumerate(c.streams.audio):
            if s.duration is not None and s.time_base is not None:
                dur = float(s.duration * s.time_base)
            else:
                dur = (c.duration / av.time_base) if c.duration else 0.0
            out.append({"index": i, "codec": s.codec_context.name, "channels": _nb_channels(s),
                        "sample_rate": int(s.codec_context.sample_rate or 0), "duration": round(dur, 3),
                        "title": _title(s), "language": (dict(s.metadata or {}).get("language", ""))})
    return out


def decode_tracks(path: str, indices: Optional[Sequence[int]] = None) -> List[Track]:
    """Decode audio tracks (default: all) to float32 [C, T].

    The sample rate is taken from the decoded frames, not from the container header: for some codecs
    (HE-AAC, Opus, ...) the header value differs from what comes out of the decoder.
    """
    with av.open(path) as c:
        audio = list(c.streams.audio)
        if not audio:
            raise ValueError("The file has no audio track")
        if indices is None:
            indices = list(range(len(audio)))
        for i in indices:
            if not 0 <= i < len(audio):
                raise IndexError(f"track {i} does not exist: the file has {len(audio)} audio track(s)")
        sel = [audio[i] for i in indices]
        chunks: Dict[int, list] = {s.index: [] for s in sel}
        rates: Dict[int, int] = {}
        rs = {s.index: av.AudioResampler(format="fltp") for s in sel}

        def push(sidx, res):
            for f in _as_list(res):
                rates.setdefault(sidx, int(f.sample_rate))
                chunks[sidx].append(f.to_ndarray())  # (channels, samples)

        for packet in c.demux(*sel):
            sidx = packet.stream.index
            try:
                frames = packet.decode()
            except _FFError:
                continue  # skip a corrupt packet
            for f in frames:
                push(sidx, rs[sidx].resample(f))
        for s in sel:
            push(s.index, rs[s.index].resample(None))
        out = []
        for i, s in zip(indices, sel):
            rate = rates.get(s.index) or int(s.codec_context.sample_rate or 0)
            if not chunks[s.index] or rate <= 0:
                raise RuntimeError(f"Track {i} decoded to zero samples")
            md = dict(s.metadata or {})
            out.append(Track(np.concatenate(chunks[s.index], axis=1).astype(np.float32), rate, _title(s),
                             md.get("language", "")))
        return out


def decode_audio(path: str, track: int = 0) -> Track:
    return decode_tracks(path, [track])[0]


CH_MIX = "mix to mono/stereo"
CH_KEEP = "keep all channels"


def to_output_channels(data: np.ndarray, mode: str = CH_MIX) -> np.ndarray:
    """ComfyUI's AUDIO is effectively mono or stereo: its preview/save nodes write every channel into one
    stereo stream, so 4 or 6 channels play back 2x / 3x too slow. By default more than two channels are mixed to
    mono; CH_KEEP leaves them alone (for nodes that really handle more channels, and for saving)."""
    if mode == CH_KEEP or data.shape[0] <= 2:
        return data
    return data.mean(axis=0, keepdims=True).astype(np.float32)


def crop(track: Track, start_s: float = 0.0, duration_s: float = 0.0) -> Track:
    """duration_s <= 0 means until the end."""
    s = int(start_s * track.sample_rate)
    e = s + int(duration_s * track.sample_rate) if duration_s > 0 else track.samples
    return Track(track.data[:, s:e], track.sample_rate)


def resample(data: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return data
    outs = []
    for ch in data:
        rs = av.AudioResampler(format="fltp", layout="mono", rate=sr_out)
        parts = []
        for pos in range(0, len(ch), 65536):
            blk = np.ascontiguousarray(ch[pos:pos + 65536], dtype=np.float32)[None, :]
            f = av.AudioFrame.from_ndarray(blk, format="fltp", layout="mono")
            f.sample_rate = sr_in
            f.pts = pos
            f.time_base = Fraction(1, sr_in)
            parts += [x.to_ndarray() for x in _as_list(rs.resample(f))]
        parts += [x.to_ndarray() for x in _as_list(rs.resample(None))]
        outs.append(np.concatenate(parts, axis=1)[0])
    n = min(len(o) for o in outs)
    return np.stack([o[:n] for o in outs]).astype(np.float32)


# --------------------------------------------------------------------------- #
# segments (speaker diarization results)
# --------------------------------------------------------------------------- #
def parse_segments(text: str) -> List[Segment]:
    """Accepts JSON [{"start","end","speaker"}], RTTM lines, or 'start end speaker' lines."""
    text = (text or "").strip()
    if not text:
        return []
    segs: List[Segment] = []
    if text[0] in "[{":
        data = json.loads(text)
        if isinstance(data, dict):
            data = data.get("segments", [])
        for d in data:
            spk = d.get("speaker", d.get("label", d.get("spk", "SPEAKER_00")))
            segs.append(Segment(float(d["start"]), float(d["end"]), str(spk)))
        return segs
    for ln, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        tok = [t for t in re.split(r"[,\s]+", line) if t]
        try:
            if tok[0].upper() == "SPEAKER" and len(tok) >= 8:  # RTTM
                start, dur = float(tok[3]), float(tok[4])
                segs.append(Segment(start, start + dur, tok[7]))
            else:
                segs.append(Segment(float(tok[0]), float(tok[1]), tok[2] if len(tok) > 2 else "SPEAKER_00"))
        except (ValueError, IndexError) as e:
            raise ValueError(f"Cannot parse segment on line {ln}: '{line}'") from e
    return segs


def segments_to_json(segs: Sequence[Segment]) -> str:
    return json.dumps([{"start": round(s.start, 3), "end": round(s.end, 3), "speaker": s.speaker}
                       for s in segs], ensure_ascii=False, indent=1)


def parse_name_map(text: str) -> Dict[str, str]:
    """Lines like 'SPEAKER_00=Anna' -> {'SPEAKER_00': 'Anna'} (lines without '=' are ignored)."""
    out: Dict[str, str] = {}
    for line in (text or "").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            if k.strip() and v.strip():
                out[k.strip()] = v.strip()
    return out


def speaker_order(segments: Sequence[Segment]) -> List[str]:
    """Speaker labels in order of first appearance."""
    order: List[str] = []
    for s in sorted(segments, key=lambda s: (s.start, s.end)):
        if s.speaker not in order:
            order.append(s.speaker)
    return order


def limit_speakers(segments: Sequence[Segment], n: int) -> List[str]:
    """First-appearance order, but when there are more than `n` speakers keep the `n` that talk the most."""
    order = speaker_order(segments)
    if len(order) <= n:
        return order
    talk = {sp: 0.0 for sp in order}
    for s in segments:
        talk[s.speaker] += max(0.0, s.end - s.start)
    keep = set(sorted(order, key=lambda sp: -talk[sp])[:n])
    return [sp for sp in order if sp in keep]


def shift_segments(segments: Sequence[Segment], offset: float, length: float) -> List[Segment]:
    """Move segments by `offset` seconds and clip to [0, length]; segments that end up empty are dropped."""
    out = []
    for s in segments:
        a, b = max(0.0, s.start + offset), min(length, s.end + offset)
        if b > a:
            out.append(Segment(a, b, s.speaker))
    return out


def split_by_segments(track: Track, segments: Sequence[Segment], padding_ms: float = 0.0, fade_ms: float = 10.0,
                      speakers: Optional[Sequence[str]] = None) -> List[Track]:
    """One full-length, time-aligned track per speaker; silence where the speaker is quiet.

    `speakers` fixes the order/slots (a listed speaker without segments gets a silent track).
    """
    if not segments and not speakers:
        raise ValueError("No speech segments were found")
    sr, total = track.sample_rate, track.samples
    by: Dict[str, List[Segment]] = {}
    for s in sorted(segments, key=lambda s: (s.start, s.end)):
        by.setdefault(s.speaker, []).append(s)
    order = list(speakers) if speakers is not None else speaker_order(segments)
    pad = int(round(padding_ms * sr / 1000.0))
    fade = int(round(fade_ms * sr / 1000.0))
    out: List[Track] = []
    for spk in order:
        mask = np.zeros(total, np.float32)
        for s in by.get(spk, []):
            a = max(0, int(round(s.start * sr)) - pad)
            b = min(total, int(round(s.end * sr)) + pad)
            n = b - a
            if n <= 0:
                continue
            w = np.ones(n, np.float32)
            f = min(fade, n // 2)
            if f > 0:
                ramp = np.linspace(0.0, 1.0, f, dtype=np.float32)
                w[:f] = ramp
                w[n - f:] = ramp[::-1]
            mask[a:b] = np.maximum(mask[a:b], w)
        out.append(Track(track.data * mask[None, :], sr))
    return out


# --------------------------------------------------------------------------- #
# sections: the parts of the source that are kept, in output order
# --------------------------------------------------------------------------- #
def normalize_sections(sections, duration: float) -> List[Tuple[float, float]]:
    """Valid (start, end) pairs inside [0, duration], in the given (= output) order. Empty -> the whole source."""
    out: List[Tuple[float, float]] = []
    for sec in sections or []:
        a, b = max(0.0, float(sec[0])), min(float(duration), float(sec[1]))
        if b - a >= 1e-3:
            out.append((a, b))
    return out or [(0.0, float(duration))]


def section_layout(sections, sr: int, total: int) -> List[Tuple[int, int, int]]:
    """[(first_sample, end_sample, program_offset_sample)] on the sample grid of a track with `total` samples."""
    out, p = [], 0
    for a, b in sections:
        i0, i1 = int(round(a * sr)), int(round(b * sr))
        i0, i1 = max(0, min(i0, total)), max(0, min(i1, total))
        if i1 > i0:
            out.append((i0, i1, p))
            p += i1 - i0
    return out


def apply_sections(track: Track, sections) -> Track:
    """The program: the sections of the track joined in order. A single section covering the whole track
    returns the track itself, sample for sample (nothing may change the length when nothing was cut)."""
    lay = section_layout(sections, track.sample_rate, track.samples)
    if len(lay) == 1 and lay[0][0] == 0 and lay[0][1] == track.samples:
        return track
    if not lay:
        raise ValueError("The sections are empty")
    data = np.concatenate([track.data[:, i0:i1] for i0, i1, _ in lay], axis=1)
    return Track(data, track.sample_rate, track.title, track.language)


def clips_to_program(clips: Sequence[Segment], layout, sr: int) -> List[Segment]:
    """Source-time clips -> program time (clipped to the sections, and moved to where the sections ended up)."""
    out = []
    for i0, i1, p0 in layout:
        s, e, P = i0 / sr, i1 / sr, p0 / sr
        for c in clips:
            a, b = max(c.start, s), min(c.end, e)
            if b > a:
                out.append(Segment(P + (a - s), P + (b - s), c.speaker))
    return out


def program_to_source(segs: Sequence[Segment], layout, sr: int) -> List[Segment]:
    """Program-time segments -> source time; a segment that spans a join is split at it."""
    out = []
    for i0, i1, p0 in layout:
        s, P, L = i0 / sr, p0 / sr, (i1 - i0) / sr
        for g in segs:
            a, b = max(g.start, P), min(g.end, P + L)
            if b > a:
                out.append(Segment(s + (a - P), s + (b - P), g.speaker))
    return sorted(out, key=lambda x: (x.start, x.end))


# --------------------------------------------------------------------------- #
# writing (one audio stream per track: mov / mka)
# --------------------------------------------------------------------------- #
CHUNK = 4096
# bit depth -> (ffmpeg codec, sample format fed to the encoder)
BIT_DEPTHS = {"16": ("pcm_s16le", "s16"), "24": ("pcm_s24le", "s32"), "32f": ("pcm_f32le", "flt")}
SAMPLE_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000]


def _layout_for(n: int) -> str:
    return {1: "mono", 2: "stereo", 3: "3.0", 4: "quad", 6: "5.1", 8: "7.1"}.get(n, f"{n}c")


def _pack(block: np.ndarray, sample_fmt: str) -> np.ndarray:
    inter = np.ascontiguousarray(block.T).reshape(1, -1)  # interleaved [1, T*C]
    x = np.clip(inter, -1.0, 1.0)
    if sample_fmt == "s16":
        return np.rint(x * 32767.0).astype(np.int16)
    if sample_fmt == "s32":
        return np.rint(x.astype(np.float64) * 2147483647.0).astype(np.int32)
    return x.astype(np.float32)


def write_multistream(path: str, tracks: Sequence[Track], container: str = "matroska", bit_depth: str = "24",
                      sample_rate: Optional[int] = None, mono: bool = False) -> List[dict]:
    """One audio stream per track. Tracks keep their own length (nothing is padded or stretched); with `sample_rate`
    every track is converted to it (same duration, fewer/more samples), without it each keeps its own rate."""
    if not tracks:
        raise ValueError("No tracks to save")
    codec, sample_fmt = BIT_DEPTHS[bit_depth]
    prepared = []
    for t in tracks:
        d = t.data.mean(axis=0, keepdims=True).astype(np.float32) if mono and t.channels > 1 else t.data
        sr = int(sample_rate) if sample_rate else t.sample_rate
        if sr != t.sample_rate:
            d = resample(d, t.sample_rate, sr)
        prepared.append((d, sr, t.title))
    out = av.open(path, "w", format=container)
    try:
        streams, layouts = [], []
        for i, (d, sr, title) in enumerate(prepared):
            st = out.add_stream(codec, rate=sr)
            layout = _layout_for(d.shape[0])
            st.codec_context.layout = layout
            st.codec_context.format = sample_fmt
            st.metadata["title"] = title or f"Track {i + 1}"
            st.metadata["handler_name"] = title or f"Track {i + 1}"
            streams.append(st)
            layouts.append(layout)
        longest = max(d.shape[1] for d, _, _ in prepared)
        for pos in range(0, longest, CHUNK):  # round-robin => properly interleaved file
            for (d, sr, _), st, layout in zip(prepared, streams, layouts):
                if pos >= d.shape[1]:
                    continue
                frame = av.AudioFrame.from_ndarray(_pack(d[:, pos:pos + CHUNK], sample_fmt), format=sample_fmt,
                                                   layout=layout)
                frame.sample_rate = sr
                frame.pts = pos
                frame.time_base = Fraction(1, sr)
                for pkt in st.encode(frame):
                    out.mux(pkt)
        for st in streams:
            for pkt in st.encode(None):
                out.mux(pkt)
    finally:
        out.close()
    return [{"title": t, "channels": d.shape[0], "sample_rate": sr, "samples": d.shape[1]} for d, sr, t in prepared]


# --------------------------------------------------------------------------- #
# the edit state written by the timeline widget (hidden `edit` input)
# --------------------------------------------------------------------------- #
def parse_edit(text: str) -> dict:
    """{"sections": [[a, b], ...], "speakers": [{"id", "name"}], "clips": [{"start", "end", "speaker"}]}
    -> {"sections": [(a, b)], "speakers": [(id, name)], "clips": [Segment]}. Empty text = nothing edited yet."""
    text = (text or "").strip()
    out = {"sections": [], "speakers": [], "clips": []}
    if not text:
        return out
    try:
        d = json.loads(text)
        if not isinstance(d, dict):
            raise ValueError("not an object")
        out["sections"] = [(float(a), float(b)) for a, b in d.get("sections", [])]
        out["speakers"] = [(str(s["id"]), str(s.get("name") or s["id"])) for s in d.get("speakers", [])]
        out["clips"] = [Segment(float(c["start"]), float(c["end"]), str(c["speaker"])) for c in d.get("clips", [])
                        if float(c["end"]) > float(c["start"])]
    except (ValueError, KeyError, TypeError) as e:
        raise ValueError(f"The timeline edit data is damaged ({e}). Press Clear in the node.") from e
    known = {sid for sid, _ in out["speakers"]}
    for sid in speaker_order(out["clips"]):  # a clip whose speaker lane is missing still gets one
        if sid not in known:
            out["speakers"].append((sid, sid))
    return out


def dump_edit(sections, speakers, clips) -> str:
    return json.dumps({
        "v": 1,
        "sections": [[round(a, 3), round(b, 3)] for a, b in sections],
        "speakers": [{"id": i, "name": n} for i, n in speakers],
        "clips": [{"start": round(c.start, 3), "end": round(c.end, 3), "speaker": c.speaker} for c in clips],
    }, ensure_ascii=False)
