from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from ..matching import centroid
from .base import DiarizationResult, Turn, ProgressCallback
from .registry import ModelSpec


def clean_intervals(turns: tuple[Turn, ...], cluster: str) -> list[tuple[float, float]]:
    """Subtract all other speakers before extracting identity embeddings."""
    intervals = []
    others = [turn for turn in turns if turn.cluster != cluster]
    for turn in turns:
        if turn.cluster != cluster:
            continue
        pieces = [(turn.start, turn.end)]
        for other in others:
            remaining = []
            for start, end in pieces:
                if other.end <= start or other.start >= end:
                    remaining.append((start, end))
                else:
                    if start < other.start:
                        remaining.append((start, other.start))
                    if other.end < end:
                        remaining.append((other.end, end))
            pieces = remaining
        intervals.extend(pieces)
    return sorted(intervals)


class PyannoteBackend:
    def __init__(self, spec: ModelSpec, pipeline: Any, encoder: Any = None):
        self.spec = spec
        self.model_id = spec.model_id
        self.pipeline = pipeline
        self.encoder = encoder
        self._progress_callback: ProgressCallback | None = None

    def set_progress_callback(self, callback: ProgressCallback) -> None:
        self._progress_callback = callback

    def _hook(self, step_name, step_artifact=None, *, completed=None, total=None, **kwargs):
        if self._progress_callback is None:
            return
        # The final embedding artifact is emitted immediately before clustering.
        phase = "clustering" if step_name == "embeddings" and total is None and step_artifact is not None else step_name
        self._progress_callback(phase, completed, total)

    @classmethod
    def load(cls, spec: ModelSpec, *, token: str, device: str) -> PyannoteBackend:
        try:
            import torch
            from pyannote.audio import Pipeline
        except ImportError as error:
            raise RuntimeError("Install the audio backend with `pip install -e '.[audio]'`.") from error
        pipeline = Pipeline.from_pretrained(spec.diarization_model, token=token)
        if pipeline is None:
            raise RuntimeError("Model could not be loaded. Check model access and HF_TOKEN.")
        pipeline.to(torch.device(device))
        encoder = None
        if spec.embedding_model:
            try:
                from speechbrain.inference.classifiers import EncoderClassifier
            except ImportError as error:
                raise RuntimeError("Install ECAPA support with `pip install -e '.[ecapa]'`.") from error
            encoder = EncoderClassifier.from_hparams(
                source=spec.embedding_model,
                savedir=str(Path("artifacts/model-cache") / spec.key),
                run_opts={"device": device},
            )
        return cls(spec, pipeline, encoder)

    def _encode(self, samples: np.ndarray) -> np.ndarray:
        import torch

        with torch.inference_mode():
            value = self.encoder.encode_batch(torch.from_numpy(samples).unsqueeze(0))
        return value.detach().cpu().numpy().reshape(-1)

    @staticmethod
    def _audio_input(wav_path: Path) -> dict:
        """Decode our PCM WAV with libsndfile, bypassing TorchCodec's FFmpeg ABI.

        The packaged FFmpeg executable can convert media without supplying the
        shared FFmpeg libraries that TorchCodec requires for file-path inputs.
        Pyannote officially accepts this in-memory (channels, samples) input.
        """
        import soundfile as sf
        import torch

        samples, rate = sf.read(wav_path, dtype="float32")
        if rate != 16000 or samples.ndim != 1 or not len(samples):
            raise ValueError("Backend inputs must be nonempty mono 16 kHz WAV files.")
        return {"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": rate}

    def embed_enrollment(self, wav_path: Path) -> np.ndarray:
        if self.encoder is not None:
            import soundfile as sf

            samples, rate = sf.read(wav_path, dtype="float32")
            if rate != 16000 or samples.ndim != 1:
                raise ValueError("Backend inputs must be mono 16 kHz WAV files.")
            # Bound encoder memory even when a multi-minute sample is supplied.
            chunks = [samples[index:index + 160000] for index in range(0, len(samples), 160000)]
            return centroid([self._encode(chunk) for chunk in chunks if len(chunk) >= 16000])
        output = self.pipeline(self._audio_input(wav_path), num_speakers=1)
        embeddings = np.asarray(output.speaker_embeddings, dtype=np.float32)
        if embeddings.ndim != 2 or embeddings.shape[0] != 1:
            raise RuntimeError(f"Expected one speaker embedding for enrollment clip: {wav_path}")
        return embeddings[0]

    def diarize(self, wav_path: Path, *, min_speakers=None, max_speakers=None) -> DiarizationResult:
        options = {key: value for key, value in {
            "min_speakers": min_speakers, "max_speakers": max_speakers,
        }.items() if value is not None}
        if self._progress_callback is not None:
            self._progress_callback("segmentation", None, None)
            options["hook"] = self._hook
        output = self.pipeline(self._audio_input(wav_path), **options)
        annotation = output.speaker_diarization
        turns = tuple(Turn(float(turn.start), float(turn.end), str(label))
                      for turn, _, label in annotation.itertracks(yield_label=True))
        labels = list(annotation.labels())
        if self.encoder is None:
            if not labels:
                return DiarizationResult(turns, {})
            matrix = np.asarray(output.speaker_embeddings, dtype=np.float32)
            if matrix.ndim != 2 or matrix.shape[0] != len(labels):
                raise RuntimeError("Diarization labels and speaker embeddings do not align.")
            return DiarizationResult(turns, {str(label): matrix[i] for i, label in enumerate(labels)})

        import soundfile as sf

        embeddings = {}
        if self._progress_callback:
            self._progress_callback("identity_embeddings", 0, len(labels))
        with sf.SoundFile(wav_path) as audio:
            if audio.samplerate != 16000 or audio.channels != 1:
                raise ValueError("Backend inputs must be mono 16 kHz WAV files.")
            for index, label in enumerate(labels, 1):
                vectors = []
                # Cap extraction at 60s per cluster, preferring longer clean regions.
                budget = 60 * 16000
                for start, end in sorted(clean_intervals(turns, str(label)),
                                         key=lambda interval: interval[1] - interval[0], reverse=True):
                    left, right = int(start * 16000), int(end * 16000)
                    for offset in range(left, right, 160000):
                        count = min(160000, right - offset, budget)
                        if count < 16000:
                            continue
                        audio.seek(offset)
                        samples = audio.read(count, dtype="float32")
                        if len(samples) >= 16000:
                            vectors.append(self._encode(samples))
                            budget -= len(samples)
                        if budget < 16000:
                            break
                    if budget < 16000:
                        break
                if vectors:
                    embeddings[str(label)] = centroid(vectors)
                if self._progress_callback:
                    self._progress_callback("identity_embeddings", index, len(labels))
        return DiarizationResult(turns, embeddings)
