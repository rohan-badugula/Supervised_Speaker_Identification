import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from speaker_id.backends import DiarizationResult, Turn
from speaker_id.media import AnalysisRange, convert_to_wav, wav_duration
from speaker_id.pipeline import identify_speakers
from speaker_id.profiles import ProfileBundle


def write_audio(path: Path, seconds: float):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b'\0' * (round(seconds * 16000) * 2))
    return path


@pytest.mark.parametrize('start,length', [(-1, 10), (0, 0), (0, -1), (float('nan'), 5),
                                         (0, float('inf'))])
def test_invalid_window_rejected(start, length):
    with pytest.raises(ValueError):
        AnalysisRange(start, length)


def test_ffmpeg_seeks_and_limits_extraction(monkeypatch, tmp_path):
    source = tmp_path / 'source.mp4'
    source.write_bytes(b'media')
    captured = []
    monkeypatch.setattr('speaker_id.media.require_ffmpeg', lambda: 'ffmpeg')
    monkeypatch.setattr('speaker_id.media.subprocess.run', lambda args, **kwargs: captured.extend(args))
    convert_to_wav(source, tmp_path / 'preview.wav', start_seconds=120, duration_seconds=600)
    assert captured[captured.index('-ss') + 1] == '120'
    assert captured.index('-ss') < captured.index('-i')
    assert captured[captured.index('-t') + 1] == '600'


def test_named_preview_uses_original_timestamps_and_actual_clip_duration(monkeypatch, tmp_path):
    calls = []

    def convert(source, destination, **options):
        calls.append(options)
        # Source ends early: report actual decoded audio, not the requested limit.
        return write_audio(destination, 3.5)

    monkeypatch.setattr('speaker_id.pipeline.convert_to_wav', convert)
    backend = SimpleNamespace(model_id='test', diarize=lambda *a, **k: DiarizationResult(
        (Turn(0, 3, 'A'), Turn(2, 4, 'B')), {'A': np.array([1., 0.]), 'B': np.array([0., 1.])}))
    profiles = ProfileBundle({'Person 1': np.array([1., 0.]), 'Person 2': np.array([0., 1.])},
                             {'Person 1': 1, 'Person 2': 1}, 'test')
    report = identify_speakers(backend, tmp_path/'source.mp4', profiles,
                               start_seconds=120, duration_seconds=600)
    assert calls == [{'start_seconds': 120, 'duration_seconds': 600}]
    assert [(s['start'], s['end']) for s in report['segments']] == [(120, 123), (122, 123.5)]
    assert report['analysis_range'] == {'start_seconds': 120, 'end_seconds': 123.5,
                                       'duration_seconds': 3.5, 'requested_duration_seconds': 600,
                                       'full_recording': False}
    assert report['summary_seconds'] == {'Person 1': 3.0, 'Person 2': 1.5}


def test_real_ffmpeg_extraction_is_bounded(tmp_path):
    from speaker_id.media import require_ffmpeg
    try:
        require_ffmpeg()
    except RuntimeError:
        pytest.skip('Optional FFmpeg runtime is not installed')
    source = write_audio(tmp_path/'source.wav', 6)
    result = convert_to_wav(source, tmp_path/'section.wav', start_seconds=2, duration_seconds=1.25)
    assert wav_duration(result) == pytest.approx(1.25, abs=.001)
