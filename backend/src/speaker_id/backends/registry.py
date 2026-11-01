from __future__ import annotations

from dataclasses import dataclass

from .base import Backend


DEFAULT_MODEL = "community-1"
COMMUNITY_MODEL = "pyannote/speaker-diarization-community-1"
ECAPA_MODEL = "speechbrain/spkrec-ecapa-voxceleb"


@dataclass(frozen=True)
class ModelSpec:
    key: str
    model_id: str
    diarization_model: str
    embedding_model: str | None
    description: str


MODEL_SPECS = (
    ModelSpec(DEFAULT_MODEL, COMMUNITY_MODEL, COMMUNITY_MODEL, None,
              "Community-1 diarization and native embeddings"),
    ModelSpec("community-1-ecapa", f"{COMMUNITY_MODEL}+{ECAPA_MODEL}:clean-v1",
              COMMUNITY_MODEL, ECAPA_MODEL,
              "Community-1 turns with ECAPA embeddings from non-overlapping speech"),
)


def get_model(name: str) -> ModelSpec:
    for spec in MODEL_SPECS:
        if name in {spec.key, spec.model_id}:
            return spec
    raise ValueError(f"Unknown model {name!r}. Run `voice-id models` to list supported models.")


def load_backend(name: str, *, token: str, device: str = "cpu") -> Backend:
    spec = get_model(name)
    from .pyannote import PyannoteBackend

    return PyannoteBackend.load(spec, token=token, device=device)
