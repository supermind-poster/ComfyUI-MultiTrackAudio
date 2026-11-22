"""The single node of this pack: Audio Timeline.

The interactive timeline (sections, speaker clips, editing) and the dynamic outputs live in web/mta_timeline.js;
this file is what runs when the graph executes.
"""
from __future__ import annotations

import json
import os

import numpy as np
import torch

import folder_paths

from . import core, media
from .core import Track

try:  # silently stops downstream nodes of unused outputs
    from comfy_execution.graph_utils import ExecutionBlocker
except Exception:  # not running inside ComfyUI (tests)
    class ExecutionBlocker:
        def __init__(self, message):
            self.message = message

CATEGORY = "audio"
# Number of lane outputs (speaker_N) the node can have. The UI shows only as many as there are lanes on the timeline
# (outputs are added/removed there). pyannote has no hard speaker limit; this is just the size of the output list.
MAX_SPEAKERS = 16
FIXED_OUTPUTS = 3  # timeline, segments, saved_paths; then speaker_1..

SPK_DETECTED = "detected speakers"
SPK_FILE_TRACKS = "tracks of the file"
SAVE_NONE = "none (preview only)"
SAVE_MKA = "mka (one stream per track)"
SAVE_MOV = "mov (one stream per track)"
RATE_SOURCE = "source (no resampling)"


def _to_comfy_audio(t: Track) -> dict:
    return {"waveform": torch.from_numpy(np.ascontiguousarray(t.data, dtype=np.float32)).unsqueeze(0),
            "sample_rate": int(t.sample_rate)}


def _from_comfy_audio(audio: dict) -> Track:
    w = audio["waveform"]
    if w.dim() == 3:  # [B, C, T]: only the first batch item is used
        w = w[0]
    return Track(w.detach().cpu().float().numpy().copy(), int(audio["sample_rate"]))


class AudioTimeline:
    """Audio on a timeline: pick sections, find/edit speakers, get one audio per lane, optionally save a multi-track file."""

    CATEGORY = CATEGORY
    OUTPUT_NODE = True  # also runs with nothing connected, so the timeline can show a connected input
    FUNCTION = "run"
    RETURN_TYPES = ("AUDIO", "STRING", "STRING") + ("AUDIO",) * MAX_SPEAKERS
    RETURN_NAMES = ("timeline", "segments", "saved_paths") + tuple(f"speaker_{i}" for i in range(1, MAX_SPEAKERS + 1))
    DESCRIPTION = ("Audio from a file or a connected Load Audio node, shown on a timeline: choose sections, detect and "
                   "edit speakers, and get the audio plus one time-aligned audio per speaker (or per file track).")

    @classmethod
    def INPUT_TYPES(cls):
        from .diarize import DEFAULT_MODEL
        return {
            "required": {
                "audio": (media.input_files(), {"tooltip": "Ignored while the audio_in socket is connected"}),
                "file_path_override": ("STRING", {"default": "", "tooltip": "Optional absolute path, used instead "
                                                  "of the file chosen above (ignored with audio_in)"}),
                "track_index": ("INT", {"default": 0, "min": 0, "max": 127,
                                        "tooltip": "Audio track of the file used as the timeline (and analysed)"}),
                "speakers_from": ([SPK_DETECTED, SPK_FILE_TRACKS], {
                    "tooltip": "'detected speakers': split the timeline track by speaker (edit them on the timeline). "
                               "'tracks of the file': the file's other tracks come out as they are"}),
                "num_speakers": ("INT", {"default": 0, "min": 0, "max": 32,
                                         "tooltip": "Exact number of speakers if you know it, 0 = automatic"}),
                "save_format": ([SAVE_NONE, SAVE_MKA, SAVE_MOV], {
                    "tooltip": "Optionally write the timeline + every lane as one multi-track file"}),
                "save_bit_depth": (["16", "24", "32f"], {"default": "16",
                                                         "tooltip": "Bits per sample of the saved file"}),
                "save_sample_rate": ([RATE_SOURCE] + [str(r) for r in core.SAMPLE_RATES], {
                    "tooltip": "Sample rate of the saved file. With the bit depth it sets the bitrate "
                               "(rate x bits x channels). The duration never changes"}),
                "filename_prefix": ("STRING", {"default": "speakers/timeline"}),
            },
            "optional": {
                "audio_in": ("AUDIO", {"tooltip": "Connect e.g. a Load Audio node instead of choosing a file. "
                                                  "Run the workflow once and the timeline appears"}),
                "model": ("STRING", {"default": DEFAULT_MODEL, "advanced": True,
                                     "tooltip": "Hugging Face id, or the folder of a local copy "
                                                "(a copy in ComfyUI/models/pyannote/ is found automatically)"}),
                "min_speakers": ("INT", {"default": 0, "min": 0, "max": 32, "advanced": True}),
                "max_speakers": ("INT", {"default": 0, "min": 0, "max": 32, "advanced": True}),
                "exclusive": ("BOOLEAN", {"default": True, "advanced": True,
                                          "tooltip": "Give overlapped speech to one speaker only "
                                                     "(needs pyannote.audio >= 4)"}),
                "device": (["auto", "cpu"], {"advanced": True}),
                "keep_model_loaded": ("BOOLEAN", {"default": False, "advanced": True,
                                                  "tooltip": "Faster repeated analysis, but keeps the model in memory"}),
                "padding_ms": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2000.0, "step": 10.0, "advanced": True,
                                         "tooltip": "Widen every speaker clip on both sides"}),
                "fade_ms": ("FLOAT", {"default": 10.0, "min": 0.0, "max": 500.0, "step": 1.0, "advanced": True,
                                      "tooltip": "Fade at clip edges to avoid clicks"}),
                "multichannel": ([core.CH_MIX, core.CH_KEEP], {
                    "advanced": True,
                    "tooltip": "ComfyUI's own preview/save nodes only handle mono/stereo: audio with more channels plays "
                               "back too slow there. 'mix' (default) mixes it to mono; 'keep' leaves all channels"}),
                "save_mono": ("BOOLEAN", {"default": False, "advanced": True,
                                          "tooltip": "Mix every saved track to mono (halves the size of stereo)"}),
                "save_with_timeline": ("BOOLEAN", {"default": True, "advanced": True,
                                                   "tooltip": "Put the timeline audio first in the saved file"}),
                # written by the timeline widget; hidden from the node face
                "edit": ("STRING", {"default": "", "multiline": True, "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, audio, file_path_override="", **kwargs):
        return media.file_stamp(audio, file_path_override)

    @classmethod
    def VALIDATE_INPUTS(cls, audio, file_path_override="", **kwargs):
        if kwargs.get("audio_in") is not None or (file_path_override or "").strip():
            return True
        if not audio or not folder_paths.exists_annotated_filepath(audio):
            return f"Invalid audio file: {audio!r}"
        return True

    # ------------------------------------------------------------------------------------------------ #
    def run(self, audio, file_path_override, track_index, speakers_from, num_speakers, save_format, save_bit_depth,
            save_sample_rate, filename_prefix, audio_in=None, model="", min_speakers=0, max_speakers=0, exclusive=True,
            device="auto", keep_model_loaded=False, padding_ms=0.0, fade_ms=10.0, multichannel=core.CH_MIX,
            save_mono=False, save_with_timeline=True, edit=""):
        state = core.parse_edit(edit)
        key, ntracks, ui_extra = "", 1, {}

        if audio_in is not None:  # audio from a connected node
            if speakers_from == SPK_FILE_TRACKS:
                raise ValueError("'tracks of the file' needs a file with several tracks, not a connected audio. "
                                 "Use 'detected speakers'.")
            src = _from_comfy_audio(audio_in)
            key = media.store_input_preview(src.data, src.sample_rate)  # lets the UI show it
            preview = media.get_preview({"key": key})
            file_tracks = None
        else:
            path = media.resolve_path(audio, file_path_override)
            infos = core.probe_tracks(path)
            if not infos:
                raise ValueError("The file has no audio track")
            ntracks = len(infos)
            if not 0 <= track_index < ntracks:
                raise IndexError(f"track_index={track_index} but the file has {ntracks} audio track(s)")
            if speakers_from == SPK_FILE_TRACKS and ntracks < 2:
                raise ValueError("'tracks of the file' needs a file with at least 2 audio tracks "
                                 f"(this one has {ntracks}). Use 'detected speakers' instead.")
            file_tracks = core.decode_tracks(path) if speakers_from == SPK_FILE_TRACKS else None
            src = file_tracks[track_index] if file_tracks else core.decode_audio(path, track_index)
            preview = media.file_preview(path, track_index)
        src_channels = src.channels
        src = Track(core.to_output_channels(src.data, multichannel), src.sample_rate, src.title, src.language)
        sections = core.normalize_sections(state["sections"], src.duration)

        names = []
        if speakers_from == SPK_FILE_TRACKS:
            # every track is cut with the same sections; the chosen one is the timeline, the others are the lanes
            progs = []
            for i, t in enumerate(file_tracks):
                tt = Track(core.to_output_channels(t.data, multichannel), t.sample_rate, t.title or f"track {i}")
                progs.append(core.apply_sections(tt, core.normalize_sections(state["sections"], tt.duration)))
            timeline = progs[track_index]
            lane_tracks = [t for i, t in enumerate(progs) if i != track_index][:MAX_SPEAKERS]
            names = [t.title for t in lane_tracks]
            segs_json = "[]"
        else:
            program = core.apply_sections(src, sections)
            lay = core.section_layout(sections, src.sample_rate, src.samples)
            speakers, clips = list(state["speakers"]), list(state["clips"])
            if not speakers and not clips:  # nothing analysed in the UI yet: do it now
                psegs = media.analyze(preview, sections, model, num_speakers, min_speakers, max_speakers, exclusive,
                                      device, keep_model_loaded)
                if not psegs:
                    raise RuntimeError("No speech was detected")
                order = core.limit_speakers(psegs, MAX_SPEAKERS)
                psegs = [s for s in psegs if s.speaker in order]
                speakers = [(sid, sid) for sid in order]
                clips = core.program_to_source(psegs, core.section_layout(sections, media.PREVIEW_SR, len(preview)),
                                               media.PREVIEW_SR)
                ui_extra["mta_edit"] = [core.dump_edit(state["sections"], speakers, clips)]
            speakers = speakers[:MAX_SPEAKERS]
            ids = [sid for sid, _ in speakers]
            names = [n for _, n in speakers]
            prog_segs = [s for s in core.clips_to_program(clips, lay, src.sample_rate) if s.speaker in ids]
            lane_tracks = core.split_by_segments(program, prog_segs, padding_ms, fade_ms, speakers=ids) if ids else []
            timeline = program
            segs_json = json.dumps([{"start": round(s.start, 3), "end": round(s.end, 3), "speaker": s.speaker,
                                     "name": dict(speakers).get(s.speaker, s.speaker)}
                                    for s in sorted(prog_segs, key=lambda s: (s.start, s.end))], ensure_ascii=False)
        timeline.title = "Timeline"
        for t, n in zip(lane_tracks, names):
            t.title = n

        saved = ""
        if save_format != SAVE_NONE:
            saved = self._save(([timeline] if save_with_timeline else []) + list(lane_tracks), save_format,
                               filename_prefix, save_bit_depth, save_sample_rate, save_mono)

        outs = [_to_comfy_audio(timeline), segs_json, saved]
        for i in range(MAX_SPEAKERS):
            outs.append(_to_comfy_audio(lane_tracks[i]) if i < len(lane_tracks) else ExecutionBlocker(None))
        ui = {"mta_source": [json.dumps({"key": key, "duration": round(src.duration, 3), "sample_rate": src.sample_rate,
                                         "channels": src_channels, "tracks": ntracks})]}
        ui.update(ui_extra)
        return {"ui": ui, "result": tuple(outs)}

    @staticmethod
    def _save(tracks, fmt, prefix, bit_depth, sample_rate, mono) -> str:
        folder, name, counter, _sub, _p = folder_paths.get_save_image_path(prefix, folder_paths.get_output_directory())
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"{name}_{counter:05}_" + (".mka" if fmt == SAVE_MKA else ".mov"))
        rate = None if sample_rate == RATE_SOURCE else int(sample_rate)
        core.write_multistream(path, tracks, "matroska" if fmt == SAVE_MKA else "mov", bit_depth, rate, mono)
        print(f"[MultiTrackAudio] saved {len(tracks)} track(s): {path}")
        return path


NODE_CLASS_MAPPINGS = {"MTA_AudioTimeline": AudioTimeline}
NODE_DISPLAY_NAME_MAPPINGS = {"MTA_AudioTimeline": "Audio Timeline"}
