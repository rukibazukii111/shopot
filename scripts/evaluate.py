"""Transcribe a supplied local sample with/without vocabulary, with networking blocked.

This compares outputs, not accuracy: an accurate WER needs a verified reference.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from engine import Engine

parser = argparse.ArgumentParser()
parser.add_argument("audio", type=Path)
parser.add_argument("--data-dir", type=Path, default=Path(".local"))
parser.add_argument("--output", type=Path, default=Path(".private/comparison.json"))
parser.add_argument("--model", default="turbo")
args = parser.parse_args()
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
os.environ["HF_HUB_OFFLINE"] = "1"


def block_network(*args, **kwargs):
    raise RuntimeError("Network is disabled during the offline transcription check")


socket.socket.connect = block_network
engine = Engine(args.data_dir)
sample = engine.audio_dir / (str(uuid.uuid4()) + args.audio.suffix.lower())
shutil.copyfile(args.audio, sample)
terms = ["Whisper", "GitHub", "iOS", "iPhone", "Reels", "TikTok", "YouTube", "VPN"]
results = {}
try:
    for name, dictionary in (("without_dictionary", []), ("with_dictionary", [{"word": w, "aliases": []} for w in terms])):
        print(f"Running {name}", flush=True)
        results[name] = engine.transcribe({"audioFile": sample.name, "model": args.model, "language": "ru", "mode": "natural", "dictionary": dictionary})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2), "utf-8")
        print(json.dumps({"case": name, "duration": results[name]["duration"], "elapsed": results[name]["elapsed"], "words": len(results[name]["words"])}), flush=True)
finally:
    sample.unlink(missing_ok=True)
print(f"Saved comparison to {args.output}", flush=True)
