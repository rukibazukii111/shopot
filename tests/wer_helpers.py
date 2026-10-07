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


def write_tone(path, seconds=1.0, rate=16000):
    """A mono 16-bit WAV with a 440 Hz tone: something every decoder reads."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(rate * seconds)) / rate
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((0.3 * np.sin(2 * np.pi * 440 * t) * 32767).astype("<i2").tobytes())
    return path


def fake_models(folder):
    """A models folder where GigaAM counts as downloaded; the tests fake recognition itself."""
    from engine import GIGAAM_FILES, MODELS
    gigaam = Path(folder) / "gigaam"
    gigaam.mkdir(parents=True)
    (gigaam / "shopot-ready.json").write_text(json.dumps({"revision": MODELS["gigaam"]["revision"]}), "utf-8")
    for name in GIGAAM_FILES:
        (gigaam / name).write_bytes(b"x")
    return Path(folder)
