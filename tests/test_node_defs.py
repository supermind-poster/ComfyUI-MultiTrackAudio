"""Static guard: frontend-special input flags that break custom nodes."""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_no_frontend_special_upload_flags():
    # audio_upload makes the frontend add an AUDIOUPLOAD widget that crashes node creation unless the node
    # is one of the built-in audio nodes. image_upload / video_upload add widgets with their own assumptions.
    code = "\n".join(l for l in (ROOT / "nodes.py").read_text().splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"""["'](audio|image|video|animated_image)_upload["']""", code)


def test_web_extension_files_are_in_place():
    init = (ROOT / "__init__.py").read_text()
    assert 'WEB_DIRECTORY = "./web"' in init
    js = (ROOT / "web" / "mta_timeline.js").read_text()
    assert 'import("../../scripts/app.js")' not in js and '"../../scripts/app.js"' in js   # standard extension imports
    assert (ROOT / "web" / "lib" / "timeline.js").is_file()
    assert "MTA_AudioTimeline" in js and "MTA_AudioTimeline" in (ROOT / "nodes.py").read_text()
