import importlib.util
import pathlib
import sys

import numpy as np
import pytest

from support import sine, write_wav, write_two_stream_mov, ramp

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mta_core", ROOT / "core.py")
core = importlib.util.module_from_spec(spec)
sys.modules["mta_core"] = core
spec.loader.exec_module(core)


def dominant_freq(x, sr):
    spec_ = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    return np.fft.rfftfreq(len(x), 1 / sr)[spec_.argmax()]


# ----------------------------------------------------------------------------------------------- reading
def test_decode_stereo_wav_keeps_rate_and_channels(tmp_path):
    p = str(tmp_path / "a.wav")
    write_wav(p, sine(440, 2.0, ch=2, sr=44100), 44100)
    t = core.decode_audio(p)
    assert (t.sample_rate, t.channels) == (44100, 2)
    assert abs(t.duration - 2.0) < 0.01
    assert abs(dominant_freq(t.data[0, :44100], 44100) - 440) < 3


def test_decode_uses_the_first_track_of_a_multi_track_file(tmp_path):
    p = str(tmp_path / "m.mov")
    write_two_stream_mov(p, [sine(440, 2.0, ch=2), sine(880, 2.0)])
    t = core.decode_audio(p)
    assert t.channels == 2 and abs(dominant_freq(t.data[0, :48000], 48000) - 440) < 3


def test_multichannel_is_mixed_to_mono_for_output(tmp_path):
    p = str(tmp_path / "six.wav")
    write_wav(p, np.vstack([sine(300 + 50 * i, 1.0) for i in range(6)]))
    t = core.decode_audio(p)
    assert t.channels == 6                                     # decoded as it is
    assert core.to_output_channels(t.data).shape == (1, t.samples)
    st = core.to_output_channels(sine(300, 1.0, ch=2))
    assert st.shape[0] == 2                                    # mono/stereo untouched
    assert core.to_output_channels(sine(300, 1.0)).shape[0] == 1


def test_invalid_file_raises(tmp_path):
    p = tmp_path / "x.wav"
    p.write_bytes(b"not audio")
    with pytest.raises(Exception):
        core.decode_audio(str(p))


# ----------------------------------------------------------------------------------------------- processing
def test_crop_and_resample():
    t = core.Track(sine(500, 4.0, ch=2), 48000)
    c = core.crop(t, 1.0, 2.0)
    assert abs(c.duration - 2.0) < 1e-3 and c.channels == 2
    assert abs(core.crop(t, 3.0, 0).duration - 1.0) < 1e-3          # 0 = until the end
    r = core.resample(t.data[:, :48000], 48000, 16000)
    assert r.shape[0] == 2 and abs(r.shape[1] - 16000) <= 4
    assert abs(dominant_freq(r[0], 16000) - 500) < 3


# ----------------------------------------------------------------------------------------------- segments
def test_parse_segments_formats():
    a = core.parse_segments("0.0 1.5 SPEAKER_00\n1.5, 3.0, SPEAKER_01\n# comment\n")
    assert [(s.start, s.end, s.speaker) for s in a] == [(0.0, 1.5, "SPEAKER_00"), (1.5, 3.0, "SPEAKER_01")]
    b = core.parse_segments(core.segments_to_json(a))
    assert [(s.start, s.end, s.speaker) for s in b] == [(s.start, s.end, s.speaker) for s in a]
    r = core.parse_segments("SPEAKER f 1 2.00 3.00 <NA> <NA> alice <NA> <NA>")
    assert (r[0].start, r[0].end, r[0].speaker) == (2.0, 5.0, "alice")
    assert core.parse_segments("") == []
    with pytest.raises(ValueError, match="line 1"):
        core.parse_segments("foo bar")


def test_name_map_order_limit_shift():
    assert core.parse_name_map("A=Anna\nbroken\nB = Boris \n=x") == {"A": "Anna", "B": "Boris"}
    S = core.Segment
    segs = [S(0, 1, "B"), S(1, 2, "A"), S(2, 9, "C"), S(9, 10, "B")]
    assert core.speaker_order(segs) == ["B", "A", "C"]
    assert core.limit_speakers(segs, 2) == ["B", "C"]               # C talks most, then B; order kept
    sh = core.shift_segments(segs, -1.5, 5.0)
    assert [(s.speaker, s.start, s.end) for s in sh] == [("A", 0.0, 0.5), ("C", 0.5, 5.0)]


def test_split_by_segments_is_time_aligned_and_sums_back():
    sr = 16000
    x = core.Track(sine(500, 4.0, ch=2, sr=sr), sr)
    segs = core.parse_segments("0 1 A\n1 2 B\n2 3 A\n3 4 B")
    out = core.split_by_segments(x, segs, padding_ms=0, fade_ms=0)
    assert len(out) == 2 and all(t.samples == x.samples and t.channels == 2 for t in out)
    a, b = out[0].data, out[1].data
    assert np.abs(a[:, sr:2 * sr]).max() == 0 and np.abs(a[:, :sr]).max() > 0.4
    assert np.abs(b[:, :sr]).max() == 0 and np.abs(b[:, sr:2 * sr]).max() > 0.4
    np.testing.assert_allclose(a + b, x.data, atol=1e-6)


def test_split_fade_padding_and_explicit_slots():
    sr = 16000
    x = core.Track(sine(500, 2.0, sr=sr), sr)
    out = core.split_by_segments(x, [core.Segment(0.5, 1.0, "A")], padding_ms=100, fade_ms=20)
    d = out[0].data[0]
    assert np.abs(d[:int(0.4 * sr) - 1]).max() == 0 and np.abs(d[int(1.1 * sr) + 1:]).max() == 0
    assert abs(d[int(0.4 * sr)]) < 1e-3 and np.abs(d[int(0.6 * sr):int(0.9 * sr)]).max() > 0.4
    slots = core.split_by_segments(x, [core.Segment(0.5, 1.0, "A")], speakers=["B", "A"])   # B never speaks
    assert np.abs(slots[0].data).max() == 0 and np.abs(slots[1].data).max() > 0.4
    with pytest.raises(ValueError):
        core.split_by_segments(x, [])


# ----------------------------------------------------------------------------------------------- tracks
def test_probe_and_decode_tracks(tmp_path):
    p = str(tmp_path / "m.mov")
    write_two_stream_mov(p, [sine(440, 2.0, ch=2), sine(880, 3.0)])
    info = core.probe_tracks(p)
    assert [(t["index"], t["channels"]) for t in info] == [(0, 2), (1, 1)]
    both = core.decode_tracks(p)
    assert [t.channels for t in both] == [2, 1] and abs(both[1].duration - 3.0) < 0.01
    assert abs(dominant_freq(both[1].data[0, :48000], 48000) - 880) < 3
    assert core.decode_audio(p, 1).channels == 1
    with pytest.raises(IndexError, match="2 audio track"):
        core.decode_audio(p, 4)


def test_channel_policy():
    six = np.vstack([sine(300 + 10 * i, 0.5) for i in range(6)])
    assert core.to_output_channels(six).shape[0] == 1                       # default: mix down
    assert core.to_output_channels(six, core.CH_KEEP).shape[0] == 6          # opt-in
    assert core.to_output_channels(sine(300, 0.5, ch=2)).shape[0] == 2


# ----------------------------------------------------------------------------------------------- sections
def test_sections_validation_and_whole_source_identity():
    assert core.normalize_sections([], 10.0) == [(0.0, 10.0)]
    assert core.normalize_sections([(-3, 2), (4, 99), (5, 5.0001)], 10.0) == [(0.0, 2.0), (4.0, 10.0)]
    t = core.Track(ramp(10.0, 22050), 22050)
    assert core.apply_sections(t, [(0.0, 10.0)]) is t                         # nothing cut: the very same samples
    assert core.apply_sections(t, [(0.0, 99.0)] and core.normalize_sections([(0, 99)], 10.0)) is t


def test_sections_are_joined_in_the_given_order_sample_exactly():
    sr = 16000
    t = core.Track(ramp(10.0, sr), sr)
    prog = core.apply_sections(t, [(6.0, 8.0), (0.0, 2.0), (4.0, 5.0)])
    assert prog.samples == 5 * sr and prog.sample_rate == sr
    np.testing.assert_array_equal(prog.data[:, :2 * sr], t.data[:, 6 * sr:8 * sr])
    np.testing.assert_array_equal(prog.data[:, 2 * sr:4 * sr], t.data[:, :2 * sr])
    np.testing.assert_array_equal(prog.data[:, 4 * sr:], t.data[:, 4 * sr:5 * sr])
    with pytest.raises(ValueError):
        core.apply_sections(t, [])


def test_clips_follow_their_sections_and_map_back():
    sr = 1000
    S = core.Segment
    lay = core.section_layout([(6.0, 8.0), (0.0, 2.0)], sr, 10 * sr)         # swapped order
    clips = [S(0.5, 1.5, "A"), S(7.0, 9.0, "B"), S(3.0, 4.0, "A")]
    prog = core.clips_to_program(clips, lay, sr)
    got = sorted((round(g.start, 3), round(g.end, 3), g.speaker) for g in prog)
    # section 6-8 s comes first: B (7-8 s) lands at 1-2 s; section 0-2 s starts at 2 s: A (0.5-1.5 s) -> 2.5-3.5 s; 3-4 s is cut
    assert got == [(1.0, 2.0, "B"), (2.5, 3.5, "A")]
    back = core.program_to_source([S(1.5, 2.5, "X")], lay, sr)  # spans the join between the two sections
    assert [(round(b.start, 3), round(b.end, 3)) for b in back] == [(0.0, 0.5), (7.5, 8.0)]


# ----------------------------------------------------------------------------------------------- the edit state
def test_edit_state_roundtrip_and_errors():
    S = core.Segment
    txt = core.dump_edit([(1, 2), (5, 6)], [("A", "Anna"), ("B", "B")], [S(1, 1.5, "A"), S(5, 5.5, "C")])
    st = core.parse_edit(txt)
    assert st["sections"] == [(1.0, 2.0), (5.0, 6.0)]
    assert st["speakers"] == [("A", "Anna"), ("B", "B"), ("C", "C")]        # a clip's speaker without a lane gets one
    assert [(c.start, c.end, c.speaker) for c in st["clips"]] == [(1.0, 1.5, "A"), (5.0, 5.5, "C")]
    assert core.parse_edit("") == {"sections": [], "speakers": [], "clips": []}
    with pytest.raises(ValueError, match="damaged"):
        core.parse_edit("{oops")


# ----------------------------------------------------------------------------------------------- writing
def mk_tracks():
    return [core.Track(sine(440, 3.0, ch=2), 48000, "Timeline"), core.Track(sine(880, 3.0), 48000, "Anna"),
            core.Track(sine(220, 1.5), 48000, "Short")]               # the last one is shorter


@pytest.mark.parametrize("container,ext", [("matroska", ".mka"), ("mov", ".mov")])
@pytest.mark.parametrize("depth", ["16", "24", "32f"])
@pytest.mark.parametrize("rate", [None, 16000, 22050, 44100, 96000])
def test_written_tracks_keep_their_duration(tmp_path, container, ext, depth, rate):
    p = str(tmp_path / f"o{ext}")
    tr = mk_tracks()
    info = core.write_multistream(p, tr, container, depth, rate)
    assert [i["title"] for i in info] == ["Timeline", "Anna", "Short"]
    back = core.decode_tracks(p)
    assert len(back) == 3 and [t.title for t in back] == ["Timeline", "Anna", "Short"]
    for a, b in zip(tr, back):
        assert b.sample_rate == (rate or 48000)
        assert abs(b.duration - a.duration) < 0.002, (a.title, a.duration, b.duration)   # same length in seconds
        assert b.channels == a.channels                                                   # no padding, no mixing
    assert abs(dominant_freq(back[1].data[0, :int(back[1].sample_rate)], back[1].sample_rate) - 880) < 4


def test_quality_settings_shrink_the_file(tmp_path):
    tr = [core.Track(np.random.RandomState(1).uniform(-0.3, 0.3, (2, 48000 * 4)).astype(np.float32), 48000, "n")]
    size = {}
    for name, (depth, rate, mono) in {"hi": ("24", None, False), "mid": ("16", 22050, False),
                                      "lo": ("16", 16000, True)}.items():
        p = str(tmp_path / f"{name}.mka")
        core.write_multistream(p, tr, "matroska", depth, rate, mono)
        size[name] = (tmp_path / f"{name}.mka").stat().st_size
    assert size["hi"] > size["mid"] > size["lo"]
    assert size["lo"] < size["hi"] / 8                    # 24/48k stereo vs 16/16k mono: 9x less data
    assert core.decode_tracks(str(tmp_path / "lo.mka"))[0].channels == 1
