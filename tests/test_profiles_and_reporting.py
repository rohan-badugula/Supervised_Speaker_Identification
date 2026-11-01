from pathlib import Path

import numpy as np

from speaker_id.profiles import ProfileBundle, load_profiles, save_profiles
from speaker_id.reporting import build_summary, write_csv_report, write_json_report
import pytest


def test_profile_round_trip(tmp_path: Path):
    source = ProfileBundle(
        embeddings={"Alice": np.array([1.0, 0.0]), "Bob": np.array([0.0, 1.0])},
        clip_counts={"Alice": 3, "Bob": 2},
        model_id="test-model",
    )
    path = tmp_path / "profiles.npz"
    save_profiles(source, path)
    loaded = load_profiles(path)
    assert loaded.model_id == "test-model"
    assert loaded.clip_counts == {"Alice": 3, "Bob": 2}
    assert np.allclose(loaded.embeddings["Alice"], [1.0, 0.0])


def test_summary_and_csv_export(tmp_path: Path):
    segments = [
        {"start": 0.0, "end": 1.5, "duration": 1.5, "speaker": "Alice", "cluster": "S0", "similarity": 0.8, "margin": 0.2},
        {"start": 2.0, "end": 3.0, "duration": 1.0, "speaker": "Alice", "cluster": "S0", "similarity": 0.8, "margin": 0.2},
        {"start": 4.0, "end": 5.0, "duration": 1.0, "speaker": "UNKNOWN", "cluster": "S1", "similarity": 0.3, "margin": 0.01},
    ]
    assert build_summary(segments) == {"Alice": 2.5, "UNKNOWN": 1.0}
    path = tmp_path / "segments.csv"
    write_csv_report(segments, path)
    assert "speaker,cluster" in path.read_text(encoding="utf-8")


def test_invalid_json_does_not_replace_existing_report(tmp_path):
    path = tmp_path / "report.json"
    write_json_report({"revision": 1}, path)
    original = path.read_bytes()
    with pytest.raises(ValueError):
        write_json_report({"similarity": float("nan")}, path)
    assert path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [path]
