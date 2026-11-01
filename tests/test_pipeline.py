from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from speaker_id.backends import DiarizationResult, Turn
from speaker_id.pipeline import identify_speakers
from speaker_id.profiles import ProfileBundle


class Annotation:
    def __init__(self, turns):
        self.turns = turns

    def labels(self):
        return sorted({speaker for _, _, speaker in self.turns})

    def itertracks(self, yield_label=False):
        assert yield_label
        for start, end, speaker in self.turns:
            yield SimpleNamespace(start=start, end=end), 0, speaker


def test_identification_preserves_overlap_in_reports(monkeypatch, tmp_path: Path):
    output = SimpleNamespace(
        speaker_diarization=Annotation([(0.0, 3.0, "S0"), (2.0, 4.0, "S1")]),
        exclusive_speaker_diarization=Annotation([(0.0, 3.0, "S0"), (3.0, 4.0, "S1")]),
        speaker_embeddings=np.eye(2, dtype=np.float32),
    )
    monkeypatch.setattr("speaker_id.pipeline.convert_to_wav", lambda source, destination: destination)
    profiles = ProfileBundle(
        embeddings={"Alice": np.array([1.0, 0.0]), "Bob": np.array([0.0, 1.0])},
        clip_counts={"Alice": 3, "Bob": 3},
        model_id="test-model",
    )
    from speaker_id.backends.pyannote import PyannoteBackend
    from speaker_id.backends.registry import ModelSpec

    spec = ModelSpec("test", "test-model", "test-model", None, "test")
    backend = PyannoteBackend(spec, lambda *args, **kwargs: output)
    monkeypatch.setattr(backend, "_audio_input", lambda path: {"waveform": np.zeros((1, 16000)), "sample_rate": 16000})
    report = identify_speakers(backend, tmp_path / "meeting.wav", profiles)

    segments = report["segments"]
    assert [(item["speaker"], item["start"], item["end"]) for item in segments] == [
        ("Alice", 0.0, 3.0), ("Bob", 2.0, 4.0)
    ]
    assert report["summary_seconds"] == {"Alice": 3.0, "Bob": 2.0}


def test_mismatched_model_rejected_before_processing(tmp_path):
    profiles = ProfileBundle({"Alice": np.array([1.0, 0.0])}, {"Alice": 1}, "model-a")
    backend = SimpleNamespace(model_id="model-b")
    with pytest.raises(ValueError, match="Re-enroll"):
        identify_speakers(backend, tmp_path / "missing.wav", profiles)


def test_missing_clean_embedding_preserves_unknown_turn(monkeypatch, tmp_path):
    monkeypatch.setattr("speaker_id.pipeline.convert_to_wav", lambda source, destination: destination)
    backend = SimpleNamespace(
        model_id="test",
        diarize=lambda *args, **kwargs: DiarizationResult((Turn(1, 2, "S0"),), {}),
    )
    profiles = ProfileBundle({"Alice": np.array([1.0, 0.0])}, {"Alice": 1}, "test")
    report = identify_speakers(backend, tmp_path / "meeting.wav", profiles)
    assert report["segments"][0]["speaker"] == "UNKNOWN"
    assert report["segments"][0]["similarity"] is None
    assert report["run"]["processing_seconds"] >= 0


@pytest.mark.parametrize("options", [
    {"min_speakers": 0}, {"min_speakers": 3, "max_speakers": 2},
    {"threshold": float("nan")}, {"minimum_margin": -1},
])
def test_invalid_run_settings_rejected(tmp_path, options):
    profiles = ProfileBundle({"Alice": np.array([1.0, 0.0])}, {"Alice": 1}, "test")
    with pytest.raises(ValueError):
        identify_speakers(SimpleNamespace(model_id="test"), tmp_path / "missing.wav", profiles, **options)
