import sys
from types import SimpleNamespace

from speaker_id.media import require_ffmpeg
from speaker_id.workbench.runtime import setup_issues


def test_packaged_ffmpeg_fallback(monkeypatch):
    monkeypatch.setattr("speaker_id.media.shutil.which", lambda name: None)
    monkeypatch.setitem(sys.modules, "imageio_ffmpeg",
                        SimpleNamespace(get_ffmpeg_exe=lambda: "/packaged/ffmpeg"))
    assert require_ffmpeg() == "/packaged/ffmpeg"


def test_missing_token_is_only_blocker_when_audio_ready():
    health = {"ffmpeg": True, "audio": True, "ecapa": False, "token": False}
    issues = setup_issues(health)
    assert len(issues) == 1 and "HF_TOKEN" in issues[0]
    assert len(setup_issues(health, ecapa=True)) == 2
