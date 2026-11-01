"""Fast preflight checks; never expose credential values to the browser."""
import importlib.util
import os
import hashlib
from pathlib import Path

from ..media import require_ffmpeg


def source_signature():
    """Fingerprint Python source only; static UI edits do not need a restart."""
    root = Path(__file__).resolve().parents[1]
    signature = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        signature.update(str(path.relative_to(root)).encode())
        signature.update(path.read_bytes())
    return signature.hexdigest()


class RuntimeNotReady(ValueError):
    def __init__(self, issues):
        self.issues = issues
        super().__init__("Analysis cannot start until local setup is complete.")


def _available(module):
    try:
        return importlib.util.find_spec(module) is not None
    except (ModuleNotFoundError, ValueError, ImportError):
        return False


def runtime_health():
    importlib.invalidate_caches()
    try:
        require_ffmpeg()
        ffmpeg = True
    except RuntimeError:
        ffmpeg = False
    return {"ffmpeg": ffmpeg,
            "audio": all(_available(name) for name in ("pyannote.audio", "torch", "torchaudio", "soundfile")),
            "ecapa": _available("speechbrain"), "token": bool(os.environ.get("HF_TOKEN"))}


def setup_issues(health, *, ecapa=False):
    issues = []
    if not health["ffmpeg"]:
        issues.append("FFmpeg is unavailable. Install the audio extra, then restart the server.")
    if not health["audio"]:
        issues.append("Audio dependencies are missing. Run: python -m pip install -e '.[audio]'")
    if ecapa and not health["ecapa"]:
        issues.append("ECAPA dependencies are missing. Run: python -m pip install -e '.[ecapa]'")
    if not health["token"]:
        issues.append("Hugging Face access is not configured. Accept the Community-1 model conditions, "
                      "set HF_TOKEN in the server terminal, then restart the workbench.")
    return issues
