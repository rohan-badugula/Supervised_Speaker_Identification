import numpy as np
import pytest

from speaker_id.matching import centroid, match_embedding, normalize


def test_normalize_returns_unit_vector():
    result = normalize(np.array([3.0, 4.0]))
    assert np.linalg.norm(result) == pytest.approx(1.0)


def test_centroid_combines_multiple_clips():
    result = centroid([np.array([1.0, 0.0]), np.array([0.8, 0.2])])
    assert result[0] > result[1]
    assert np.linalg.norm(result) == pytest.approx(1.0)


def test_match_accepts_clear_known_speaker():
    profiles = {
        "Alice": np.array([1.0, 0.0, 0.0]),
        "Bob": np.array([0.0, 1.0, 0.0]),
    }
    result = match_embedding(np.array([0.98, 0.05, 0.0]), profiles)
    assert result.speaker == "Alice"
    assert result.accepted is True


def test_match_rejects_weak_similarity():
    profiles = {
        "Alice": np.array([1.0, 0.0, 0.0]),
        "Bob": np.array([0.0, 1.0, 0.0]),
    }
    result = match_embedding(
        np.array([0.1, 0.1, 0.98]),
        profiles,
        threshold=0.55,
    )
    assert result.speaker == "UNKNOWN"
    assert result.accepted is False


def test_match_rejects_ambiguous_identity():
    profiles = {
        "Alice": np.array([1.0, 0.0]),
        "Bob": np.array([0.98, 0.2]),
    }
    result = match_embedding(
        np.array([1.0, 0.05]),
        profiles,
        threshold=0.5,
        minimum_margin=0.08,
    )
    assert result.speaker == "UNKNOWN"


def test_zero_embedding_is_invalid():
    with pytest.raises(ValueError):
        normalize(np.zeros(3))
