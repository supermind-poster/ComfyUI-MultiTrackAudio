#!/usr/bin/env python3
"""Download the (gated) pyannote diarization pipeline into ComfyUI/models/pyannote/<name>.

After that the "Speaker Diarize" node finds it automatically (leave `model` at its default) and works offline.

Before running:
  1. open https://huggingface.co/pyannote/speaker-diarization-community-1 and accept the conditions
  2. create an access token (Settings -> Access Tokens, "Read" is enough)

Windows portable ComfyUI (run from anywhere):
  python_embeded\\python.exe ComfyUI\\custom_nodes\\ComfyUI-MultiTrackAudio\\tools\\download_model.py --token hf_xxx

The token can also come from the HF_TOKEN environment variable or a previous `huggingface-cli login`.
"""
import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default="pyannote/speaker-diarization-community-1")
    ap.add_argument("--dest", help="target folder (default: <ComfyUI>/models/pyannote/<repo name>)")
    ap.add_argument("--token", help="Hugging Face access token (default: HF_TOKEN or saved login)")
    a = ap.parse_args()

    try:
        from huggingface_hub import get_token, snapshot_download
    except ImportError:
        print("huggingface_hub is missing: python -m pip install huggingface_hub")
        return 1

    token = a.token or os.environ.get("HF_TOKEN") or get_token()
    if not token:
        print("No Hugging Face token. Pass --token hf_xxx, set HF_TOKEN, or run `huggingface-cli login`.")
        return 1

    # this file: <ComfyUI>/custom_nodes/ComfyUI-MultiTrackAudio/tools/download_model.py
    dest = Path(a.dest) if a.dest else Path(__file__).resolve().parents[3] / "models" / "pyannote" / a.repo.split("/")[-1]
    dest.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {a.repo} -> {dest}")
    try:
        snapshot_download(a.repo, local_dir=str(dest), token=token)
    except Exception as e:  # gated / wrong token / offline
        print(f"\nDownload failed: {e}\n"
              f"Did you accept the conditions at https://huggingface.co/{a.repo} with the SAME account as the token?")
        return 1
    if not (dest / "config.yaml").is_file():
        print(f"Downloaded, but {dest} has no config.yaml: wrong repo?")
        return 1
    print("\nDone. In the node leave `model` at its default, or set it to:\n  " + str(dest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
