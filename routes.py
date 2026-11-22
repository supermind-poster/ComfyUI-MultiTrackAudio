"""HTTP API used by the timeline widget (registered on ComfyUI's PromptServer)."""
from __future__ import annotations

import asyncio
import traceback

from . import core, media


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _i(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _b(v, default=False):
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    return str(v).lower() in ("1", "true", "yes", "on")


# plain functions (easy to test): take query/body dicts, return JSON-able data / bytes ----------------------
def handle_probe(q: dict) -> dict:
    return media.probe_info(media.resolve_path(q.get("file", ""), q.get("path", "")))


def handle_peaks(q: dict) -> dict:
    return media.peaks(media.get_preview(q), _f(q.get("start")), _f(q.get("end")), _i(q.get("n"), 1000))


def handle_wav(q: dict) -> bytes:
    return media.wav_slice(media.get_preview(q), _f(q.get("start")), _f(q.get("end")))


def _sections(v):
    out = []
    for p in v or []:
        try:
            out.append((float(p[0]), float(p[1])))
        except (TypeError, ValueError, IndexError):
            continue
    return out


def handle_diarize(b: dict) -> dict:
    """Analyse the program (the sections joined); the clips come back in SOURCE time, split at the joins."""
    arr = media.get_preview(b)
    sec = core.normalize_sections(_sections(b.get("sections")), len(arr) / media.PREVIEW_SR)
    segs = media.analyze(arr, sec, b.get("model", ""), _i(b.get("num_speakers")), _i(b.get("min_speakers")),
                         _i(b.get("max_speakers")), _b(b.get("exclusive"), True), b.get("device", "auto") or "auto",
                         _b(b.get("keep_model_loaded"), False))
    lay = core.section_layout(sec, media.PREVIEW_SR, len(arr))
    clips = core.program_to_source(segs, lay, media.PREVIEW_SR)
    return {"clips": [{"start": round(s.start, 3), "end": round(s.end, 3), "speaker": s.speaker} for s in clips],
            "speakers": core.speaker_order(clips)}


def register() -> bool:
    """Add the /mta/* routes. Returns False when not running inside ComfyUI."""
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return False
    routes = PromptServer.instance.routes

    async def blocking(fn, *args):
        return await asyncio.get_running_loop().run_in_executor(None, lambda: fn(*args))

    def fail(e: Exception):
        user_error = isinstance(e, (ValueError, IndexError, FileNotFoundError, RuntimeError))
        if not user_error:
            traceback.print_exc()
        return web.json_response({"error": str(e) or e.__class__.__name__}, status=400 if user_error else 500)

    @routes.get("/mta/probe")
    async def _probe(request):
        try:
            return web.json_response(await blocking(handle_probe, dict(request.query)))
        except Exception as e:
            return fail(e)

    @routes.get("/mta/peaks")
    async def _peaks(request):
        try:
            return web.json_response(await blocking(handle_peaks, dict(request.query)))
        except Exception as e:
            return fail(e)

    @routes.get("/mta/wav")
    async def _wav(request):
        try:
            data = await blocking(handle_wav, dict(request.query))
            return web.Response(body=data, content_type="audio/wav")
        except Exception as e:
            return fail(e)

    @routes.post("/mta/diarize")
    async def _diarize(request):
        try:
            return web.json_response(await blocking(handle_diarize, await request.json()))
        except Exception as e:
            return fail(e)

    return True
