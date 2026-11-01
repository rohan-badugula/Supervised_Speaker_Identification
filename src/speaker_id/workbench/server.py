from __future__ import annotations

import argparse
import errno
import json
import math
import mimetypes
import re
import secrets
import socket
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from ..media import SUPPORTED_MEDIA
from .service import Workbench
from .lifecycle import release_workbench_port

STATIC = Path(__file__).parent / "static"
MAX_UPLOAD = 4 * 1024 ** 3
MAX_JSON = 5 * 1024 ** 2


def byte_range(header: str | None, size: int) -> tuple[int, int, bool]:
    if not header:
        return 0, size - 1, False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
    if not match or not any(match.groups()) or size == 0:
        raise ValueError("Invalid byte range.")
    left, right = match.groups()
    if not left:
        count = int(right)
        if count <= 0:
            raise ValueError("Invalid suffix range.")
        start, end = max(0, size - count), size - 1
    else:
        start, end = int(left), min(int(right), size - 1) if right else size - 1
    if start >= size or start > end:
        raise ValueError("Range outside file.")
    return start, end, True


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root: Path, **kwargs):
        self.token = secrets.token_urlsafe(32)
        super().__init__(address, Handler)
        try:
            self.app = Workbench(root, **kwargs)
        except Exception:
            super().server_close()
            raise

    def server_close(self):
        super().server_close()
        if hasattr(self, "app"):
            self.app.close()


class Handler(BaseHTTPRequestHandler):
    server: Server

    def setup(self):
        super().setup()
        self.connection.settimeout(120)

    def log_message(self, format, *args):
        # Request bodies, file names and tokens are intentionally not logged.
        pass

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; "
                         "style-src 'self' 'unsafe-inline'; media-src 'self' blob:; "
                         "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
        super().end_headers()

    def _local_request(self):
        port = self.server.server_address[1]
        host = self.headers.get("Host", "")
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if host not in allowed:
            raise PermissionError("This workbench only accepts localhost requests.")
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{host}":
            raise PermissionError("Cross-origin requests are not allowed.")

    def _json(self, value, status=200):
        body = json.dumps(value, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _payload(self):
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= MAX_JSON:
            raise ValueError("Request body is empty or too large.")
        value = json.loads(self.rfile.read(size))
        if not isinstance(value, dict):
            raise ValueError("Expected a JSON object.")
        return value

    def _file(self, path: Path, *, download=False):
        size = path.stat().st_size
        try:
            start, end, partial = byte_range(self.headers.get("Range"), size)
        except ValueError:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(max(0, end - start + 1)))
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                block = handle.read(min(1024 * 1024, remaining))
                if not block:
                    break
                self.wfile.write(block)
                remaining -= len(block)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            self._local_request()
            parts = urlparse(self.path).path.strip("/").split("/")
            if parts == ["api", "state"]:
                self._json({**self.server.app.state(), "csrf": self.server.token})
            elif len(parts) == 3 and parts[:2] == ["api", "media"]:
                self._file(self.server.app.media_path(parts[2]))
            elif len(parts) == 3 and parts[:2] == ["api", "report"]:
                self._json(self.server.app.report(parts[2]))
            elif len(parts) == 3 and parts[:2] == ["api", "labels"]:
                self.server.app.store.get("media", parts[2])
                self._file(self.server.app.store.path(f"annotations/{parts[2]}.json"), download=True)
            elif len(parts) == 4 and parts[:2] == ["api", "export"]:
                job = self.server.app.store.get("job", parts[2])
                if parts[3] not in {"json", "csv"} or job["status"] != "completed" or not job.get("report"):
                    raise FileNotFoundError("Export not available.")
                self._file(self.server.app.store.path(job["report"]).with_suffix("." + parts[3]), download=True)
            elif parts == [""]:
                self._file(STATIC / "index.html")
            elif len(parts) == 1 and parts[0] in {"app.js", "styles.css"}:
                self._file(STATIC / parts[0])
            else:
                raise FileNotFoundError("Page not found.")
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass
        except Exception as error:
            self._error(error)

    def do_POST(self):
        try:
            self._local_request()
            if not secrets.compare_digest(self.headers.get("X-Workbench-Token", ""), self.server.token):
                raise PermissionError("Refresh the workbench and retry.")
            url = urlparse(self.path)
            parts = url.path.strip("/").split("/")
            if parts == ["api", "upload"]:
                self._upload(parse_qs(url.query))
                return
            payload = self._payload()
            if parts == ["api", "jobs"]:
                self._json(self.server.app.submit(payload), 202)
            elif len(parts) == 4 and parts[:2] == ["api", "media"] and parts[3] == "annotations":
                self._json(self.server.app.annotations(parts[2], payload))
            elif len(parts) == 4 and parts[:2] == ["api", "media"] and parts[3] == "duration":
                duration = float(payload.get("duration", 0))
                if not math.isfinite(duration) or duration <= 0:
                    raise ValueError("Invalid media duration.")
                with self.server.app.lock:
                    media = self.server.app.store.get("media", parts[2])
                    if not media.get("duration"):
                        media["duration"] = duration
                        self.server.app.store.save("media", media)
                self._json({"saved": True})
            elif len(parts) == 3 and parts[:2] == ["api", "report"]:
                self._json(self.server.app.correct(parts[2], payload))
            else:
                raise FileNotFoundError("Action not found.")
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass
        except Exception as error:
            self._error(error)

    def _error(self, error):
        status = 403 if isinstance(error, PermissionError) else 404 if isinstance(error, FileNotFoundError) else 400
        if isinstance(error, (ValueError, RuntimeError, FileNotFoundError, PermissionError, TypeError)):
            self._json({"error": str(error)}, status)
        else:
            self._json({"error": "The action failed. Check the file and try again."}, 500)

    def _upload(self, query):
        name = Path(query.get("name", [""])[0]).name[:240]
        suffix = Path(name).suffix.lower()
        role = query.get("role", ["meeting"])[0]
        if suffix not in SUPPORTED_MEDIA or role not in {"meeting", "reference"}:
            raise ValueError("Choose a supported audio or video file.")
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= MAX_UPLOAD:
            raise ValueError("Files must be nonempty and no larger than 4 GiB.")
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("Chunked uploads are not supported.")
        identity = uuid4().hex
        relative = f"media/{identity}{suffix}"
        destination = self.server.app.store.path(relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".upload")
        try:
            with temporary.open("wb") as handle:
                remaining = size
                while remaining:
                    block = self.rfile.read(min(1024 * 1024, remaining))
                    if not block:
                        raise ValueError("Upload ended early. Please retry.")
                    handle.write(block)
                    remaining -= len(block)
            temporary.replace(destination)
            record = self.server.app.store.save("media", {
                "id": identity, "name": name, "path": relative, "role": role,
                "size": size, "video": suffix in {".mp4", ".mov", ".mkv", ".webm"},
                "duration": self.server.app.probe_duration(destination), "annotations": [], "revision": 0,
            })
        except Exception:
            temporary.unlink(missing_ok=True)
            destination.unlink(missing_ok=True)
            raise
        self._json(record, 201)


def main():
    parser = argparse.ArgumentParser(description="Local speaker-identification media workbench")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--data-dir", type=Path, default=Path("data/workbench"))
    parser.add_argument("--no-restart", action="store_true", help="Do not replace an existing workbench on this port")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("Port must be between 0 and 65535.")
    try:
        try:
            server = Server(("127.0.0.1", args.port), args.data_dir)
        except OSError as error:
            if error.errno != errno.EADDRINUSE or args.no_restart:
                raise
            release_workbench_port(args.port)
            server = Server(("127.0.0.1", args.port), args.data_dir)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Could not start workbench: {error}\n")
    print(f"Speaker workbench: http://127.0.0.1:{server.server_address[1]}", flush=True)
    print(f"Local workspace: {args.data_dir.resolve()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
