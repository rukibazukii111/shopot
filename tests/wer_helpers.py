"""Shared helpers for the WER measurement tests: scripts/ and backend/ on the path, tiny audio, fake models."""
import json
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
for folder in ("scripts", "backend"):
    if str(ROOT / folder) not in sys.path:
        sys.path.insert(0, str(ROOT / folder))
