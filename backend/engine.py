"""Local transcription worker. JSON lines over stdin/stdout, no HTTP server.

Downloads require an explicit command. Inference only opens local model files.
Audio and transcription text are never passed to Hugging Face or other services.
"""
from __future__ import annotations

import argparse
import gc
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import time
import traceback

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from text_processing import format_transcript, vocabulary_prompt

MODELS = {
    "turbo": {"name": "Whisper large-v3 turbo", "repo": "dropbox-dash/faster-whisper-large-v3-turbo",
              "revision": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf", "size": "1,6 ГБ"},
    "small": {"name": "Whisper small", "repo": "Systran/faster-whisper-small",
              "revision": "536b0662742c02347bc0e980a01041f333bce120", "size": "484 МБ"},
    "large-v3": {"name": "Whisper large-v3", "repo": "Systran/faster-whisper-large-v3",
                 "revision": "edaa852ec7e145841d8ffdb056a99866b5f0a478", "size": "3,1 ГБ"},
}
MODEL_FILES = ["model.bin", "config.json", "tokenizer.json", "vocabulary.json", "preprocessor_config.json"]
_output_lock = threading.Lock()


def emit(value):
    with _output_lock:
        print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def finite(value):
    return round(float(value), 4) if math.isfinite(float(value)) else 0.0


class Engine:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()
        self.models_dir = self.data_dir / "models"
        self.models_dir.mkdir(parents=True, exist_ok=True)
        audio_dir = self.data_dir / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        # Windows can redirect this child independently of the parent (MSIX).
        self.audio_dir = audio_dir.resolve()
        self.model = None
        self.loaded_key = None

    def audio_path(self, filename):
        if not isinstance(filename, str) or not re.fullmatch(
                r"[a-fA-F0-9-]+\.(?:wav|webm|mp3|m4a|ogg|flac|mp4)", filename):
            raise ValueError("Недопустимое имя аудиозаписи.")
        candidate = (self.audio_dir / filename).resolve()
        if not candidate.is_relative_to(self.audio_dir):
            raise ValueError("Аудиофайл должен находиться в папке записей приложения.")
        if not candidate.is_file():
            raise ValueError("Аудиофайл не найден.")
        return candidate

    def model_path(self, key):
        if key not in MODELS:
            raise ValueError("Неизвестная модель")
        return self.models_dir / key

    def is_installed(self, key):
        folder = self.model_path(key)
        try:
            marker = json.loads((folder / "shopot-ready.json").read_text("utf-8"))
            return marker.get("revision") == MODELS[key]["revision"] and all(
                (folder / f).is_file() and (folder / f).stat().st_size > 0
                for f in ("model.bin", "config.json", "tokenizer.json")
            )
        except (OSError, ValueError):
            return False

    def status(self):
        return {"models": [{"id": key, **value, "installed": self.is_installed(key)}
                           for key, value in MODELS.items()],
                "device": "cpu", "computeType": "int8", "loadedModel": self.loaded_key,
                "threads": min(8, max(1, os.cpu_count() or 4))}

    def download(self, key, request_id=None):
        folder = self.model_path(key)
        if self.is_installed(key):
            return self.status()
        from huggingface_hub import snapshot_download
        from tqdm.auto import tqdm

        class Progress(tqdm):
            def __init__(self, *args, **kwargs):
                self.last_report = 0.0
                super().__init__(*args, **kwargs)

            def update(self, n=1):
                result = super().update(n)
                now = time.monotonic()
                if now - self.last_report > 0.5:
                    self.last_report = now
                    emit({"event": "progress", "id": request_id, "stage": "download",
                          "model": key, "message": "Скачиваем модель…",
                          "completed": self.n, "total": self.total, "unit": self.unit})
                return result

        emit({"event": "progress", "id": request_id, "stage": "download", "model": key,
              "message": "Подключаемся к Hugging Face…"})
        snapshot_download(MODELS[key]["repo"], revision=MODELS[key]["revision"],
                          local_dir=str(folder), allow_patterns=MODEL_FILES, token=False,
                          tqdm_class=Progress)
        # The marker is written only after the entire snapshot download succeeds.
        marker = folder / "shopot-ready.json"
        marker.write_text(json.dumps({"revision": MODELS[key]["revision"]}), "utf-8")
        return self.status()

    def transcribe(self, request):
        key = request.get("model", "turbo")
        if not self.is_installed(key):
            raise ValueError("Сначала скачай выбранную модель в разделе «Модели».")
        audio_path = self.audio_path(request.get("audioFile"))
        language = request.get("language", "ru")
        if language not in ("ru", "en", "auto"):
            raise ValueError("Неизвестный язык")
        entries = request.get("dictionary", [])
        mode = request.get("mode", "natural")
        if mode not in ("natural", "minimal", "raw"):
            raise ValueError("Неизвестный режим текста")
        request_id = request.get("id")
        started = time.monotonic()
        if self.loaded_key != key:
            emit({"event": "progress", "id": request_id, "stage": "loading",
                  "message": "Загружаем модель в память…"})
            self.model = None
            self.loaded_key = None
            gc.collect()
            from faster_whisper import WhisperModel
            self.model = WhisperModel(str(self.model_path(key)), device="cpu", compute_type="int8",
                                      cpu_threads=min(8, os.cpu_count() or 4), local_files_only=True)
            self.loaded_key = key
        emit({"event": "progress", "id": request_id, "stage": "transcribe",
              "message": "Распознаём речь на компьютере…", "fraction": 0})
        from faster_whisper.audio import decode_audio
        import numpy as np
        audio = decode_audio(str(audio_path), sampling_rate=16000)
        duration = len(audio) / 16000
        if not len(audio):
            raise ValueError("Аудиофайл пуст.")
        if duration > 30 * 60:
            raise ValueError("Пока поддерживаются записи до 30 минут.")
        if not np.isfinite(audio).all():
            raise ValueError("Аудиофайл содержит повреждённые данные.")
        if float(np.max(np.abs(audio))) < 0.0001:
            return {"text": "", "rawText": "", "words": [], "segments": [], "replacements": [],
                    "duration": duration, "elapsed": finite(time.monotonic() - started),
                    "language": language, "model": key, "noSpeech": True}
        prompt = vocabulary_prompt(entries, request.get("context", ""))
        segments, info = self.model.transcribe(
            audio, language=None if language == "auto" else language, task="transcribe",
            beam_size=5, best_of=5, temperature=0.0,
            initial_prompt=prompt or None, hotwords=", ".join(e["word"] for e in entries)[:500] or None,
            condition_on_previous_text=False, word_timestamps=True,
            vad_filter=True, vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 300},
            hallucination_silence_threshold=2.0,
        )
        parsed = []
        words = []
        for segment in segments:
            parsed.append({"start": finite(segment.start), "end": finite(segment.end),
                           "text": segment.text.strip(), "noSpeechProbability": finite(segment.no_speech_prob)})
            words.extend({"start": finite(w.start), "end": finite(w.end), "word": w.word,
                          "probability": finite(w.probability)} for w in segment.words or [])
            emit({"event": "progress", "id": request_id, "stage": "transcribe",
                  "message": "Распознаём речь на компьютере…",
                  "fraction": min(1, segment.end / max(duration, 0.1))})
        raw = " ".join(s["text"] for s in parsed).strip()
        text, replacements = format_transcript(raw, entries, mode)
        return {"text": text, "rawText": raw, "words": words, "segments": parsed,
                "replacements": replacements, "duration": finite(duration),
                "elapsed": finite(time.monotonic() - started), "language": info.language,
                "model": key, "noSpeech": not bool(raw), "device": "cpu"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--download", choices=list(MODELS))
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    engine = Engine(args.data_dir)
    if args.self_check:
        import faster_whisper
        import ctranslate2
        import av
        import onnxruntime
        import tokenizers
        # Loading VAD verifies its bundled ONNX asset as well as native runtime libraries.
        from faster_whisper.vad import get_vad_model
        get_vad_model()
        emit({"ok": True, "ctranslate2": ctranslate2.__version__,
              "onnxruntime": onnxruntime.__version__, "device": "cpu"})
        return
    if args.download:
        engine.download(args.download)
        emit(engine.status())
        return
    emit({"event": "ready", "status": engine.status()})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            command = request.get("command")
            if command == "status":
                result = engine.status()
            elif command == "download":
                result = engine.download(request["model"], request.get("id"))
            elif command == "transcribe":
                result = engine.transcribe(request)
            else:
                raise ValueError("Неизвестная команда")
            emit({"id": request.get("id"), "result": result})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"id": request.get("id"), "error": str(error) or type(error).__name__})


if __name__ == "__main__":
    main()
