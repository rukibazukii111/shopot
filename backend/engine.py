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
import queue
import re
import sys
import threading
import time
import traceback

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from text_processing import format_transcript, join_segments, vocabulary_prompt

WHISPER_FILES = ["model.bin", "config.json", "tokenizer.json", "vocabulary.json", "preprocessor_config.json"]
GIGAAM_FILES = ["config.json", "v3_e2e_rnnt_encoder.int8.onnx", "v3_e2e_rnnt_decoder.int8.onnx",
                "v3_e2e_rnnt_joint.int8.onnx", "v3_e2e_rnnt_vocab.txt"]
MODELS = {
    # GigaAM (Sber, MIT): Russian only, no 30 s padding, so short phrases take a fraction of a second.
    "gigaam": {"name": "GigaAM v3", "repo": "istupakov/gigaam-v3-onnx", "engine": "gigaam",
               "revision": "322c3b29492673eb7d0b434bfa9dfb8653e34d02", "size": "216 МБ",
               "languages": ["ru"], "files": GIGAAM_FILES, "required": GIGAAM_FILES},
    "turbo": {"name": "Whisper large-v3 turbo", "repo": "dropbox-dash/faster-whisper-large-v3-turbo",
              "revision": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf", "size": "1,6 ГБ"},
    "small": {"name": "Whisper small", "repo": "Systran/faster-whisper-small",
              "revision": "536b0662742c02347bc0e980a01041f333bce120", "size": "484 МБ"},
    "large-v3": {"name": "Whisper large-v3", "repo": "Systran/faster-whisper-large-v3",
                 "revision": "edaa852ec7e145841d8ffdb056a99866b5f0a478", "size": "3,1 ГБ"},
}
for _model in MODELS.values():
    _model.setdefault("engine", "whisper")
    _model.setdefault("languages", ["ru", "en", "auto"])
    _model.setdefault("files", WHISPER_FILES)
    _model.setdefault("required", ["model.bin", "config.json", "tokenizer.json"])
# GigaAM is trained on utterances up to ~25 s; longer speech is split at VAD pauses.
GIGAAM_MAX_CHUNK_SECONDS = 20
VAD_OPTIONS = {"min_silence_duration_ms": 500, "speech_pad_ms": 300}
# Measured: above 4 threads Whisper gains <15% but starves the rest of the system (laptops freeze).
THREADS = max(1, min(4, (os.cpu_count() or 4) // 2))
IDLE_UNLOAD_SECONDS = 10 * 60
_output_lock = threading.Lock()


class Canceled(Exception):
    pass


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
        # The model is shared by the command thread and the idle-unload timer.
        self.model_lock = threading.RLock()
        # Requests with id <= this value were canceled, including ones still queued.
        self.canceled_through = 0
        self.idle_timer = None

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
                for f in MODELS[key]["required"]
            )
        except (OSError, ValueError):
            return False

    def status(self):
        return {"models": [{"id": key, "name": value["name"], "size": value["size"], "engine": value["engine"],
                            "languages": value["languages"], "installed": self.is_installed(key)}
                           for key, value in MODELS.items()],
                "device": "cpu", "computeType": "int8", "loadedModel": self.loaded_key,
                "threads": THREADS}

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
                          local_dir=str(folder), allow_patterns=MODELS[key]["files"], token=False,
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
        if language not in MODELS[key]["languages"]:
            raise ValueError(f"{MODELS[key]['name']} распознаёт только русский. "
                             "Для других языков выбери Whisper в разделе «Модели».")
        entries = request.get("dictionary", [])
        mode = request.get("mode", "natural")
        if mode not in ("natural", "minimal", "raw"):
            raise ValueError("Неизвестный режим текста")
        request_id = request.get("id")
        with self.model_lock:
            self.cancel_idle_unload()
            try:
                return self._transcribe(request, key, audio_path, language, entries, mode, request_id)
            finally:
                self.schedule_idle_unload()

    def load(self, key, request_id=None):
        """Load the model if needed; returns seconds spent loading."""
        with self.model_lock:
            if self.loaded_key == key:
                return 0.0
            if not self.is_installed(key):
                return 0.0
            started = time.monotonic()
            emit({"event": "progress", "id": request_id, "stage": "loading",
                  "message": "Загружаем модель в память…"})
            self.unload()
            if MODELS[key]["engine"] == "gigaam":
                import onnx_asr
                import onnxruntime
                options = onnxruntime.SessionOptions()
                options.intra_op_num_threads = THREADS
                options.inter_op_num_threads = 1
                self.model = onnx_asr.load_model("gigaam-v3-e2e-rnnt", self.model_path(key),
                                                 quantization="int8", sess_options=options)
            else:
                from faster_whisper import WhisperModel
                self.model = WhisperModel(str(self.model_path(key)), device="cpu", compute_type="int8",
                                          cpu_threads=THREADS, local_files_only=True)
            self.loaded_key = key
            return time.monotonic() - started

    def unload(self):
        with self.model_lock:
            self.model = None
            self.loaded_key = None
            gc.collect()

    def preload(self, key):
        """Warm the model while the user is still speaking."""
        with self.model_lock:
            self.cancel_idle_unload()
            try:
                self.load(key)
            finally:
                self.schedule_idle_unload()

    def cancel_idle_unload(self):
        if self.idle_timer:
            self.idle_timer.cancel()
            self.idle_timer = None

    def schedule_idle_unload(self):
        # Free RAM between dictations; preload on the hotkey hides the reload cost.
        self.cancel_idle_unload()
        timer = threading.Timer(IDLE_UNLOAD_SECONDS, lambda: self._idle_unload(timer))
        timer.daemon = True
        self.idle_timer = timer
        timer.start()

    def _idle_unload(self, timer):
        with self.model_lock:
            # A request may have run while this timer waited for the lock.
            if self.idle_timer is timer:
                self.idle_timer = None
                self.unload()

    def check_canceled(self, request_id):
        if isinstance(request_id, int) and request_id <= self.canceled_through:
            raise Canceled("Операция отменена.")

    def _transcribe(self, request, key, audio_path, language, entries, mode, request_id):
        started = time.monotonic()
        self.check_canceled(request_id)
        load_elapsed = self.load(key, request_id)
        self.check_canceled(request_id)
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
        if MODELS[key]["engine"] == "gigaam":
            parsed = self._gigaam_segments(audio, duration, request_id)
            raw = join_segments([s["text"] for s in parsed], [e["word"] for e in entries])
            words, detected = [], "ru"
        else:
            parsed, words, detected = self._whisper_segments(audio, duration, language, entries, request, request_id)
            raw = " ".join(s["text"] for s in parsed).strip()
        text, replacements = format_transcript(raw, entries, mode)
        return {"text": text, "rawText": raw, "words": words, "segments": parsed,
                "replacements": replacements, "duration": finite(duration),
                "elapsed": finite(time.monotonic() - started), "language": detected,
                "model": key, "noSpeech": not bool(raw), "device": "cpu",
                "loadElapsed": finite(load_elapsed)}

    def _progress(self, request_id, fraction):
        emit({"event": "progress", "id": request_id, "stage": "transcribe",
              "message": "Распознаём речь на компьютере…", "fraction": min(1, fraction)})

    def _gigaam_segments(self, audio, duration, request_id):
        from faster_whisper.vad import VadOptions, get_speech_timestamps
        speech = get_speech_timestamps(audio, VadOptions(**VAD_OPTIONS, max_speech_duration_s=GIGAAM_MAX_CHUNK_SECONDS))
        parsed = []
        for start, end in speech_windows(speech, GIGAAM_MAX_CHUNK_SECONDS * 16000):
            self.check_canceled(request_id)
            # Pauses inside a window are kept: they help the model place punctuation.
            text = self.model.recognize(audio[start:end], sample_rate=16000).strip()
            if text:
                parsed.append({"start": finite(start / 16000), "end": finite(end / 16000),
                               "text": text, "noSpeechProbability": 0.0})
            self._progress(request_id, end / 16000 / max(duration, 0.1))
        return parsed

    def _whisper_segments(self, audio, duration, language, entries, request, request_id):
        prompt = vocabulary_prompt(entries, request.get("context", ""))
        segments, info = self.model.transcribe(
            audio, language=None if language == "auto" else language, task="transcribe",
            beam_size=5, temperature=0.0,
            initial_prompt=prompt or None, hotwords=", ".join(e["word"] for e in entries)[:500] or None,
            condition_on_previous_text=False, word_timestamps=True,
            vad_filter=True, vad_parameters=VAD_OPTIONS,
            hallucination_silence_threshold=2.0,
        )
        parsed = []
        words = []
        for segment in segments:
            self.check_canceled(request_id)
            parsed.append({"start": finite(segment.start), "end": finite(segment.end),
                           "text": segment.text.strip(), "noSpeechProbability": finite(segment.no_speech_prob)})
            words.extend({"start": finite(w.start), "end": finite(w.end), "word": w.word,
                          "probability": finite(w.probability)} for w in segment.words or [])
            self._progress(request_id, segment.end / max(duration, 0.1))
        return parsed, words, info.language


def speech_windows(speech, max_samples):
    """Group VAD speech regions into contiguous windows no longer than max_samples."""
    windows = []
    for region in speech:
        if windows and region["end"] - windows[-1][0] <= max_samples:
            windows[-1][1] = region["end"]
        else:
            windows.append([region["start"], region["end"]])
    return [tuple(w) for w in windows]


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
        import onnx_asr
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
    if sys.platform == "darwin":
        # Keep the Mac responsive: inference yields to foreground apps.
        os.nice(5)
    emit({"event": "ready", "status": engine.status()})
    # On Windows, loading a native extension deadlocks while another thread is blocked reading
    # stdin. Import them before the reader starts; commands wait in the pipe meanwhile.
    import numpy  # noqa: F401
    import onnxruntime  # noqa: F401
    import onnx_asr  # noqa: F401
    import faster_whisper  # noqa: F401
    from faster_whisper import vad  # noqa: F401
    requests = queue.Queue()

    def read_commands():
        # Control commands bypass the queue so they apply to the running request.
        last_id = 0
        for line in sys.stdin:
            try:
                request = json.loads(line)
            except ValueError:
                continue
            if isinstance(request.get("id"), int):
                last_id = request["id"]
            if request.get("command") == "cancel":
                engine.canceled_through = last_id
            elif request.get("command") == "preload":
                requests.put({**request, "id": None})
            else:
                requests.put(request)
        requests.put(None)

    threading.Thread(target=read_commands, daemon=True).start()
    while (request := requests.get()) is not None:
        try:
            command = request.get("command")
            if command == "preload":
                if request.get("model") in MODELS:
                    engine.preload(request["model"])
                continue
            if command == "status":
                result = engine.status()
            elif command == "download":
                result = engine.download(request["model"], request.get("id"))
            elif command == "transcribe":
                result = engine.transcribe(request)
            else:
                raise ValueError("Неизвестная команда")
            emit({"id": request.get("id"), "result": result})
        except Canceled as error:
            emit({"id": request.get("id"), "error": str(error), "canceled": True})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            if request.get("id") is not None:
                emit({"id": request.get("id"), "error": str(error) or type(error).__name__})


if __name__ == "__main__":
    main()
