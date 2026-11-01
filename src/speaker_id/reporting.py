from __future__ import annotations

import csv
import json
import os
import tempfile
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from typing import Any


@contextmanager
def atomic_output(path: Path):
    """Readers see a complete previous or new export, never a partial write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=path.parent, encoding="utf-8",
                                         newline="", delete=False) as handle:
            temporary = Path(handle.name)
            yield handle
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def build_summary(segments: list[dict[str, Any]]) -> dict[str, float]:
    totals: dict[str, float] = defaultdict(float)
    for segment in segments:
        totals[segment["speaker"]] += max(0.0, float(segment["end"]) - float(segment["start"]))
    return {name: round(seconds, 3) for name, seconds in sorted(totals.items())}


def write_json_report(payload: dict[str, Any], path: Path) -> None:
    with atomic_output(path) as handle:
        handle.write(json.dumps(payload, indent=2, allow_nan=False) + "\n")


def write_csv_report(segments: list[dict[str, Any]], path: Path) -> None:
    fields = [
        "start",
        "end",
        "duration",
        "speaker",
        "cluster",
        "similarity",
        "margin",
    ]
    with atomic_output(path) as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for segment in segments:
            writer.writerow({key: segment[key] for key in fields})
