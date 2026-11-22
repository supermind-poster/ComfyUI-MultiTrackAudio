"""media.py / routes.py / the AudioTimeline node (torch + folder_paths stubbed when ComfyUI isn't present)."""
import importlib
import io
import json
import os
import sys
import wave

import numpy as np
import pytest

from support import comfy_preview_duration, ramp, sine, write_wav, write_two_stream_mov

SR = 48000


@pytest.fixture
def env(pkg, tmp_path, monkeypatch):
    fp = sys.modules["folder_paths"]
    if not hasattr(fp, "IN"):
        pytest.skip("running against real folder_paths")
    for attr, sub in (("IN", "in"), ("OUT", "out"), ("TEMP", "temp")):
        monkeypatch.setattr(fp, attr, str(tmp_path / sub))
        os.makedirs(tmp_path / sub)
    mod = lambda n: importlib.import_module(f"{pkg.__name__}.{n}")  # noqa: E731
    return type("Env", (), {"media": mod("media"), "routes": mod("routes"), "nodes": mod("nodes"),
                            "core": mod("core"), "diarize": mod("diarize"), "fp": fp, "tmp": tmp_path})


def make(env, name, data, sr=SR):
    write_wav(os.path.join(env.fp.IN, name), data, sr)
    return name


@pytest.fixture
def dialogue(env):          # 10 s stereo
    return make(env, "dialogue.wav", sine(300, 10.0, ch=2))


@pytest.fixture
def two_tracks(env):        # track 0: 10 s stereo "Mix"; track 1: 10 s mono, different pitch
    write_two_stream_mov(os.path.join(env.fp.IN, "two.mov"), [sine(440, 10.0, ch=2), sine(880, 10.0)])
    return "two.mov"


def audio_dict(data, sr=SR):
    import torch
    return {"waveform": torch.from_numpy(np.ascontiguousarray(data, dtype=np.float32)).unsqueeze(0), "sample_rate": sr}


def run(env, **kw):
    a = dict(audio="", file_path_override="", track_index=0, speakers_from="detected speakers", num_speakers=0,
             save_format="none (preview only)", save_bit_depth="16", save_sample_rate="source (no resampling)",
             filename_prefix="t/x", edit="")
    a.update(kw)
    return env.nodes.AudioTimeline().run(**a)


def out_np(o):
    return o["waveform"].numpy()[0]


def edit(env, sections=None, speakers=(), clips=()):
    S = env.core.Segment
    return env.core.dump_edit(sections or [], list(speakers), [S(*c) for c in clips])


SPK = [("SPEAKER_01", "Anna"), ("SPEAKER_00", "Boris")]
CLIPS = [(0, 2, "SPEAKER_01"), (2, 4, "SPEAKER_00"), (4, 6, "SPEAKER_01")]


# ----------------------------------------------------------------------------------------------- API helpers
def test_probe_lists_all_tracks(env, two_tracks):
    info = env.routes.handle_probe({"file": two_tracks})
    assert [(t["index"], t["channels"]) for t in info["tracks"]] == [(0, 2), (1, 1)]
    assert abs(info["duration"] - 10.0) < 0.1


def test_clean_errors(env, dialogue):
    assert env.media.input_files() == ["dialogue.wav"]
    with pytest.raises(FileNotFoundError):
        env.routes.handle_probe({"file": "nope.wav"})
    with pytest.raises(ValueError, match="No audio file"):
        env.routes.handle_probe({})
    with pytest.raises(IndexError, match="1 audio track"):
        env.routes.handle_peaks({"file": dialogue, "track": "3"})


def test_peaks_wav_slice_cache_and_tracks(env, two_tracks, monkeypatch):
    calls = []
    real = env.media._decode_preview
    monkeypatch.setattr(env.media, "_decode_preview", lambda p, t=0: (calls.append(t), real(p, t))[1])
    pk = env.routes.handle_peaks({"file": two_tracks, "track": "1", "n": "200"})
    assert 190 <= len(pk["max"]) <= 200 and abs(pk["duration"] - 10.0) < 0.1 and 55 <= max(pk["max"]) <= 66
    env.routes.handle_peaks({"file": two_tracks, "track": "1", "start": "1", "end": "2", "n": "50"})
    env.routes.handle_peaks({"file": two_tracks, "track": "0"})
    data = env.routes.handle_wav({"file": two_tracks, "track": "1", "start": "1.0", "end": "3.0"})
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getframerate(), w.getsampwidth()) == (1, 16000, 2)
        assert abs(w.getnframes() - 2 * 16000) <= 2
    assert calls == [1, 0]                                      # each track decoded once, then served from the cache


def test_socket_audio_preview_via_key(env):
    key = env.media.store_input_preview(sine(440, 5.0, ch=2), SR)
    assert env.media.store_input_preview(sine(440, 5.0, ch=2), SR) == key
    assert env.media.store_input_preview(sine(660, 5.0, ch=2), SR) != key
    assert abs(env.routes.handle_peaks({"key": key, "n": "100"})["duration"] - 5.0) < 0.05
    with pytest.raises(FileNotFoundError, match="run the workflow once"):
        env.routes.handle_peaks({"key": "0123456789abcdef0123"})
    with pytest.raises(ValueError, match="Invalid audio key"):
        env.routes.handle_peaks({"key": "../../etc/passwd"})


def test_analysis_runs_on_the_joined_sections_and_maps_back(env, dialogue, monkeypatch):
    seen = {}

    def fake(mono, sr, model, num, mn, mx, excl, dev):         # program time: 0-3 s = section 6-9, 3-5 s = section 1-3
        seen.update(shape=mono.shape, sr=sr, num=num)
        return [env.core.Segment(2.0, 4.0, "SPEAKER_01"), env.core.Segment(0.5, 1.0, "SPEAKER_00")]

    monkeypatch.setattr(env.diarize, "diarize", fake)
    unloaded = []
    monkeypatch.setattr(env.diarize, "unload", lambda: unloaded.append(1))
    res = env.routes.handle_diarize({"file": dialogue, "sections": [[6, 9], [1, 3]], "num_speakers": 2})
    assert seen["sr"] == 16000 and abs(seen["shape"][1] - 5 * 16000) <= 2        # 3 s + 2 s joined
    # program 2-4 s (SPEAKER_01) spans the join at 3 s -> source 8-9 s and 1-2 s; program 0.5-1 s -> source 6.5-7 s
    got = [(c["start"], c["end"], c["speaker"]) for c in res["clips"]]
    assert got == [(1.0, 2.0, "SPEAKER_01"), (6.5, 7.0, "SPEAKER_00"), (8.0, 9.0, "SPEAKER_01")]
    assert res["speakers"] == ["SPEAKER_01", "SPEAKER_00"] and unloaded == [1]
    with pytest.raises(ValueError, match="too short"):
        env.routes.handle_diarize({"file": dialogue, "sections": [[2, 2.2]]})


# ----------------------------------------------------------------------------------------------- the node
def test_node_contract(env):
    cls = env.nodes.AudioTimeline
    assert cls.RETURN_NAMES[:4] == ("timeline", "segments", "saved_paths", "speaker_1")
    assert len(cls.RETURN_TYPES) == len(cls.RETURN_NAMES) == env.nodes.FIXED_OUTPUTS + env.nodes.MAX_SPEAKERS
    assert cls.RETURN_TYPES[:3] == ("AUDIO", "STRING", "STRING") and set(cls.RETURN_TYPES[3:]) == {"AUDIO"}
    req, opt = cls.INPUT_TYPES()["required"], cls.INPUT_TYPES()["optional"]
    assert opt["audio_in"][0] == "AUDIO" and opt["edit"][1]["hidden"]
    assert req["save_format"][0] == ["none (preview only)", "mka (one stream per track)", "mov (one stream per track)"]
    assert req["save_bit_depth"][0] == ["16", "24", "32f"]
    assert "48000" in req["save_sample_rate"][0] and "16000" in req["save_sample_rate"][0]
    assert cls.VALIDATE_INPUTS("", "") != True  # noqa: E712
    assert cls.VALIDATE_INPUTS("", "", audio_in=object()) is True


@pytest.mark.parametrize("channels,rate", [(1, 48000), (2, 44100), (2, 22050), (1, 16000)])
def test_length_and_samples_never_change_without_edits(env, channels, rate):
    """THE invariant: with no sections the outputs are the source, sample for sample, at the same rate."""
    src = ramp(7.3, rate, channels)
    r = run(env, audio_in=audio_dict(src, rate), edit=edit(env, speakers=SPK, clips=[(0, 2, "SPEAKER_01")]))["result"]
    tl = r[0]
    assert tl["sample_rate"] == rate
    np.testing.assert_array_equal(out_np(tl), src)                                  # bit-exact, nothing resampled/cut
    lane = out_np(r[3])
    assert lane.shape == src.shape                                                  # lanes are exactly as long
    # same through a file: decoded samples are untouched too
    name = make(env, "f.wav", src, rate)
    file_out = run(env, audio=name, edit=edit(env, speakers=SPK, clips=CLIPS))["result"][0]
    decoded = env.core.decode_audio(os.path.join(env.fp.IN, name))
    assert file_out["sample_rate"] == decoded.sample_rate == rate
    np.testing.assert_array_equal(out_np(file_out), decoded.data)


def test_lane_audio_is_the_source_masked_in_place(env):
    src = ramp(10.0, SR)
    r = run(env, audio_in=audio_dict(src), edit=edit(env, speakers=SPK, clips=CLIPS))["result"]
    a, b = out_np(r[3]), out_np(r[4])
    assert a.shape == b.shape == src.shape
    np.testing.assert_allclose(a[:, int(0.1 * SR):int(1.9 * SR)], src[:, int(0.1 * SR):int(1.9 * SR)])
    assert np.abs(a[:, int(2.1 * SR):int(3.9 * SR)]).max() == 0 and np.abs(b[:, :int(1.9 * SR)]).max() == 0
    np.testing.assert_allclose(b[:, int(2.1 * SR):int(3.9 * SR)], src[:, int(2.1 * SR):int(3.9 * SR)])
    assert np.abs(a[:, 6 * SR:]).max() == 0                                          # after the last clip: silence
    assert json.loads(r[1])[0] == {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_01", "name": "Anna"}


def test_sections_cut_and_reorder_the_output(env):
    src = ramp(10.0, SR)
    ed = edit(env, sections=[(6, 8), (0, 2)], speakers=SPK, clips=CLIPS + [(7, 9, "SPEAKER_00")])
    r = run(env, audio_in=audio_dict(src), edit=ed)["result"]
    tl = out_np(r[0])
    assert tl.shape[1] == 4 * SR                                                     # exactly the sum of the sections
    np.testing.assert_array_equal(tl[:, :2 * SR], src[:, 6 * SR:8 * SR])             # swapped: 6-8 s first
    np.testing.assert_array_equal(tl[:, 2 * SR:], src[:, :2 * SR])
    a, b = out_np(r[3]), out_np(r[4])
    assert a.shape == b.shape == tl.shape
    assert np.abs(a[:, :2 * SR]).max() == 0                                          # Anna isn't in the 6-8 s section
    np.testing.assert_allclose(a[:, int(2.1 * SR):int(3.9 * SR)], tl[:, int(2.1 * SR):int(3.9 * SR)])  # 0-2 s clip, moved
    np.testing.assert_allclose(b[:, int(1.1 * SR):int(1.9 * SR)], tl[:, int(1.1 * SR):int(1.9 * SR)])  # Boris 7-8 s -> 1-2 s
    segs = json.loads(r[1])
    assert [(s["speaker"], s["start"], s["end"]) for s in segs] == [
        ("SPEAKER_00", 1.0, 2.0), ("SPEAKER_01", 2.0, 4.0)]                          # segments output is in OUTPUT time
    # an unedited whole-source section list behaves like no sections at all
    whole = run(env, audio_in=audio_dict(src), edit=edit(env, sections=[(0, 10)], speakers=SPK))["result"][0]
    np.testing.assert_array_equal(out_np(whole), src)


def test_manual_speaker_without_clips_keeps_its_slot_and_silence(env):
    src = ramp(6.0, SR)
    ed = edit(env, speakers=[("SPEAKER_01", "Anna"), ("MANUAL", "Narrator")], clips=[(0, 2, "SPEAKER_01")])
    r = run(env, audio_in=audio_dict(src), edit=ed)["result"]
    assert np.abs(out_np(r[3])).max() > 0.1 and np.abs(out_np(r[4])).max() == 0
    assert out_np(r[4]).shape == src.shape and not isinstance(r[4], env.nodes.ExecutionBlocker)
    assert all(isinstance(r[i], env.nodes.ExecutionBlocker) for i in range(5, 19))   # no further lanes -> unused outputs


def test_analysis_fallback_when_nothing_was_edited(env, dialogue, monkeypatch):
    got = {}
    S = env.core.Segment
    monkeypatch.setattr(env.nodes.media, "analyze", lambda arr, sections, *a: (
        got.update(sections=sections, a=a), [S(1, 2, "A"), S(2, 3, "B")])[1])
    res = run(env, audio=dialogue, num_speakers=2, edit=edit(env, sections=[(0.5, 5.0)]))
    assert got["sections"] == [(0.5, 5.0)] and got["a"][1] == 2
    r = res["result"]
    assert abs(out_np(r[0]).shape[1] / SR - 4.5) < 1e-3 and np.abs(out_np(r[3])).max() > 0.4
    ed = json.loads(res["ui"]["mta_edit"][0])                                       # adopted by the UI, in SOURCE time
    assert [(c["start"], c["end"], c["speaker"]) for c in ed["clips"]] == [(1.5, 2.5, "A"), (2.5, 3.5, "B")]
    assert [s["id"] for s in ed["speakers"]] == ["A", "B"]


def test_audio_in_socket_mode_and_ui_message(env):
    src = sine(300, 10.0, ch=2)
    res = run(env, audio=None, audio_in=audio_dict(src), edit=edit(env, speakers=SPK, clips=CLIPS))
    info = json.loads(res["ui"]["mta_source"][0])
    assert len(info["key"]) == 24 and info["sample_rate"] == SR and info["channels"] == 2 and info["tracks"] == 1
    assert abs(env.routes.handle_peaks({"key": info["key"]})["duration"] - 10.0) < 0.05
    run(env, audio="missing.wav", audio_in=audio_dict(src), edit=edit(env, speakers=SPK))   # socket wins over a bad file
    with pytest.raises(ValueError, match="several tracks"):
        run(env, audio_in=audio_dict(src), speakers_from="tracks of the file")


@pytest.mark.parametrize("channels", [4, 6])
def test_multichannel_source_does_not_play_back_too_slow(env, channels):
    """Regression: ComfyUI's PreviewAudio writes all channels into ONE stereo stream, so a 4/6 channel AUDIO played
    back 2x/3x too slow. By default every output is mono/stereo and keeps its real duration."""
    src = np.vstack([sine(300 + 40 * i, 6.0) for i in range(channels)])
    assert comfy_preview_duration(src, SR) > 6.0 * (channels / 2) - 0.1               # the raw audio WOULD be slowed
    ed = edit(env, speakers=SPK, clips=CLIPS)
    outs = run(env, audio_in=audio_dict(src), edit=ed)["result"]
    for o in (outs[0], outs[3], outs[4]):
        assert out_np(o).shape[0] in (1, 2)
        assert abs(comfy_preview_duration(out_np(o), o["sample_rate"]) - 6.0) < 0.05
    name = f"{channels}ch.wav"
    write_wav(os.path.join(env.fp.IN, name), src)
    o = run(env, audio=name, edit=ed)["result"][0]
    assert abs(comfy_preview_duration(out_np(o), o["sample_rate"]) - 6.0) < 0.05
    kept = run(env, audio_in=audio_dict(src), edit=ed, multichannel="keep all channels")["result"][0]
    assert out_np(kept).shape[0] == channels                                          # explicit opt-in keeps the channels
    assert out_np(kept).shape[1] == src.shape[1]


def test_tracks_of_the_file_mode(env, two_tracks):
    r = run(env, audio=two_tracks, speakers_from="tracks of the file", track_index=0,
            edit=edit(env, sections=[(1, 3), (5, 6)]))["result"]
    tl, lane = out_np(r[0]), out_np(r[3])
    assert tl.shape == (2, 3 * SR) and lane.shape == (1, 3 * SR)                      # both cut by the same sections
    assert r[1] == "[]" and isinstance(r[4], env.nodes.ExecutionBlocker)
    # the timeline is track 0 (440 Hz), the lane is track 1 (880 Hz)
    f = lambda w: np.fft.rfftfreq(SR, 1 / SR)[np.abs(np.fft.rfft(w[0, :SR])).argmax()]  # noqa: E731
    assert abs(f(tl) - 440) < 3 and abs(f(lane) - 880) < 3
    r2 = run(env, audio=two_tracks, speakers_from="tracks of the file", track_index=1)["result"]
    assert out_np(r2[0]).shape[0] == 1 and out_np(r2[3]).shape[0] == 2                # now track 1 is the timeline


@pytest.mark.parametrize("fmt,ext", [("mka (one stream per track)", ".mka"), ("mov (one stream per track)", ".mov")])
@pytest.mark.parametrize("depth,rate", [("16", "source (no resampling)"), ("24", "44100"), ("32f", "22050"), ("16", "16000")])
def test_saving_keeps_durations_and_applies_quality(env, fmt, ext, depth, rate):
    src = sine(300, 8.0, ch=2)
    r = run(env, audio_in=audio_dict(src), edit=edit(env, sections=[(1, 5)], speakers=SPK, clips=CLIPS),
            save_format=fmt, save_bit_depth=depth, save_sample_rate=rate, filename_prefix="out/d")["result"]
    path = r[2]
    assert path.endswith(ext) and os.path.isfile(path)
    saved = env.core.decode_tracks(path)
    assert [t.title for t in saved] == ["Timeline", "Anna", "Boris"]
    want_rate = SR if rate.startswith("source") else int(rate)
    for t in saved:
        assert t.sample_rate == want_rate
        assert abs(t.duration - 4.0) < 0.002                                         # the 4 s program, whatever the rate


def test_saving_options(env):
    src = np.random.RandomState(2).uniform(-0.3, 0.3, (2, SR * 4)).astype(np.float32)
    ed = edit(env, speakers=SPK, clips=[(0, 2, "SPEAKER_01")])
    big = run(env, audio_in=audio_dict(src), edit=ed, save_format="mka (one stream per track)", save_bit_depth="24")["result"][2]
    small = run(env, audio_in=audio_dict(src), edit=ed, save_format="mka (one stream per track)", save_bit_depth="16",
                save_sample_rate="16000", save_mono=True, save_with_timeline=False)["result"][2]
    assert os.path.getsize(small) < os.path.getsize(big) / 8
    t = env.core.decode_tracks(small)
    assert [x.title for x in t] == ["Anna", "Boris"] and all(x.channels == 1 and x.sample_rate == 16000 for x in t)
    assert run(env, audio_in=audio_dict(src), edit=ed)["result"][2] == ""             # nothing is written by default
    # saving does not touch what the outputs carry
    out = run(env, audio_in=audio_dict(src), edit=ed, save_format="mov (one stream per track)", save_sample_rate="8000")
    np.testing.assert_array_equal(out_np(out["result"][0]), src)


def test_errors(env, dialogue, two_tracks):
    with pytest.raises(ValueError, match="at least 2 audio tracks"):
        run(env, audio=dialogue, speakers_from="tracks of the file")
    with pytest.raises(IndexError, match="2 audio track"):
        run(env, audio=two_tracks, track_index=5, edit=edit(env, speakers=SPK))
    with pytest.raises(ValueError, match="damaged"):
        run(env, audio=dialogue, edit="{nope")
    with pytest.raises(FileNotFoundError):
        run(env, audio="", file_path_override=str(env.tmp / "missing.wav"), edit=edit(env, speakers=SPK))
