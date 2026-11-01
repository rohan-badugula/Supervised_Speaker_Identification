#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


TOOL_ROOT = Path(__file__).resolve().parent
WORKSPACE_ROOT = TOOL_ROOT.parent.parent
MAX_JSON_BYTES = 5_000_000


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9 _.-]+", "", value).strip().replace(" ", "_")
    cleaned = cleaned.strip("._-")
    if not cleaned:
        raise ValueError("Speaker name must contain letters or numbers.")
    return cleaned[:80]


def validate_annotations(payload: object) -> list[dict[str, object]]:
    if not isinstance(payload, list):
        raise ValueError("Annotations must be a list.")
    validated: list[dict[str, object]] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"Annotation {index + 1} must be an object.")
        start = float(item.get("start", -1))
        end = float(item.get("end", -1))
        speaker = str(item.get("speaker", "")).strip()
        flag = str(item.get("flag", "clean"))
        included = bool(item.get("included", True))
        if start < 0 or end <= start:
            raise ValueError(f"Annotation {index + 1} has an invalid time range.")
        if end - start > 300:
            raise ValueError(f"Annotation {index + 1} is longer than five minutes; use shorter clips.")
        if not speaker:
            raise ValueError(f"Annotation {index + 1} has no speaker label.")
        if flag not in {"clean", "overlap", "noise", "uncertain"}:
            raise ValueError(f"Annotation {index + 1} has an unsupported quality flag.")
        validated.append(
            {
                "id": str(item.get("id", index + 1)),
                "start": round(start, 3),
                "end": round(end, 3),
                "speaker": speaker[:120],
                "flag": flag,
                "included": included,
                "notes": str(item.get("notes", ""))[:500],
            }
        )
    return validated


class LabelerServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], source: Path):
        super().__init__(address, LabelerHandler)
        self.source = source.resolve()
        project = safe_name(self.source.stem)
        self.annotation_path = WORKSPACE_ROOT / "data" / "annotations" / f"{project}.json"
        self.export_root = WORKSPACE_ROOT / "data" / "enrollment"


class LabelerHandler(BaseHTTPRequestHandler):
    server: LabelerServer

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[labeler] {format_string % args}")

    def _json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = 400) -> None:
        self._json({"error": message}, status)

    def _read_json(self) -> object:
        size = int(self.headers.get("Content-Length", "0"))
        if size <= 0 or size > MAX_JSON_BYTES:
            raise ValueError("Request body is empty or too large.")
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def _serve_asset(self, name: str) -> None:
        asset = (TOOL_ROOT / name).resolve()
        if asset.parent != TOOL_ROOT or not asset.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = asset.read_bytes()
        mime = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith("text/") else mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _serve_audio(self) -> None:
        source = self.server.source
        size = source.stat().st_size
        range_header = self.headers.get("Range")
        start, end = 0, size - 1
        status = HTTPStatus.OK
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            if match.group(1):
                start = int(match.group(1))
            if match.group(2):
                end = min(int(match.group(2)), size - 1)
            if start >= size or start > end:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            status = HTTPStatus.PARTIAL_CONTENT

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", mimetypes.guess_type(source.name)[0] or "audio/mpeg")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with source.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/":
            self._serve_asset("index.html")
        elif path in {"/app.js", "/styles.css"}:
            self._serve_asset(path.removeprefix("/"))
        elif path == "/api/audio":
            self._serve_audio()
        elif path == "/api/project":
            annotations: list[dict[str, object]] = []
            if self.server.annotation_path.is_file():
                stored = json.loads(self.server.annotation_path.read_text(encoding="utf-8"))
                annotations = stored.get("annotations", [])
            self._json(
                {
                    "source": self.server.source.name,
                    "annotations": annotations,
                    "annotationPath": str(self.server.annotation_path),
                    "ffmpegAvailable": shutil.which("ffmpeg") is not None,
                }
            )
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
            if path == "/api/annotations":
                annotations = validate_annotations(payload)
                self._save_annotations(annotations)
                self._json({"saved": len(annotations), "path": str(self.server.annotation_path)})
            elif path == "/api/export":
                annotations = validate_annotations(payload)
                exported = self._export_clips(annotations)
                self._save_annotations(annotations)
                self._json({"exported": exported, "root": str(self.server.export_root)})
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except (ValueError, json.JSONDecodeError) as error:
            self._error(str(error))
        except subprocess.CalledProcessError as error:
            self._error(f"FFmpeg failed while exporting a clip: {error}", 500)
        except OSError as error:
            self._error(str(error), 500)

    def _save_annotations(self, annotations: list[dict[str, object]]) -> None:
        path = self.server.annotation_path
        path.parent.mkdir(parents=True, exist_ok=True)
        document = {
            "formatVersion": 1,
            "source": str(self.server.source),
            "annotations": annotations,
        }
        with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as handle:
            json.dump(document, handle, indent=2)
            handle.write("\n")
            temporary = Path(handle.name)
        os.replace(temporary, path)

    def _export_clips(self, annotations: list[dict[str, object]]) -> int:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise ValueError("FFmpeg is required for clip export. Install it with `brew install ffmpeg`.")

        exported = 0
        project = safe_name(self.server.source.stem)
        for index, annotation in enumerate(annotations, start=1):
            if not annotation["included"] or annotation["flag"] != "clean":
                continue
            speaker = safe_name(str(annotation["speaker"]))
            start = float(annotation["start"])
            duration = float(annotation["end"]) - start
            destination = self.server.export_root / speaker / f"{project}_{index:04d}_{start:010.3f}.wav"
            destination.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-ss",
                    f"{start:.3f}",
                    "-i",
                    str(self.server.source),
                    "-t",
                    f"{duration:.3f}",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    str(destination),
                ],
                check=True,
            )
            exported += 1
        return exported


def main() -> None:
    parser = argparse.ArgumentParser(description="Label and export speaker clips from a long recording.")
    parser.add_argument("source", type=Path, help="Long MP3, WAV, M4A, or video recording.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    source = args.source.expanduser().resolve()
    if not source.is_file():
        parser.error(f"recording not found: {source}")

    server = LabelerServer((args.host, args.port), source)
    print(f"VoiceSet Labeler: http://{args.host}:{args.port}")
    print(f"Recording: {source}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
