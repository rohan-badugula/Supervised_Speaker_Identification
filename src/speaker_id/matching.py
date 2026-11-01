from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Match:
    speaker: str
    similarity: float
    second_best_similarity: float
    margin: float
    accepted: bool


def normalize(vector: np.ndarray) -> np.ndarray:
    value = np.asarray(vector, dtype=np.float32).reshape(-1)
    magnitude = float(np.linalg.norm(value))
    if not np.all(np.isfinite(value)) or not np.isfinite(magnitude) or magnitude <= 1e-12:
        raise ValueError("Cannot normalize an empty or zero-length voice embedding.")
    return value / magnitude


def centroid(embeddings: list[np.ndarray]) -> np.ndarray:
    if not embeddings:
        raise ValueError("At least one enrollment embedding is required.")
    normalized = np.stack([normalize(item) for item in embeddings])
    return normalize(normalized.mean(axis=0))


def match_embedding(
    embedding: np.ndarray,
    profiles: dict[str, np.ndarray],
    *,
    threshold: float = 0.55,
    minimum_margin: float = 0.08,
) -> Match:
    if not profiles:
        raise ValueError("No enrolled speaker profiles were supplied.")

    query = normalize(embedding)
    if any(np.asarray(profile).size != query.size for profile in profiles.values()):
        raise ValueError("Voice embedding dimensions do not match the enrolled profiles.")
    scores = sorted(
        ((name, float(np.dot(query, normalize(profile)))) for name, profile in profiles.items()),
        key=lambda item: item[1],
        reverse=True,
    )
    name, best = scores[0]
    second = scores[1][1] if len(scores) > 1 else -1.0
    margin = best - second
    accepted = best >= threshold and (len(scores) == 1 or margin >= minimum_margin)
    return Match(
        speaker=name if accepted else "UNKNOWN",
        similarity=best,
        second_best_similarity=second,
        margin=margin,
        accepted=accepted,
    )
