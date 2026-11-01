"""Run metadata without tokens or environment-variable dumps."""

from hashlib import file_digest
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path


def sha256_file(path: Path) -> str:
    with path.expanduser().open("rb") as handle:
        return file_digest(handle, "sha256").hexdigest()


def package_versions() -> dict[str, str]:
    result = {}
    for name in ("supervised-speaker-id", "numpy", "pyannote.audio", "torch", "speechbrain", "soundfile"):
        try:
            result[name] = version(name)
        except PackageNotFoundError:
            continue
    return result
