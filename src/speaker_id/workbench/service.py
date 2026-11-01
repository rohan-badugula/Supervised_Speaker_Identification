from __future__ import annotations

import importlib.util
import math
import os
import shutil
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from time import perf_counter
from uuid import uuid4

import numpy as np

from ..backends import MODEL_SPECS, get_model, load_backend
from ..matching import centroid
from ..media import convert_to_wav, require_ffmpeg
from ..pipeline import identify_speakers, resolve_token
from ..profiles import ProfileBundle, load_profiles, save_profiles
from ..provenance import package_versions, sha256_file
from ..reporting import build_summary, write_csv_report, write_json_report
from .store import Store


ACTIVE = {"queued", "running"}


def validate_segments(items: object, duration: float | None = None) -> list[dict]:
    if not isinstance(items, list) or len(items) > 10000:
        raise ValueError("Expected a list of at most 10,000 segments.")
    segments = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError("Each segment must be an object.")
        start, end = float(item.get("start", -1)), float(item.get("end", -1))
        speaker = str(item.get("speaker", "")).strip()
        flag = item.get("flag", "clean")
        if not math.isfinite(start + end) or start < 0 or end <= start:
            raise ValueError("Segment timestamps must be finite, nonnegative and increasing.")
        if duration and end > duration + 0.1:
            raise ValueError("A segment extends past the end of the recording.")
        if not speaker or len(speaker) > 80 or speaker == "UNKNOWN":
            raise ValueError("Use a speaker label of 1–80 characters other than UNKNOWN.")
        if flag not in {"clean", "overlap", "noise", "uncertain"}:
            raise ValueError("Invalid segment quality flag.")
        segments.append({"id": str(item.get("id", index))[:80], "start": round(start, 3),
                         "end": round(end, 3), "speaker": speaker, "flag": flag,
                         "included": bool(item.get("included", True))})
    return sorted(segments, key=lambda item: (item["start"], item["end"]))


class Workbench:
    def __init__(self, root: Path, *, backend_loader=load_backend):
        self.store = Store(root)
        self.backend_loader = backend_loader
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voice-workbench")
        self.lock = threading.RLock()
        # A previous process cannot still own these jobs. Do not silently rerun ML.
        for job in self.store.list("job"):
            if job["status"] in ACTIVE:
                job.update(status="interrupted", stage="Interrupted by server restart",
                           error="Server stopped before this job finished. Start a new run to retry.")
                self.store.save("job", job)

    def close(self):
        self.pool.shutdown(wait=False, cancel_futures=True)

    def state(self) -> dict:
        return {"media": self.store.list("media"), "collections": self.store.list("collection"),
                "jobs": self.store.list("job"), "models": [asdict(spec) for spec in MODEL_SPECS],
                "health": {"ffmpeg": bool(shutil.which("ffmpeg")),
                           "audio": importlib.util.find_spec("pyannote") is not None,
                           "ecapa": importlib.util.find_spec("speechbrain") is not None,
                           "token": bool(os.environ.get("HF_TOKEN"))}}

    def media_path(self, identity: str) -> Path:
        return self.store.path(self.store.get("media", identity)["path"])

    def probe_duration(self, path: Path) -> float | None:
        executable = shutil.which("ffprobe")
        if not executable:
            return None
        try:
            result = subprocess.run([executable, "-v", "error", "-show_entries", "format=duration",
                                     "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                                    capture_output=True, text=True, check=True, timeout=30)
            value = float(result.stdout.strip())
            return value if math.isfinite(value) and value > 0 else None
        except (ValueError, subprocess.SubprocessError):
            return None

    def annotations(self, identity: str, payload: dict) -> dict:
        with self.lock:
            media = self.store.get("media", identity)
            # Prevent silent overwrites from two open tabs.
            if payload.get("revision", 0) != media.get("revision", 0):
                raise ValueError("Labels changed in another tab. Reload the recording before saving.")
            media["annotations"] = validate_segments(payload.get("annotations"), media.get("duration"))
            media["revision"] = media.get("revision", 0) + 1
            write_json_report({"source_id": identity, "revision": media["revision"],
                               "annotations": media["annotations"]},
                              self.store.path(f"annotations/{identity}.json"))
            return self.store.save("media", media)

    def submit(self, payload: dict) -> dict:
        with self.lock:
            if sum(job["status"] in ACTIVE for job in self.store.list("job")) >= 4:
                raise ValueError("Four jobs are already active. Wait for one to finish.")
            kind = payload.get("kind")
            if kind not in {"enroll", "identify"}:
                raise ValueError("Unknown job type.")
            spec = get_model(str(payload.get("model", "community-1")))
            media = self.store.get("media", str(payload.get("media_id", "")))
            job = {"id": uuid4().hex, "kind": kind, "media_id": media["id"],
                   "media_name": media["name"], "model": spec.key, "status": "queued",
                   "stage": "Waiting for worker", "error": None}
            if kind == "enroll":
                segments = validate_segments(media.get("annotations", []), media.get("duration"))
                segments = [item for item in segments if item["included"] and item["flag"] == "clean"]
                if not segments:
                    raise ValueError("Save at least one clean reference segment before building profiles.")
                if any(item["end"] - item["start"] < 1 for item in segments):
                    raise ValueError("Reference clips must contain at least one second of speech.")
                job["annotations"] = segments  # Immutable snapshot for queued jobs.
                name = str(payload.get("name", "Voice collection")).strip()
                if not name or len(name) > 100:
                    raise ValueError("Collection name must contain 1–100 characters.")
                job["collection_name"] = name
            else:
                identity = payload.get("collection_id")
                if identity:
                    collection = self.store.get("collection", str(identity))
                    if collection["model_id"] != spec.model_id:
                        raise ValueError("Choose a profile collection built with the selected model.")
                    job["collection_id"] = collection["id"]
                job["threshold"] = float(payload.get("threshold", 0.55))
                job["margin"] = float(payload.get("margin", 0.08))
                if not -1 <= job["threshold"] <= 1 or not 0 <= job["margin"] <= 2:
                    raise ValueError("Invalid similarity threshold or margin.")
                for key in ("min_speakers", "max_speakers"):
                    raw = payload.get(key)
                    value = int(raw) if raw not in (None, "") else None
                    if value is not None and (value < 1 or value > 100):
                        raise ValueError("Speaker bounds must be between 1 and 100.")
                    job[key] = value
                if job["min_speakers"] and job["max_speakers"] and job["min_speakers"] > job["max_speakers"]:
                    raise ValueError("Minimum speakers cannot exceed maximum speakers.")
            # Fail before queueing when the local runtime is not ready.
            require_ffmpeg()
            resolve_token(None)
            if self.backend_loader is load_backend:
                if importlib.util.find_spec("pyannote") is None:
                    raise ValueError("Audio models are not installed. See the Setup panel.")
                if spec.embedding_model and importlib.util.find_spec("speechbrain") is None:
                    raise ValueError("ECAPA is not installed. Select Community-1 or install the ECAPA extra.")
            job = self.store.save("job", job)
            self.pool.submit(self._run, job["id"])
            return job

    def _update(self, identity: str, **changes):
        with self.lock:
            job = self.store.get("job", identity)
            job.update(changes)
            self.store.save("job", job)

    def _run(self, identity: str):
        started = perf_counter()
        try:
            job = self.store.get("job", identity)
            self._update(identity, status="running", stage="Loading model weights")
            spec = get_model(job["model"])
            backend = self.backend_loader(spec.key, token=resolve_token(None), device="cpu")
            source = self.media_path(job["media_id"])
            if job["kind"] == "enroll":
                self._enroll(job, backend, source)
            else:
                self._identify(job, backend, source)
            self._update(identity, status="completed", stage="Complete",
                         elapsed_seconds=round(perf_counter() - started, 2))
        except Exception as error:
            # Keep tokens out of persisted error messages from external libraries.
            message = str(error)[:1500]
            token = os.environ.get("HF_TOKEN")
            if token:
                message = message.replace(token, "[redacted]")
            self._update(identity, status="failed", stage="Processing failed", error=message)

    def _enroll(self, job, backend, source):
        self._update(job["id"], stage="Extracting clean reference clips")
        embeddings, counts = {}, {}
        with tempfile.TemporaryDirectory(prefix="voice-reference-") as directory:
            for index, segment in enumerate(job["annotations"]):
                self._update(job["id"], stage=f"Embedding reference {index + 1} of {len(job['annotations'])}")
                clip = Path(directory) / f"{index}.wav"
                subprocess.run([require_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
                                "-ss", str(segment["start"]), "-i", str(source),
                                "-t", str(segment["end"] - segment["start"]), "-vn", "-ac", "1",
                                "-ar", "16000", "-c:a", "pcm_s16le", str(clip)],
                               capture_output=True, check=True, timeout=300)
                name = segment["speaker"]
                embeddings.setdefault(name, []).append(backend.embed_enrollment(clip))
                counts[name] = counts.get(name, 0) + 1
        collection_id = uuid4().hex
        relative = f"profiles/{collection_id}/voiceprints.npz"
        bundle = ProfileBundle({name: centroid(values) for name, values in embeddings.items()},
                               counts, backend.model_id)
        save_profiles(bundle, self.store.path(relative))
        metadata = {"id": collection_id, "name": job["collection_name"], "model": job["model"],
                    "model_id": backend.model_id, "path": relative, "media_id": job["media_id"],
                    "speakers": [{"name": name, "clips": counts[name], "seconds": round(sum(
                        s["end"] - s["start"] for s in job["annotations"] if s["speaker"] == name), 2)}
                        for name in sorted(embeddings)], "annotations": job["annotations"]}
        write_json_report(metadata, self.store.path(f"profiles/{collection_id}/metadata.json"))
        self.store.save("collection", metadata)
        self._update(job["id"], collection_id=collection_id)

    def _identify(self, job, backend, source):
        self._update(job["id"], stage="Converting audio and analyzing speakers")
        options = {key: job.get(key) for key in ("min_speakers", "max_speakers")}
        if job.get("collection_id"):
            collection = self.store.get("collection", job["collection_id"])
            profile_path = self.store.path(collection["path"])
            report = identify_speakers(backend, source, load_profiles(profile_path),
                                      threshold=job["threshold"], minimum_margin=job["margin"], **options)
            report["profiles_sha256"] = sha256_file(profile_path)
        else:
            with tempfile.TemporaryDirectory(prefix="voice-meeting-") as directory:
                output = backend.diarize(convert_to_wav(source, Path(directory) / "audio.wav"), **options)
            # Stable within this recording only, ordered by first appearance.
            names = {}
            segments = []
            for turn in sorted(output.turns, key=lambda item: (item.start, item.end, item.cluster)):
                names.setdefault(turn.cluster, f"Person {len(names) + 1}")
                segments.append({"start": round(turn.start, 3), "end": round(turn.end, 3),
                                 "duration": round(turn.end - turn.start, 3), "cluster": turn.cluster,
                                 "speaker": names[turn.cluster], "similarity": None, "margin": None})
            report = {"schema_version": 2, "model": backend.model_id, "segments": segments,
                      "summary_seconds": build_summary(segments), "mode": "anonymous"}
        report.update(media_id=job["media_id"], job_id=job["id"], source_sha256=sha256_file(source))
        report.setdefault("mode", "identified")
        report["configuration"] = {"model": asdict(get_model(job["model"])), "device": "cpu",
                                   "package_versions": package_versions(), "options": options}
        self._update(job["id"], stage="Saving speaker timeline")
        relative = f"reports/{job['id']}.json"
        write_json_report(report, self.store.path(relative))
        write_csv_report(report["segments"], self.store.path(relative).with_suffix(".csv"))
        self._update(job["id"], report=relative)

    def report(self, identity: str) -> dict:
        import json
        job = self.store.get("job", identity)
        if job["status"] != "completed" or not job.get("report"):
            raise ValueError("This job does not have a completed timeline.")
        return json.loads(self.store.path(job["report"]).read_text())

    def correct(self, identity: str, payload: dict) -> dict:
        with self.lock:
            report = self.report(identity)
            if payload.get("revision", 0) != report.get("revision", 0):
                raise ValueError("Timeline changed in another tab. Reload before saving.")
            labels = payload.get("labels")
            if not isinstance(labels, dict):
                raise ValueError("Expected segment labels.")
            for index, label in labels.items():
                position = int(index)
                label = str(label).strip()
                if not 0 <= position < len(report["segments"]) or not label or len(label) > 80:
                    raise ValueError("Invalid timeline correction.")
                segment = report["segments"][position]
                segment.setdefault("predicted_speaker", segment["speaker"])
                segment["speaker"] = label
                segment["reviewed"] = True
            report["summary_seconds"] = build_summary(report["segments"])
            report["revision"] = report.get("revision", 0) + 1
            job = self.store.get("job", identity)
            path = self.store.path(job["report"])
            # Preserve the model output separately on the first human edit.
            original = path.with_name(path.stem + ".original.json")
            if not original.exists():
                shutil.copyfile(path, original)
            temporary = path.with_suffix(".tmp")
            write_json_report(report, temporary)
            os.replace(temporary, path)
            write_csv_report(report["segments"], path.with_suffix(".csv"))
            return report
