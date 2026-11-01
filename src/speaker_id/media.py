from __future__ import annotations

import shutil
import subprocess
import math
import wave
from dataclasses import dataclass
from pathlib import Path


SUPPORTED_MEDIA = {".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".mp4", ".mov", ".mkv", ".webm"}


@dataclass(frozen=True)
class AnalysisRange:
    start_seconds: float = 0.0
    duration_seconds: float | None = None

    def __post_init__(self):
        if not math.isfinite(self.start_seconds) or self.start_seconds < 0:
            raise ValueError("Analysis start must be finite and at least zero.")
        if self.duration_seconds is not None and (
            not math.isfinite(self.duration_seconds) or self.duration_seconds <= 0
        ):
            raise ValueError("Analysis duration must be finite and greater than zero. Choose Full recording for no limit.")

    @property
    def is_full(self):
        return self.start_seconds == 0 and self.duration_seconds is None

    def metadata(self, actual_duration=None):
        return {"start_seconds": self.start_seconds, "duration_seconds": actual_duration,
                "end_seconds": self.start_seconds + actual_duration if actual_duration is not None else None,
                "requested_duration_seconds": self.duration_seconds, "full_recording": self.is_full}


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


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


def convert_to_wav(source: Path, destination: Path, *, start_seconds: float = 0,
                   duration_seconds: float | None = None) -> Path:
    window = AnalysisRange(start_seconds, duration_seconds)
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
    ]
    # Seek while decoding and limit extraction, so preview runs do not process
    # the rest of an hour-long recording before reaching the model.
    if window.start_seconds:
        command.extend(["-ss", str(window.start_seconds)])
    command.extend(["-i", str(source)])
    if window.duration_seconds is not None:
        command.extend(["-t", str(window.duration_seconds)])
    command.extend([
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(destination),
    ])
    subprocess.run(command, check=True)
    return destination
