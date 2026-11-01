import sys
import json
from types import SimpleNamespace

import numpy as np
import pytest

from speaker_id.backends import DiarizationResult, Turn, get_model
from speaker_id.backends.pyannote import PyannoteBackend, clean_intervals
from speaker_id.cli import build_parser, run
from speaker_id.profiles import ProfileBundle, save_profiles


def test_models_list_needs_no_token_or_ml_packages(capsys, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    assert run(build_parser().parse_args(["models"])) == 0
    assert "community-1-ecapa" in capsys.readouterr().out


def test_registry_aliases_and_embedding_spaces():
    native = get_model("community-1")
    assert get_model(native.model_id) == native
    assert native.model_id != get_model("community-1-ecapa").model_id
    with pytest.raises(ValueError, match="Unknown model"):
        get_model("typo")


def test_cli_mismatch_fails_before_loading_weights(tmp_path, monkeypatch):
    path = tmp_path / "profiles.npz"
    save_profiles(ProfileBundle({"Alice": np.array([1.0, 0.0])}, {"Alice": 1},
                                get_model("community-1").model_id), path)
    monkeypatch.setattr("speaker_id.cli.load_backend", lambda *a, **k: pytest.fail("Must not load"))
    args = build_parser().parse_args([
        "identify", "meeting.wav", "--profiles", str(path), "--model", "community-1-ecapa",
    ])
    with pytest.raises(ValueError, match="Re-enroll"):
        run(args)


def test_clean_intervals_subtract_nested_and_partial_overlap():
    turns = (Turn(0, 10, "A"), Turn(2, 3, "B"), Turn(5, 12, "C"))
    assert clean_intervals(turns, "A") == [(0, 2), (3, 5)]
    assert clean_intervals(turns, "B") == []
    assert clean_intervals(turns, "C") == [(10, 12)]


def test_ecapa_uses_clean_audio_but_keeps_overlapping_turns(monkeypatch, tmp_path):
    class Annotation:
        def labels(self):
            return ["A", "B"]

        def itertracks(self, yield_label):
            yield SimpleNamespace(start=0, end=3), 0, "A"
            yield SimpleNamespace(start=2, end=4), 0, "B"

    class Audio:
        samplerate, channels = 16000, 1

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def seek(self, offset):
            self.offset = offset

        def read(self, count, dtype):
            return np.arange(self.offset, self.offset + count, dtype=np.float32)

    monkeypatch.setitem(sys.modules, "soundfile", SimpleNamespace(SoundFile=lambda path: Audio()))
    backend = PyannoteBackend(get_model("community-1-ecapa"),
                              lambda *a, **k: SimpleNamespace(speaker_diarization=Annotation()), object())
    monkeypatch.setattr(backend, "_audio_input", lambda path: {"waveform": np.zeros((1, 16000)), "sample_rate": 16000})
    samples = []

    def encode(audio):
        samples.append((audio[0], audio[-1], len(audio)))
        return np.array([1.0, 0.0])

    monkeypatch.setattr(backend, "_encode", encode)
    result = backend.diarize(tmp_path / "meeting.wav")
    assert samples == [(0, 31999, 32000), (48000, 63999, 16000)]
    assert result.turns == (Turn(0, 3, "A"), Turn(2, 4, "B"))
    assert set(result.embeddings) == {"A", "B"}


@pytest.mark.parametrize("vector", [np.array([float("nan")]), np.zeros(2), np.ones((1, 2))])
def test_invalid_voiceprints_rejected(vector):
    with pytest.raises(ValueError):
        ProfileBundle({"Alice": vector}, {"Alice": 1}, "test")


def test_cli_enrollment_to_identification_with_selected_backend(tmp_path, monkeypatch):
    class Backend:
        model_id = get_model("community-1-ecapa").model_id

        def embed_enrollment(self, path):
            return np.array([1.0, 0.0])

        def diarize(self, path, **kwargs):
            return DiarizationResult((Turn(1, 3, "A"),), {"A": np.array([1.0, 0.0])})

    selected = []

    def load(name, **kwargs):
        selected.append(name)
        return Backend()

    monkeypatch.setenv("HF_TOKEN", "test-token")
    monkeypatch.setattr("speaker_id.cli.load_backend", load)
    monkeypatch.setattr("speaker_id.pipeline.convert_to_wav", lambda source, destination: destination)
    folder = tmp_path / "enrollment" / "Alice"
    folder.mkdir(parents=True)
    (folder / "clip.wav").write_bytes(b"test enrollment")
    profiles = tmp_path / "profiles.npz"
    parser = build_parser()
    assert run(parser.parse_args([
        "enroll", str(folder.parent), "--model", "community-1-ecapa", "--profiles", str(profiles),
    ])) == 0
    source = tmp_path / "meeting.wav"
    source.write_bytes(b"test recording")
    report = tmp_path / "report.json"
    # Omission of --model must use the enrolled configuration, not the default.
    assert run(parser.parse_args([
        "identify", str(source), "--profiles", str(profiles), "--output", str(report),
    ])) == 0
    payload = json.loads(report.read_text())
    assert selected == ["community-1-ecapa", "community-1-ecapa"]
    assert payload["segments"][0]["speaker"] == "Alice"
    assert len(payload["run"]["source_sha256"]) == 64
    assert len(payload["run"]["profiles_sha256"]) == 64
    assert "test-token" not in report.read_text()
    assert report.with_suffix(".csv").is_file()


def test_native_backend_passes_waveforms_for_meetings_and_enrollment(monkeypatch, tmp_path):
    class Annotation:
        def labels(self):
            return ['A']

        def itertracks(self, yield_label):
            yield SimpleNamespace(start=0, end=1), 0, 'A'

    calls = []
    audio = {'waveform': np.zeros((1, 16000), dtype=np.float32), 'sample_rate': 16000}

    def pipeline(source, **options):
        assert isinstance(source, dict) and source is audio  # Paths trigger TorchCodec.
        calls.append(options)
        return SimpleNamespace(speaker_diarization=Annotation(), speaker_embeddings=np.array([[1., 0.]]))

    backend = PyannoteBackend(get_model('community-1'), pipeline)
    monkeypatch.setattr(backend, '_audio_input', lambda path: audio)
    backend.diarize(tmp_path / 'meeting.wav')
    assert np.array_equal(backend.embed_enrollment(tmp_path / 'reference.wav'), [1., 0.])
    assert calls == [{}, {'num_speakers': 1}]


def test_waveform_loader_uses_soundfile_and_channel_first_float32(monkeypatch, tmp_path):
    values = np.array([0., .25, -.5], dtype=np.float32)

    class Tensor:
        def __init__(self, array):
            self.array = array

        def unsqueeze(self, axis):
            return np.expand_dims(self.array, axis)

    monkeypatch.setitem(sys.modules, 'soundfile', SimpleNamespace(read=lambda path, dtype: (values, 16000)))
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(from_numpy=Tensor))
    audio = PyannoteBackend._audio_input(tmp_path / 'converted.wav')
    assert audio['sample_rate'] == 16000
    assert audio['waveform'].shape == (1, 3)
    assert audio['waveform'].dtype == np.float32
    assert np.array_equal(audio['waveform'][0], values)


@pytest.mark.parametrize('samples,rate', [(np.zeros(3), 44100), (np.zeros((3, 2)), 16000), (np.array([]), 16000)])
def test_waveform_loader_rejects_invalid_audio(monkeypatch, tmp_path, samples, rate):
    monkeypatch.setitem(sys.modules, 'soundfile', SimpleNamespace(read=lambda path, dtype: (samples, rate)))
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(from_numpy=lambda value: pytest.fail('Invalid input encoded')))
    with pytest.raises(ValueError, match='nonempty mono 16 kHz'):
        PyannoteBackend._audio_input(tmp_path / 'invalid.wav')
