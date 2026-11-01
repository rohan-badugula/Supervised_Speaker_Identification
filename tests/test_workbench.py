import http.client
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from speaker_id.backends import DiarizationResult, Turn, get_model
from speaker_id.workbench.server import Server, byte_range
from speaker_id.workbench.service import Workbench, validate_segments
from speaker_id.workbench.store import Store


@pytest.fixture
def web(tmp_path):
    server = Server(("127.0.0.1", 0), tmp_path)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def request(method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
        headers = dict(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body)
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = (response.status, dict(response.getheaders()), response.read())
        connection.close()
        return result

    yield server, request
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)


def test_upload_playback_ranges_and_metadata_persist(web):
    server, request = web
    status, _, body = request("GET", "/api/state")
    token = json.loads(body)["csrf"]
    data = b"0123456789" * 1000
    status, _, body = request("POST", "/api/upload?name=meeting.mp4&role=meeting", data,
                              {"X-Workbench-Token": token})
    assert status == 201
    media = json.loads(body)
    assert server.app.media_path(media["id"]).read_bytes() == data
    status, headers, body = request("GET", f"/api/media/{media['id']}", headers={"Range": "bytes=20-29"})
    assert status == 206 and body == data[20:30]
    assert headers["Content-Range"] == f"bytes 20-29/{len(data)}"
    assert headers["Content-Type"] == "video/mp4"
    status, _, body = request("GET", f"/api/media/{media['id']}", headers={"Range": "bytes=-5"})
    assert status == 206 and body == data[-5:]
    status, headers, body = request("HEAD", f"/api/media/{media['id']}")
    assert status == 200 and not body and int(headers["Content-Length"]) == len(data)
    assert Store(server.app.store.root).get("media", media["id"])["name"] == "meeting.mp4"


def test_local_request_protection_and_unsupported_upload(web):
    server, request = web
    assert request("POST", "/api/jobs", {})[0] == 403
    assert request("GET", "/api/state", headers={"Host": "untrusted.example"})[0] == 403
    assert request("GET", "/api/state", headers={"Origin": "https://untrusted.example"})[0] == 403
    assert request("POST", "/api/upload?name=script.exe", b"x",
                   {"X-Workbench-Token": server.token})[0] == 400
    assert not server.app.store.list("media")


def test_app_and_assets_are_served_without_external_dependencies(web):
    _, request = web
    for path, content_type in [("/", "text/html"), ("/app.js", "javascript"),
                                ("/styles.css", "text/css")]:
        status, headers, body = request("GET", path)
        assert status == 200 and body
        assert content_type in headers["Content-Type"]
        assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]


def test_port_conflict_does_not_interrupt_existing_catalog_jobs(web):
    server, _ = web
    job = server.app.store.save("job", {"status": "running", "stage": "Test fixture"})
    with pytest.raises(OSError):
        Server(server.server_address, server.app.store.root)
    assert server.app.store.get("job", job["id"])["status"] == "running"


def test_setup_blockers_return_actionable_response_before_queueing(web, monkeypatch):
    server, request = web
    headers = {"X-Workbench-Token": server.token}
    _, _, raw = request("POST", "/api/upload?name=test.mp4", b"audio", headers)
    media = json.loads(raw)
    monkeypatch.setattr("speaker_id.workbench.service.runtime_health",
                        lambda: {"ffmpeg": False, "audio": False, "token": False, "ecapa": False})
    status, _, body = request("POST", "/api/jobs", {
        "kind": "identify", "media_id": media["id"], "model": "community-1",
    }, headers)
    assert status == 409
    payload = json.loads(body)
    assert payload["code"] == "setup_required"
    assert len(payload["issues"]) == 3
    assert any("HF_TOKEN" in issue for issue in payload["issues"])
    assert server.app.store.list("job") == []


def test_reference_labels_export_and_conflict_detection(web):
    server, request = web
    headers = {"X-Workbench-Token": server.token}
    _, _, raw = request("POST", "/api/upload?name=reference.mp3&role=reference", b"audio", headers)
    media = json.loads(raw)
    segment = {"start": 1, "end": 4, "speaker": "Person 1", "flag": "clean", "included": True}
    payload = {"revision": 0, "annotations": [segment]}
    status, _, raw = request("POST", f"/api/media/{media['id']}/annotations", payload, headers)
    assert status == 200 and json.loads(raw)["revision"] == 1
    assert request("POST", f"/api/media/{media['id']}/annotations", payload, headers)[0] == 400
    status, _, raw = request("GET", f"/api/labels/{media['id']}")
    assert status == 200
    assert json.loads(raw)["annotations"][0]["speaker"] == "Person 1"
    assert request("GET", "/../../pyproject.toml")[0] == 404


@pytest.mark.parametrize("header,size", [("bytes=99-", 10), ("bytes=4-2", 10),
                                            ("bytes=-0", 10), ("bytes=0-1,4-5", 10)])
def test_invalid_ranges(header, size):
    with pytest.raises(ValueError):
        byte_range(header, size)


@pytest.mark.parametrize("segment", [
    {"start": 0, "end": float("nan"), "speaker": "Person 1"},
    {"start": 4, "end": 3, "speaker": "Person 1"},
    {"start": 0, "end": 20, "speaker": "Person 1"},
    {"start": 0, "end": 1, "speaker": "UNKNOWN"},
])
def test_invalid_annotation_rejected(segment):
    with pytest.raises(ValueError):
        validate_segments([segment], duration=10)


def wait_job(app, identity):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = app.store.get("job", identity)
        if job["status"] not in {"queued", "running"}:
            return job
        time.sleep(0.01)
    pytest.fail("Background job did not finish.")


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "test-token")
    monkeypatch.setattr("speaker_id.workbench.service.require_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr("speaker_id.workbench.service.convert_to_wav", lambda source, target: target)
    monkeypatch.setattr("speaker_id.pipeline.convert_to_wav", lambda source, target: target)
    monkeypatch.setattr("speaker_id.workbench.service.subprocess.run", lambda command, **kwargs:
                        Path(command[-1]).write_bytes(b"converted"))

    class Backend:
        def __init__(self, name):
            self.model_id = get_model(name).model_id

        def embed_enrollment(self, path):
            assert path.read_bytes() == b"converted"
            return np.array([1.0, 0.0])

        def diarize(self, path, **kwargs):
            return DiarizationResult((Turn(0, 3, "S0"), Turn(2, 4, "S1")),
                                     {"S0": np.array([1.0, 0.0]), "S1": np.array([0.0, 1.0])})

    app = Workbench(tmp_path, backend_loader=lambda name, **kwargs: Backend(name))
    source = app.store.path("media/test.mp4")
    source.parent.mkdir()
    source.write_bytes(b"original recording")
    media = app.store.save("media", {"name": "meeting.mp4", "path": "media/test.mp4",
                                     "role": "reference", "duration": 20, "annotations": [], "revision": 0})
    yield app, media
    app.pool.shutdown(wait=True)


def test_background_anonymous_run_and_corrections(runtime):
    app, media = runtime
    job = app.submit({"kind": "identify", "media_id": media["id"], "model": "community-1"})
    assert wait_job(app, job["id"])["status"] == "completed"
    report = app.report(job["id"])
    assert report["mode"] == "anonymous"
    assert [(s["speaker"], s["start"], s["end"]) for s in report["segments"]] == [
        ("Person 1", 0, 3), ("Person 2", 2, 4)]
    edited = app.correct(job["id"], {"labels": {"0": "Person 3"}, "revision": 0})
    assert edited["segments"][0]["speaker"] == "Person 3"
    assert edited["segments"][0]["predicted_speaker"] == "Person 1"
    assert app.store.path(f"reports/{job['id']}.original.json").exists()
    with pytest.raises(ValueError, match="another tab"):
        app.correct(job["id"], {"labels": {"0": "Oops"}, "revision": 0})


def test_profile_build_reuse_and_backend_isolation(runtime):
    app, media = runtime
    app.annotations(media["id"], {"annotations": [{"start": 1, "end": 6, "speaker": "Person 1"}],
                                  "revision": 0})
    job = app.submit({"kind": "enroll", "model": "community-1", "media_id": media["id"], "name": "Team"})
    complete = wait_job(app, job["id"])
    assert complete["status"] == "completed", complete
    collection = app.store.get("collection", complete["collection_id"])
    assert app.store.path(collection["path"]).is_file()
    assert app.store.path(collection["path"]).with_name("metadata.json").is_file()
    request = {"kind": "identify", "model": "community-1", "media_id": media["id"],
               "collection_id": collection["id"]}
    run = app.submit(request)
    assert wait_job(app, run["id"])["status"] == "completed"
    assert app.report(run["id"])["segments"][0]["speaker"] == "Person 1"
    with pytest.raises(ValueError, match="selected model"):
        app.submit({**request, "model": "community-1-ecapa"})


def test_restart_marks_incomplete_jobs_interrupted(tmp_path):
    store = Store(tmp_path)
    job = store.save("job", {"status": "running", "stage": "Inference"})
    app = Workbench(tmp_path)
    assert app.store.get("job", job["id"])["status"] == "interrupted"
    app.close()


def test_missing_clean_references_fail_before_queueing(runtime):
    app, media = runtime
    with pytest.raises(ValueError, match="clean reference"):
        app.submit({"kind": "enroll", "media_id": media["id"], "model": "community-1"})
    assert not app.store.list("job")


def test_anonymous_preview_preserves_source_time(runtime, monkeypatch):
    import wave
    app, media = runtime
    options = []

    def convert(source, destination, **kwargs):
        options.append(kwargs)
        with wave.open(str(destination), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\0" * 16000 * 2 * 6)
        return destination

    monkeypatch.setattr("speaker_id.workbench.service.convert_to_wav", convert)
    job = app.submit({"kind": "identify", "model": "community-1", "media_id": media["id"],
                      "start_seconds": 10, "duration_seconds": 6})
    assert wait_job(app, job["id"])["status"] == "completed"
    report = app.report(job["id"])
    assert options == [{"start_seconds": 10, "duration_seconds": 6}]
    assert [(s["start"], s["end"]) for s in report["segments"]] == [(10, 13), (12, 14)]
    assert report["analysis_range"]["end_seconds"] == 16


@pytest.mark.parametrize("options", [{"start_seconds": 20}, {"duration_seconds": 0},
                                     {"duration_seconds": -10}, {"start_seconds": -1}])
def test_invalid_analysis_range_never_queues(runtime, options):
    app, media = runtime
    with pytest.raises(ValueError):
        app.submit({"kind": "identify", "model": "community-1", "media_id": media["id"], **options})
    assert app.store.list("job") == []
