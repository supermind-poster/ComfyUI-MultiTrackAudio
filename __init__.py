from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import routes

WEB_DIRECTORY = "./web"  # the timeline widget (JavaScript)

try:
    routes.register()  # /mta/* endpoints used by the widget; a no-op outside ComfyUI
except Exception as _e:  # never break node loading because of the optional UI backend
    print(f"[MultiTrackAudio] could not register the timeline API: {_e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
