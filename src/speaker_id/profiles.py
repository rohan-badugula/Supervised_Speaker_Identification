from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class ProfileBundle:
    embeddings: dict[str, np.ndarray]
    clip_counts: dict[str, int]
    model_id: str

    def __post_init__(self) -> None:
        if not isinstance(self.model_id, str) or not self.model_id.strip() or not self.embeddings:
            raise ValueError("Profiles require a model identity and at least one speaker.")
        dimensions = set()
        for name, embedding in self.embeddings.items():
            vector = np.asarray(embedding)
            if not isinstance(name, str) or not name.strip() or name == "UNKNOWN":
                raise ValueError("Speaker names must be nonempty and cannot be UNKNOWN.")
            if vector.ndim != 1 or not vector.size or not np.all(np.isfinite(vector)):
                raise ValueError("Profile embeddings must be finite, nonempty vectors.")
            if np.linalg.norm(vector) <= 1e-12:
                raise ValueError("Profile embeddings cannot be zero vectors.")
            dimensions.add(vector.size)
        if len(dimensions) != 1 or set(self.clip_counts) != set(self.embeddings):
            raise ValueError("Profiles must have consistent dimensions and clip counts for every speaker.")
        if any(type(value) is not int or value < 1 for value in self.clip_counts.values()):
            raise ValueError("Clip counts must be positive integers.")


def save_profiles(bundle: ProfileBundle, path: Path) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    names = sorted(bundle.embeddings)
    matrix = np.stack([bundle.embeddings[name] for name in names]).astype(np.float32)
    metadata = json.dumps(
        {
            "format_version": 1,
            "names": names,
            "clip_counts": bundle.clip_counts,
            "model_id": bundle.model_id,
        }
    )
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".npz", delete=False) as handle:
            temporary = Path(handle.name)
            np.savez_compressed(handle, embeddings=matrix, metadata=np.array(metadata))
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load_profiles(path: Path) -> ProfileBundle:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Voice profile file not found: {path}")
    with np.load(path, allow_pickle=False) as payload:
        matrix = np.asarray(payload["embeddings"], dtype=np.float32)
        metadata = json.loads(str(payload["metadata"].item()))
    names = metadata["names"]
    if metadata.get("format_version") != 1:
        raise ValueError("Unsupported voice profile format version.")
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
        raise ValueError("Voice profile names are malformed.")
    if len(set(names)) != len(names):
        raise ValueError("Voice profile names must be unique.")
    if matrix.ndim != 2 or matrix.shape[0] != len(names):
        raise ValueError("Voice profile file is malformed.")
    return ProfileBundle(
        embeddings={name: matrix[index] for index, name in enumerate(names)},
        clip_counts={key: int(value) for key, value in metadata["clip_counts"].items()},
        model_id=metadata["model_id"],
    )
