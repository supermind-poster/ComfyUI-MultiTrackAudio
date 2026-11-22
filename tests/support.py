"""Helpers that create small media files for the tests."""
import io
from fractions import Fraction

import av
import numpy as np
import soundfile as sf


def sine(freq, secs, ch=1, amp=0.5, sr=48000):
    t = np.arange(int(secs * sr)) / sr
    return np.tile((amp * np.sin(2 * np.pi * freq * t)).astype(np.float32), (ch, 1))


def ramp(secs, sr=48000, ch=1):
    """A slow ramp: every sample position has its own value, so moved/cut audio can be verified exactly."""
    n = int(secs * sr)
    return np.tile(np.linspace(-0.9, 0.9, n, dtype=np.float32), (ch, 1))


def write_wav(path, data, sr=48000, subtype="PCM_16"):
    sf.write(path, data.T, sr, subtype=subtype, format="WAV")


def write_two_stream_mov(path, tracks, sr=48000):
    """tracks: list of float arrays [C, T]; one PCM stream per track."""
    out = av.open(path, "w", format="mov")
    streams = []
    for t in tracks:
        st = out.add_stream("pcm_s16le", rate=sr)
        st.codec_context.layout = "mono" if t.shape[0] == 1 else "stereo"
        st.codec_context.format = "s16"
        streams.append(st)
    n = max(t.shape[1] for t in tracks)
    for pos in range(0, n, 4096):
        for t, st in zip(tracks, streams):
            blk = np.clip(t[:, pos:pos + 4096], -1, 1)
            if blk.shape[1] == 0:
                continue
            inter = np.rint(np.ascontiguousarray(blk.T).reshape(1, -1) * 32767).astype(np.int16)
            fr = av.AudioFrame.from_ndarray(inter, format="s16", layout="mono" if t.shape[0] == 1 else "stereo")
            fr.sample_rate, fr.pts, fr.time_base = sr, pos, Fraction(1, sr)
            for pkt in st.encode(fr):
                out.mux(pkt)
    for st in streams:
        for pkt in st.encode(None):
            out.mux(pkt)
    out.close()


def comfy_preview_duration(waveform, sample_rate):
    """How long ComfyUI's PreviewAudio / SaveAudio output plays: a copy of the encoding step of
    comfy_api/latest/_ui.py (layout mono for 1 channel, else stereo; all channels interleaved into one frame)."""
    layout = "mono" if waveform.shape[0] == 1 else "stereo"
    buf = io.BytesIO()
    out = av.open(buf, mode="w", format="flac")
    st = out.add_stream("flac", rate=sample_rate, layout=layout)
    frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(waveform.T).reshape(1, -1).astype(np.float32),
                                       format="flt", layout=layout)
    frame.sample_rate = sample_rate
    frame.pts = 0
    out.mux(st.encode(frame))
    out.mux(st.encode(None))
    out.close()
    buf.seek(0)
    with av.open(buf) as c:
        s = c.streams.audio[0]
        return sum(f.samples for f in c.decode(s)) / s.codec_context.sample_rate
