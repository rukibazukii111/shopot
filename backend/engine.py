"""Local transcription worker. JSON lines over stdin/stdout, no HTTP server.

Downloads require an explicit command. Inference only opens local model files.
Audio and transcription text are never passed to Hugging Face or other services.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import queue
import re
import sys
import threading
import time
import traceback
import urllib.request
import zipfile

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import llm
import memory
from text_processing import (apply_voice_commands, expand_snippets, format_transcript, join_segments, layout_text,
                             pause_sentences, split_sentences, strip_hesitations, vocabulary_prompt)

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
# A gap this long between VAD regions (~1.6 s of silence with padding) usually ends a thought: new paragraph.
PARAGRAPH_PAUSE_SECONDS = 1.0
# Optional layout model: official llama.cpp build (loaded in-process, no server) plus Qwen3-4B.
# Both are pinned by hash; the runtime is verified before anything is extracted from it.
FORMATTER = {
    "name": "Qwen3-4B", "size": "2,4 ГБ",
    "model": {"repo": "unsloth/Qwen3-4B-Instruct-2507-GGUF", "revision": "a06e946bb6b655725eafa393f4a9745d460374c9",
              "file": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "bytes": 2497281120,
              "sha256": "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"},
    "runtimes": {
        ("win32", "amd64"): {"url": f"https://github.com/ggml-org/llama.cpp/releases/download/{llm.LLAMA_BUILD}/"
                                    f"llama-{llm.LLAMA_BUILD}-bin-win-vulkan-x64.zip",
                             "sha256": "1f71a94bb3b7f615f110b0db5721618535feccff0b3fb0aba9b98c507e751b62",
                             "files": r"(?:llama|ggml|ggml-base|ggml-vulkan|ggml-cpu-[a-z0-9]+|libomp)\.dll"},
    },
}
# Measured: above 4 threads Whisper gains <15% but starves the rest of the system (laptops freeze).
THREADS = max(1, min(4, (os.cpu_count() or 4) // 2))
IDLE_UNLOAD_SECONDS = 10 * 60
# 8 GB machines get the RAM back sooner; the hotkey preloads the model again while the user speaks.
LOW_MEMORY_IDLE_UNLOAD_SECONDS = 3 * 60
# An idle model is also dropped as soon as the machine runs short of memory, checked this often,
IDLE_CHECK_SECONDS = 15
# starting this long after the last dictation, so back-to-back dictations keep the model loaded.
PRESSURE_GRACE_SECONDS = 30
_output_lock = threading.Lock()


class Canceled(Exception):
    pass


def emit(value):
    with _output_lock:
        try:
            print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)
        except OSError:
            os._exit(0)  # The app is gone and nobody reads the answers any more.


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
        self.idle_since = 0.0
        self.idle_unload_seconds = LOW_MEMORY_IDLE_UNLOAD_SECONDS if memory.is_low_memory() else IDLE_UNLOAD_SECONDS
        # Peak RAM of the last model load; it counts toward the dictation the model was loaded for.
        self.load_peak = 0
        self.formatter_dir = self.data_dir / "formatter"
        self.formatter = None

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
                "threads": THREADS, "formatter": self.formatter_status()}

    def download(self, key, request_id=None):
        folder = self.model_path(key)
        if self.is_installed(key):
            return self.status()
        from huggingface_hub import snapshot_download
        emit({"event": "progress", "id": request_id, "stage": "download", "model": key,
              "message": "Подключаемся к Hugging Face…"})
        snapshot_download(MODELS[key]["repo"], revision=MODELS[key]["revision"],
                          local_dir=str(folder), allow_patterns=MODELS[key]["files"], token=False,
                          tqdm_class=progress_class(request_id, key, "Скачиваем модель…"))
        # The marker is written only after the entire snapshot download succeeds.
        marker = folder / "shopot-ready.json"
        marker.write_text(json.dumps({"revision": MODELS[key]["revision"]}), "utf-8")
        return self.status()

    # --- Optional layout model -------------------------------------------------------------

    def formatter_runtime_spec(self):
        machine = platform.machine().lower().replace("x86_64", "amd64")
        return FORMATTER["runtimes"].get((sys.platform, machine))

    def formatter_paths(self):
        return (self.formatter_dir / f"runtime-{llm.LLAMA_BUILD}", self.formatter_dir / "model" / FORMATTER["model"]["file"],
                self.formatter_dir / "shopot-ready.json")

    def formatter_installed(self):
        spec = self.formatter_runtime_spec()
        runtime, model, marker = self.formatter_paths()
        try:
            ready = json.loads(marker.read_text("utf-8"))
            return bool(spec) and ready == {"runtime": spec["sha256"], "model": FORMATTER["model"]["sha256"]} and \
                model.stat().st_size == FORMATTER["model"]["bytes"] and all(
                    (runtime / name).is_file() for name in llm.library_names())
        except (OSError, ValueError):
            return False

    def formatter_status(self):
        return {"name": FORMATTER["name"], "size": FORMATTER["size"], "supported": bool(self.formatter_runtime_spec()),
                "installed": self.formatter_installed(), "loaded": self.formatter is not None,
                "gpu": self.formatter.on_gpu if self.formatter else None}

    def download_formatter(self, request_id=None):
        spec = self.formatter_runtime_spec()
        if not spec:
            raise ValueError("Умное оформление пока доступно только на Windows x64.")
        if self.formatter_installed():
            return self.status()
        runtime, model, marker = self.formatter_paths()
        marker.unlink(missing_ok=True)
        self.formatter_dir.mkdir(parents=True, exist_ok=True)
        archive = self.formatter_dir / "runtime.zip.part"
        emit({"event": "progress", "id": request_id, "stage": "download", "model": "formatter",
              "message": "Скачиваем движок оформления…"})
        digest = hashlib.sha256()
        with urllib.request.urlopen(spec["url"], timeout=60) as response, open(archive, "wb") as out:
            total, done, last = int(response.headers.get("Content-Length") or 0), 0, 0.0
            while chunk := response.read(1 << 20):
                out.write(chunk); digest.update(chunk); done += len(chunk)
                if time.monotonic() - last > 0.5:
                    last = time.monotonic()
                    emit({"event": "progress", "id": request_id, "stage": "download", "model": "formatter",
                          "message": "Скачиваем движок оформления…", "completed": done, "total": total, "unit": "B"})
        if digest.hexdigest() != spec["sha256"]:
            archive.unlink(missing_ok=True)
            raise ValueError("Архив движка оформления не прошёл проверку. Попробуй скачать ещё раз.")
        staging = self.formatter_dir / "runtime.part"
        if staging.exists():
            import shutil
            shutil.rmtree(staging)
        staging.mkdir()
        with zipfile.ZipFile(archive) as bundle:
            for info in bundle.infolist():
                # Only the library's own DLLs from the archive root; tools and nested paths are skipped.
                if re.fullmatch(spec["files"], info.filename):
                    (staging / info.filename).write_bytes(bundle.read(info))
        archive.unlink()
        if runtime.exists():
            import shutil
            shutil.rmtree(runtime)
        staging.rename(runtime)
        from huggingface_hub import snapshot_download
        snapshot_download(FORMATTER["model"]["repo"], revision=FORMATTER["model"]["revision"],
                          local_dir=str(model.parent), allow_patterns=[FORMATTER["model"]["file"]], token=False,
                          tqdm_class=progress_class(request_id, "formatter", "Скачиваем модель оформления…"))
        emit({"event": "progress", "id": request_id, "stage": "download", "model": "formatter",
              "message": "Проверяем модель оформления…"})
        if file_sha256(model) != FORMATTER["model"]["sha256"]:
            model.unlink(missing_ok=True)
            raise ValueError("Модель оформления не прошла проверку. Попробуй скачать ещё раз.")
        marker.write_text(json.dumps({"runtime": spec["sha256"], "model": FORMATTER["model"]["sha256"]}), "utf-8")
        # The GPU driver compiles shaders on first use (~20 s once per executable); do it now, not on a dictation.
        emit({"event": "progress", "id": request_id, "stage": "download", "model": "formatter",
              "message": "Готовим видеокарту…"})
        try:
            self.load_formatter().tags(["Первое.", "Второе."])
        except Exception:
            traceback.print_exc(file=sys.stderr)
        return self.status()

    def formatter_command(self):
        """This same program again, as the formatter worker (see llm.FormatterProcess)."""
        program = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, os.path.abspath(__file__)]
        return program + ["--data-dir", str(self.data_dir), "--formatter-worker"]

    def load_formatter(self):
        with self.model_lock:
            if self.formatter is None:
                self.formatter = llm.FormatterProcess(self.formatter_command())
            return self.formatter

    def unload_formatter(self):
        with self.model_lock:
            if self.formatter is not None:
                self.formatter.close()
                self.formatter = None

    def layout(self, text, pauses, formatting, request_id):
        """Returns (text, formatting actually used). The model only chooses tags; any failure falls back to rules."""
        sentences = split_sentences(text)
        if formatting == "llm" and len(sentences) >= 2 and self.formatter_installed():
            try:
                tags = self.load_formatter().tags(sentences, lambda: self.is_canceled(request_id))
                return layout_text(text, pauses, tags), "llm"
            except Exception:
                self.check_canceled(request_id)
                traceback.print_exc(file=sys.stderr)
        return layout_text(text, pauses), "rules"

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
        snippets = request.get("snippets") or []
        if not isinstance(snippets, list) or len(snippets) > 50 or not all(
                isinstance(s, dict) and isinstance(s.get("trigger"), str) and isinstance(s.get("text"), str)
                and len(s["trigger"]) <= 60 and len(s["text"]) <= 4000 for s in snippets):
            raise ValueError("Некорректные сниппеты")
        request = {**request, "snippets": snippets}
        mode = request.get("mode", "natural")
        if mode not in ("natural", "minimal", "raw"):
            raise ValueError("Неизвестный режим текста")
        if request.get("formatting", "rules") not in ("rules", "off", "llm"):
            raise ValueError("Неизвестный режим оформления")
        request_id = request.get("id")
        with self.model_lock:
            self.cancel_idle_unload()
            try:
                with memory.PeakSampler() as sampler:
                    result = self._transcribe(request, key, audio_path, language, entries, mode, request_id)
                # Shown in history: what this dictation cost in RAM, including a load at the hotkey (preload).
                result["memoryPeak"] = max(sampler.peak, self.load_peak) or None
                self.load_peak = 0
                return result
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
            with memory.PeakSampler() as sampler:
                if MODELS[key]["engine"] == "gigaam":
                    import onnx_asr
                    import onnxruntime
                    # Measured: turning off the CPU arena or memory patterns lowers the peak by under 3%
                    # and slows long recordings by 15%, so the defaults stay.
                    options = onnxruntime.SessionOptions()
                    options.intra_op_num_threads = THREADS
                    options.inter_op_num_threads = 1
                    self.model = onnx_asr.load_model("gigaam-v3-e2e-rnnt", self.model_path(key),
                                                     quantization="int8", sess_options=options)
                else:
                    from faster_whisper import WhisperModel
                    self.model = WhisperModel(str(self.model_path(key)), device="cpu", compute_type="int8",
                                              cpu_threads=THREADS, local_files_only=True)
            self.load_peak = max(self.load_peak, sampler.peak)
            self.loaded_key = key
            return time.monotonic() - started

    def unload(self):
        with self.model_lock:
            self.model = None
            self.loaded_key = None
            gc.collect()

    def preload(self, key, formatting=None):
        """Warm the models while the user is still speaking."""
        with self.model_lock:
            self.cancel_idle_unload()
            try:
                self.load(key)
                if formatting == "llm" and self.formatter_installed():
                    self.load_formatter()
            finally:
                self.schedule_idle_unload()

    def shutdown(self, through):
        """The app closed the pipe: stop the running work and the layout process, without waiting for locks."""
        self.canceled_through = max(self.canceled_through, through)
        self.cancel_idle_unload()
        formatter, self.formatter = self.formatter, None
        if formatter is not None:
            formatter.close()

    def cancel_idle_unload(self):
        if self.idle_timer:
            self.idle_timer.cancel()
            self.idle_timer = None

    def schedule_idle_unload(self):
        # Free RAM between dictations: after a while, or at once when the machine runs short of memory.
        # Unloading gives the memory back to the system (measured), and the hotkey preload hides the reload.
        self.cancel_idle_unload()
        self.idle_since = time.monotonic()
        self._arm_idle_check(min(PRESSURE_GRACE_SECONDS, self.idle_unload_seconds))

    def _arm_idle_check(self, delay):
        timer = threading.Timer(delay, lambda: self._idle_check(timer))
        timer.daemon = True
        self.idle_timer = timer
        timer.start()

    def _idle_check(self, timer):
        with self.model_lock:
            # A request may have run while this timer waited for the lock.
            if self.idle_timer is not timer:
                return
            if self.model is None and self.formatter is None:
                self.idle_timer = None
                return
            idle = time.monotonic() - self.idle_since
            if idle >= self.idle_unload_seconds or memory.memory_pressure() in ("warn", "critical"):
                self._idle_unload(timer)
            else:
                self._arm_idle_check(min(IDLE_CHECK_SECONDS, self.idle_unload_seconds - idle))

    def _idle_unload(self, timer):
        with self.model_lock:
            # A request may have run while this timer waited for the lock.
            if self.idle_timer is timer:
                self.idle_timer = None
                self.unload()
                self.unload_formatter()

    def is_canceled(self, request_id):
        return isinstance(request_id, int) and request_id <= self.canceled_through

    def check_canceled(self, request_id):
        if self.is_canceled(request_id):
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
        names = [e["word"] for e in entries]
        if MODELS[key]["engine"] == "gigaam":
            parsed = self._gigaam_segments(audio, duration, request_id)
            raw = join_segments([s["text"] for s in parsed], names)
            words, detected = [], "ru"
        else:
            parsed, words, detected = self._whisper_segments(audio, duration, language, entries, request, request_id)
            raw = " ".join(s["text"] for s in parsed).strip()
        text, replacements = format_transcript(raw, entries, mode)
        fillers = mode != "raw" and bool(request.get("removeFillers", True))
        text = self.clean(text, mode, request.get("removeFillers", True))
        formatting, format_started = request.get("formatting", "rules"), time.monotonic()
        if mode == "natural" and formatting != "off":
            gaps = [i > 0 and parsed[i]["start"] - parsed[i - 1]["end"] >= PARAGRAPH_PAUSE_SECONDS for i in range(len(parsed))]
            chunks = [strip_hesitations(s["text"]) if fillers else s["text"] for s in parsed]
            text, formatting = self.layout(text, pause_sentences(chunks, gaps, names), formatting, request_id)
        else:
            formatting = "off"
        # Spoken «новый абзац» / «с новой строки» break the text wherever the layout put them.
        commands = []
        if mode != "raw" and request.get("voiceCommands", True):
            text, commands = apply_voice_commands(text)
        # Last, so the saved text goes in exactly as written: no dictionary, cleanup or layout touches it.
        text, expanded = expand_snippets(text, request["snippets"], entries) if mode != "raw" else (text, [])
        return {"formatting": formatting, "formatElapsed": finite(time.monotonic() - format_started),"text": text, "rawText": raw, "words": words, "segments": parsed,
                "replacements": replacements, "snippets": expanded, "commands": commands, "duration": finite(duration),
                "elapsed": finite(time.monotonic() - started), "language": detected,
                "model": key, "noSpeech": not bool(raw), "device": "cpu",
                "loadElapsed": finite(load_elapsed)}

    def clean(self, text, mode, remove_fillers):
        """«Ааа», «э-э» are dictated sounds, not words. «Исходный результат» keeps everything."""
        return strip_hesitations(text) if mode != "raw" and remove_fillers else text

    def _progress(self, request_id, fraction):
        emit({"event": "progress", "id": request_id, "stage": "transcribe",
              "message": "Распознаём речь на компьютере…", "fraction": min(1, fraction)})

    def _gigaam_segments(self, audio, duration, request_id):
        from faster_whisper.vad import VadOptions, get_speech_timestamps
        speech = get_speech_timestamps(audio, VadOptions(**VAD_OPTIONS, max_speech_duration_s=GIGAAM_MAX_CHUNK_SECONDS))
        parsed = []
        for start, end in speech_windows(speech, GIGAAM_MAX_CHUNK_SECONDS * 16000, int(PARAGRAPH_PAUSE_SECONDS * 16000)):
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


def progress_class(request_id, model, message):
    """tqdm subclass that reports download progress over the JSON protocol."""
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
                emit({"event": "progress", "id": request_id, "stage": "download", "model": model,
                      "message": message, "completed": self.n, "total": self.total, "unit": self.unit})
            return result
    return Progress


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(8 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def speech_windows(speech, max_samples, split_gap=None):
    """Group VAD speech regions into contiguous windows no longer than max_samples.

    A gap of split_gap samples or more always starts a new window, so long pauses stay visible.
    """
    windows = []
    for region in speech:
        if (windows and region["end"] - windows[-1][0] <= max_samples
                and (split_gap is None or region["start"] - windows[-1][1] < split_gap)):
            windows[-1][1] = region["end"]
        else:
            windows.append([region["start"], region["end"]])
    return [tuple(w) for w in windows]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--download", choices=list(MODELS))
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--formatter-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    engine = Engine(args.data_dir)
    if args.formatter_worker:
        # Only llama.cpp lives here: importing the ASR runtimes would bring back the OpenMP clash.
        runtime, model, _ = engine.formatter_paths()
        llm.serve(runtime, model, THREADS)
        return
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
        # The app is gone: cancel the work in flight instead of heating the CPU for nobody.
        engine.shutdown(last_id)
        requests.put(None)
        leave = threading.Timer(5, lambda: os._exit(0))  # in case the request cannot stop at once
        leave.daemon = True
        leave.start()

    threading.Thread(target=read_commands, daemon=True).start()
    while (request := requests.get()) is not None:
        try:
            command = request.get("command")
            if command == "preload":
                if request.get("model") in MODELS:
                    engine.preload(request["model"], request.get("formatting"))
                continue
            if command == "status":
                result = engine.status()
            elif command == "download":
                result = engine.download(request["model"], request.get("id"))
            elif command == "download-formatter":
                result = engine.download_formatter(request.get("id"))
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
