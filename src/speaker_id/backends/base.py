from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from pathlib import Path
from typing import Protocol, Callable

import numpy as np

ProgressCallback = Callable[[str, int | None, int | None], None]


class ProgressAwareBackend(Protocol):
    """Optional capability; backends without counters remain indeterminate."""

    def set_progress_callback(self, callback: ProgressCallback) -> None: ...


@dataclass(frozen=True)
class Turn:
    start: float
    end: float
    cluster: str

    def __post_init__(self) -> None:
        if not isfinite(self.start) or not isfinite(self.end) or self.start < 0 or self.end <= self.start:
            raise ValueError("Speaker turns require finite, increasing nonnegative timestamps.")
        if not isinstance(self.cluster, str) or not self.cluster:
            raise ValueError("Speaker turns require a cluster label.")


@dataclass(frozen=True)
class DiarizationResult:
    turns: tuple[Turn, ...]
    # A cluster can lack a reliable embedding. Its turns must remain UNKNOWN.
    embeddings: dict[str, np.ndarray]


class Backend(Protocol):
    """One fixed backend per run. All inputs are mono, 16 kHz WAV files."""

    model_id: str

    def embed_enrollment(self, wav_path: Path) -> np.ndarray: ...

    def diarize(
        self, wav_path: Path, *, min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> DiarizationResult: ...
