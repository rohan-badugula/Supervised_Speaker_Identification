from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


class Store:
    """Small persistent local catalog. Each operation uses its own connection."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.database = self.root / "catalog.sqlite3"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS records "
                       "(id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, updated TEXT NOT NULL)")

    def connect(self):
        return sqlite3.connect(self.database, timeout=30)

    def save(self, kind: str, record: dict) -> dict:
        record = dict(record)
        record.setdefault("id", uuid4().hex)
        record["updated"] = datetime.now(timezone.utc).isoformat()
        with self.connect() as db:
            db.execute("INSERT INTO records VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE "
                       "SET body=excluded.body, updated=excluded.updated WHERE records.kind=excluded.kind",
                       (record["id"], kind, json.dumps(record, allow_nan=False), record["updated"]))
        return record

    def get(self, kind: str, identity: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT body FROM records WHERE kind=? AND id=?", (kind, identity)).fetchone()
        if row is None:
            raise FileNotFoundError(f"{kind.capitalize()} not found.")
        return json.loads(row[0])

    def list(self, kind: str) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT body FROM records WHERE kind=? ORDER BY updated DESC", (kind,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def path(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("Invalid workspace path.")
        return path

    def claim_job(self, worker_id: str) -> dict | None:
        """Atomically claim the oldest queued job across process boundaries."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT id, body FROM records WHERE kind='job' ORDER BY updated").fetchall()
            for identity, body in rows:
                job = json.loads(body)
                if job.get('status') != 'queued':
                    continue
                job.update(status='running', claimed_by=worker_id,
                           updated=datetime.now(timezone.utc).isoformat())
                db.execute("UPDATE records SET body=?, updated=? WHERE id=? AND kind='job'",
                           (json.dumps(job, allow_nan=False), job['updated'], identity))
                return job
        return None
