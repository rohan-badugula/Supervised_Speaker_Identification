"""Run the local UI directly from a checkout, without installing the package."""

import os
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "backend" / "src"))
sys.path.insert(0, str(PROJECT / "frontend"))
os.environ["PYTHONPATH"] = os.pathsep.join([str(PROJECT / "backend" / "src"), str(PROJECT / "frontend"), os.environ.get("PYTHONPATH", "")])

from speaker_id.workbench.dev import main

if __name__ == "__main__":
    main()
