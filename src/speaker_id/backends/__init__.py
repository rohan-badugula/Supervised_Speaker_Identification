"""Model adapters. Importing this package does not load ML dependencies."""

from .base import Backend, DiarizationResult, Turn
from .registry import DEFAULT_MODEL, MODEL_SPECS, ModelSpec, get_model, load_backend

__all__ = [
    "Backend", "DiarizationResult", "Turn", "DEFAULT_MODEL", "MODEL_SPECS",
    "ModelSpec", "get_model", "load_backend",
]
