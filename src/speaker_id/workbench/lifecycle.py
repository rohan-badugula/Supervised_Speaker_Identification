"""Reclaim a local port only from a recognized workbench entry point."""
from __future__ import annotations

import os
import shlex
import shutil
import signal
import subprocess
import time
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
LAUNCHER = PROJECT_ROOT / "tools" / "run_workbench.py"


def _run(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, timeout=5)


def _listeners(port: int) -> list[int]:
    executable = shutil.which("lsof")
    if not executable:
        raise RuntimeError("Port is occupied. Automatic restart requires lsof on macOS/Linux.")
    result = _run([executable, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"])
    return sorted({int(value) for value in result.stdout.split() if value.isdigit()})


def _command(pid: int) -> str:
    return _run(["ps", "-ww", "-p", str(pid), "-o", "command="]).stdout.strip()


def _is_workbench(pid: int, command: str) -> bool:
    if pid == os.getpid():
        return False
    try:
        args = shlex.split(command)
    except ValueError:
        return False
    if len(args) >= 3 and args[1:3] == ["-m", "speaker_id.workbench.server"]:
        return True
    if len(args) < 2:
        return False
    cwd_result = _run([shutil.which("lsof") or "lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"])
    cwd = next((Path(line[1:]) for line in cwd_result.stdout.splitlines() if line.startswith("n/")), None)
    for arg in args[:2]:
        path = Path(arg)
        if not path.is_absolute():
            if cwd is None:
                continue
            path = cwd / path
        if path.resolve() == LAUNCHER.resolve():
            return True
        # setuptools console entry point, including virtual-environment installs.
        if path.name == "voice-workbench" and path.is_file():
            try:
                if "from speaker_id.workbench.server import main" in path.read_text():
                    return True
            except (OSError, UnicodeError):
                pass
    return False


def _wait_for_exit(commands: dict[int, str], seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if all(_command(pid) != command for pid, command in commands.items()):
            return True
        time.sleep(0.05)
    return False


def release_workbench_port(port: int) -> None:
    pids = _listeners(port)
    if not pids:
        raise RuntimeError(f"Port {port} is occupied, but its owner could not be identified. Try --port.")
    commands = {pid: _command(pid) for pid in pids}
    if not all(_is_workbench(pid, command) for pid, command in commands.items()):
        raise RuntimeError(f"Port {port} belongs to another application (PID {', '.join(map(str, pids))}). "
                           "It was not stopped. Choose another --port or stop it yourself.")
    print(f"Restarting workbench on port {port}…", flush=True)
    for pid, command in commands.items():
        # Recheck immediately before signaling to avoid a stale process identity.
        if _command(pid) == command:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    if _wait_for_exit(commands, 3):
        return
    for pid, command in commands.items():
        if _command(pid) == command:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if not _wait_for_exit(commands, 2):
        raise RuntimeError("The previous workbench could not be stopped. Stop it manually or use --port.")
