from __future__ import annotations

import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import uuid4

import numpy as np

from .backends import Backend
from .matching import centroid, match_embedding
from .media import SUPPORTED_MEDIA, convert_to_wav
from .profiles import ProfileBundle
from .reporting import build_summary


def resolve_token(explicit_token: str | None) -> str:
    token = explicit_token or os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError(
            "A Hugging Face token is required for the initial model download. "
            "Accept the pyannote community-1 model terms, then set HF_TOKEN."
        )
    return token


def discover_enrollment_files(root: Path) -> dict[str, list[Path]]:
    root = root.expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Enrollment directory not found: {root}")

    speakers: dict[str, list[Path]] = {}
    for directory in sorted(item for item in root.iterdir() if item.is_dir()):
        clips = sorted(
            item for item in directory.rglob("*")
            if item.is_file() and item.suffix.lower() in SUPPORTED_MEDIA
        )
        if clips:
            speakers[directory.name] = clips
    if not speakers:
        raise ValueError(
            "No enrollment clips found. Expected folders such as "
            "`data/enrollment/Alice/clip-01.wav`."
        )
    return speakers


def enroll_speakers(
    backend: Backend,
    enrollment_root: Path,
) -> ProfileBundle:
    speaker_files = discover_enrollment_files(enrollment_root)
    profiles: dict[str, np.ndarray] = {}
    clip_counts: dict[str, int] = {}

    with tempfile.TemporaryDirectory(prefix="voice-id-enroll-") as temp_dir:
        temp_root = Path(temp_dir)
        for speaker, clips in speaker_files.items():
            embeddings: list[np.ndarray] = []
            for index, clip in enumerate(clips):
                wav_path = convert_to_wav(clip, temp_root / speaker / f"{index:03d}.wav")
                embeddings.append(backend.embed_enrollment(wav_path))
            profiles[speaker] = centroid(embeddings)
            clip_counts[speaker] = len(embeddings)

    return ProfileBundle(embeddings=profiles, clip_counts=clip_counts, model_id=backend.model_id)


def identify_speakers(
    backend: Backend,
    source: Path,
    profiles: ProfileBundle,
    *,
    threshold: float = 0.55,
    minimum_margin: float = 0.08,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
) -> dict[str, Any]:
    if backend.model_id != profiles.model_id:
        raise ValueError(
            f"Profile model {profiles.model_id!r} does not match selected backend "
            f"{backend.model_id!r}. Re-enroll this roster using the selected model."
        )
    if not -1 <= threshold <= 1 or not 0 <= minimum_margin <= 2:
        raise ValueError("Threshold must be in [-1, 1] and margin in [0, 2].")
    if any(value is not None and value < 1 for value in (min_speakers, max_speakers)):
        raise ValueError("Speaker bounds must be positive.")
    if min_speakers is not None and max_speakers is not None and min_speakers > max_speakers:
        raise ValueError("Minimum speakers must not exceed maximum speakers.")
    started_at = datetime.now(timezone.utc).isoformat()
    started = perf_counter()
    with tempfile.TemporaryDirectory(prefix="voice-id-target-") as temp_dir:
        wav_path = convert_to_wav(source, Path(temp_dir) / "target.wav")
        output = backend.diarize(wav_path, min_speakers=min_speakers, max_speakers=max_speakers)

    cluster_matches = {
        label: match_embedding(
            embedding,
            profiles.embeddings,
            threshold=threshold,
            minimum_margin=minimum_margin,
        )
        for label, embedding in output.embeddings.items()
    }

    segments: list[dict[str, Any]] = []
    for turn in sorted(output.turns, key=lambda item: (item.start, item.end, item.cluster)):
        cluster = turn.cluster
        match = cluster_matches.get(cluster)
        segments.append(
            {
                "start": round(float(turn.start), 3),
                "end": round(float(turn.end), 3),
                "duration": round(float(turn.end - turn.start), 3),
                "speaker": match.speaker if match else "UNKNOWN",
                "cluster": str(cluster),
                "similarity": round(match.similarity, 4) if match else None,
                "margin": round(match.margin, 4) if match else None,
            }
        )

    return {
        "schema_version": 2,
        "run": {
            "id": str(uuid4()),
            "started_at": started_at,
            "processing_seconds": round(perf_counter() - started, 3),
            "min_speakers": min_speakers,
            "max_speakers": max_speakers,
        },
        "source": str(source.expanduser().resolve()),
        "model": profiles.model_id,
        "matching": {
            "threshold": threshold,
            "minimum_margin": minimum_margin,
            "unknown_label": "UNKNOWN",
        },
        "enrolled_speakers": sorted(profiles.embeddings),
        "summary_seconds": build_summary(segments),
        "segments": segments,
    }
