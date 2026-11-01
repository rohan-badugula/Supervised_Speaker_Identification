"""Run the local UI directly from a checkout, without installing the package."""

import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "backend" / "src"))
sys.path.insert(0, str(PROJECT / "frontend"))

from speaker_id.workbench.server import main

if __name__ == "__main__":
    main()
