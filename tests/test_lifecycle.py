import http.client
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from speaker_id.workbench import lifecycle


def test_unrelated_owner_is_never_signaled(monkeypatch):
    monkeypatch.setattr(lifecycle, "_listeners", lambda port: [123])
    monkeypatch.setattr(lifecycle, "_command", lambda pid: "python unrelated.py")
    monkeypatch.setattr(lifecycle, "_is_workbench", lambda pid, command: False)
    monkeypatch.setattr(lifecycle.os, "kill", lambda *args: pytest.fail("Unrelated process was signaled"))
    with pytest.raises(RuntimeError, match="another application"):
        lifecycle.release_workbench_port(8766)


def test_changed_process_identity_is_not_signaled(monkeypatch):
    monkeypatch.setattr(lifecycle, "_listeners", lambda port: [123])
    calls = iter(["workbench", "different process"])
    monkeypatch.setattr(lifecycle, "_command", lambda pid: next(calls))
    monkeypatch.setattr(lifecycle, "_is_workbench", lambda pid, command: True)
    monkeypatch.setattr(lifecycle, "_wait_for_exit", lambda commands, seconds: True)
    monkeypatch.setattr(lifecycle.os, "kill", lambda *args: pytest.fail("Reused process was signaled"))
    lifecycle.release_workbench_port(8766)


def test_unknown_owner_has_clear_error(monkeypatch):
    monkeypatch.setattr(lifecycle, "_listeners", lambda port: [])
    with pytest.raises(RuntimeError, match="could not be identified"):
        lifecycle.release_workbench_port(8766)


@pytest.mark.skipif(not shutil.which("lsof"), reason="Live restart requires lsof")
def test_second_launch_replaces_existing_workbench(tmp_path):
    launcher = Path(__file__).resolve().parents[1] / "tools" / "run_workbench.py"
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    command = [sys.executable, str(launcher), "--port", str(port), "--data-dir", str(tmp_path)]
    processes = []

    def launch():
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(process)
        return process

    def ready(process, previous=None):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            assert process.poll() is None, process.communicate()
            if previous is not None and previous.poll() is None:
                time.sleep(0.05)
                continue
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.2)
                connection.request("GET", "/api/state")
                response = connection.getresponse()
                response.read()
                connection.close()
                if response.status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.05)
        pytest.fail("Workbench did not become ready")

    try:
        first = launch()
        ready(first)
        blocked = subprocess.run(command + ["--no-restart"], capture_output=True, text=True, timeout=10)
        assert blocked.returncode != 0
        assert first.poll() is None
        second = launch()
        ready(second, previous=first)
        assert first.wait(timeout=2) != 0
        assert second.poll() is None
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=5)
