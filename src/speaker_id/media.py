from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


SUPPORTED_MEDIA = {".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".mp4", ".mov", ".mkv", ".webm"}


def require_ffmpeg() -> str:
    executable = shutil.which("ffmpeg")
    if executable:
        return executable
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        return get_ffmpeg_exe()
    except (ImportError, RuntimeError, OSError) as error:
        raise RuntimeError(
            "FFmpeg is required. Install this project's audio extra with "
            "`python -m pip install -e '.[audio]'`, then restart the workbench."
        ) from error


def convert_to_wav(source: Path, destination: Path) -> Path:
    source = source.expanduser().resolve()
    destination = destination.expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Media file not found: {source}")
    if source.suffix.lower() not in SUPPORTED_MEDIA:
        raise ValueError(f"Unsupported media extension: {source.suffix}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [
        require_ffmpeg(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(destination),
    ]
    subprocess.run(command, check=True)
    return destination
