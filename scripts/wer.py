"""WER of Shopot on the owner's reference set (PRD, section 7).

    python scripts/wer.py --import-dictionary     copy the dictionary out of the installed Shopot, once
    python scripts/wer.py --models gigaam,turbo   measure; the report goes to .private/wer/reports

The set is the main checkout's .private/wer-set (layout in scripts/wer_set.py), so every worktree measures the
same recordings. Processed audio and transcripts are kept in .private/wer: a stopped run goes on where it stopped.
Recognition runs offline, with the engine of this checkout.
"""
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import wer_audio
import wer_report
import wer_set
from engine import MODELS
from wer_text import normalize, word_errors

# Owner's decision (07.10.2026): measure the text Shopot gives the user — dictionary, «э-э» cleanup and voice
# commands — without layout, whose list numbers would add words.
REQUEST = {"language": "ru", "mode": "natural", "formatting": "off", "removeFillers": True, "voiceCommands": True,
           "context": "", "snippets": [], "translate": False}


def main_checkout():
    """Worktrees measure the owner's set and use the models of the main checkout."""
    try:
        found = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=ROOT,
                               capture_output=True, text=True, check=True)
        return Path(found.stdout.strip()).parent
    except (OSError, subprocess.CalledProcessError):
        return ROOT


def commit():
    try:
        head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True,
                              check=True).stdout.strip()
        changed = subprocess.run(["git", "status", "--porcelain", "--", "backend", "scripts"], cwd=ROOT,
                                 capture_output=True, text=True, check=True).stdout.strip()
        return head + (" с незакоммиченными правками" if changed else "")
    except (OSError, subprocess.CalledProcessError):
        return "неизвестен"


def keep_awake():
    """Capture runs in real time and recognition can take hours: the computer must not fall asleep meanwhile."""
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    elif sys.platform == "darwin":
        subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])


def block_network():
    os.environ["HF_HUB_OFFLINE"] = "1"

    def refuse(*args, **kwargs):
        raise RuntimeError("Сеть при замере отключена")
    socket.socket.connect = refuse


def code_version():
    """Kept transcripts belong to the engine code and the library versions that made them."""
    digest = hashlib.sha256()
    for path in sorted((ROOT / "backend").glob("*.py")) + [ROOT / "backend" / "requirements.txt"]:
        digest.update(path.read_bytes() if path.is_file() else b"")
    return digest.hexdigest()[:12]


def make_engine(models_dir):
    """The engine with its own temporary audio folder and the given models; its progress events stay quiet."""
    import engine as engine_module
    engine_module.emit = lambda value: None
    data = Path(tempfile.mkdtemp(prefix="shopot-wer-engine-"))
    engine = engine_module.Engine(data)
    engine.models_dir = Path(models_dir)
    return engine, data


def transcribe(engine, audio, model, dictionary):
    """The text Shopot would give for this audio (REQUEST), from the engine itself."""
    name = f"{uuid.uuid4()}{Path(audio).suffix.lower()}"
    copy = engine.audio_dir / name
    shutil.copyfile(audio, copy)
    try:
        return engine.transcribe({**REQUEST, "model": model, "audioFile": name, "dictionary": dictionary})["text"]
    finally:
        copy.unlink(missing_ok=True)


def recognized(engine, folder, audio, model, dictionary, code):
    """transcribe(), kept per audio, model, settings, dictionary and engine code."""
    key = hashlib.sha256(json.dumps([wer_set.file_sha256(audio), model, MODELS[model]["revision"], REQUEST,
                                     dictionary, code], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    kept = Path(folder) / f"{key}.json"
    try:
        return json.loads(kept.read_text("utf-8"))["text"]
    except (OSError, ValueError, KeyError):
        pass
    text = transcribe(engine, audio, model, dictionary)
    kept.parent.mkdir(parents=True, exist_ok=True)
    temp = kept.with_name(kept.name + ".tmp")
    temp.write_text(json.dumps({"text": text}, ensure_ascii=False), "utf-8")
    os.replace(temp, kept)
    return text


def duration(path):
    from faster_whisper.audio import decode_audio
    return len(decode_audio(str(path), sampling_rate=16000)) / 16000


def choose(value, known, error):
    chosen = list(known) if value == "all" else [item.strip() for item in value.split(",") if item.strip()]
    unknown = [item for item in chosen if item not in known]
    if unknown or not chosen:
        sys.exit(f"{error}: {', '.join(unknown) or value}. Есть: {', '.join(known)} или all.")
    return [item for item in known if item in chosen]


def measure(args):
    if not args.set.is_dir():
        sys.exit(f"Нет папки набора: {args.set}. Положи записи в {args.set}/<устройство>/<вид>/.")
    recordings, orphans = wer_set.scan(args.set)
    try:
        dictionary = wer_set.load_dictionary(args.dictionary or args.set / wer_set.DICTIONARY_FILE)
    except (OSError, ValueError) as error:
        sys.exit(str(error))
    measured = [r for r in recordings if r.state == "verified"]
    if not measured:
        sys.exit(f"Нет проверенных расшифровок «имя.txt»: мерить нечего. Записей в наборе: {len(recordings)}.")
    models = choose(args.models, list(MODELS), "Неизвестная модель")
    variants = choose(args.audio, wer_audio.VARIANTS, "Неизвестный вариант обработки")
    keep_awake()
    hashes = {r.name: wer_set.file_sha256(r.path) for r in measured}
    durations = {}
    for r in measured:
        try:
            durations[r.name] = duration(r.path)
        except Exception:  # an unreadable recording fails in every variant below, with the decoder's reason
            pass
    audio = {(r.name, "file"): r.path for r in measured}
    failures, electron_version = {}, None
    processed = [variant for variant in variants if variant != "file"]
    if processed:
        try:
            binary = wer_audio.electron()
        except (OSError, ValueError, subprocess.CalledProcessError):
            sys.exit("Не нашёл Electron для обработки звука. Выполни npm ci в папке проекта.")
        electron_version = binary[1]
        done, failed = wer_audio.process({hashes[r.name]: r.path for r in measured}, args.out / "audio", processed,
                                         args.jobs, binary=binary)
        for r in measured:
            for variant in processed:
                item = (hashes[r.name], variant)
                if item in done:
                    audio[(r.name, variant)] = done[item]
                else:
                    failures[(r.name, variant)] = failed.get(item, "нет результата")
    last = wer_report.previous(args.out / "reports")
    engine, data = make_engine(args.models_dir)
    code, results = code_version(), []
    try:
        for model in models:
            info = {"id": model, "name": MODELS[model]["name"], "installed": engine.is_installed(model), "cells": {}}
            results.append(info)
            if not info["installed"]:
                print(f"{info['name']}: не скачана, пропускаю.", flush=True)
                continue
            for variant in variants:
                for r in measured:
                    if (r.name, variant) in failures:
                        info["cells"][(r.name, variant)] = {"error": f"обработка звука: {failures[(r.name, variant)]}"}
                        continue
                    try:
                        text = recognized(engine, args.out / "transcripts", audio[(r.name, variant)], model,
                                          dictionary, code)
                    except Exception as error:  # one failed recording must not stop the run; the report lists it
                        info["cells"][(r.name, variant)] = {"error": str(error) or type(error).__name__}
                        continue
                    info["cells"][(r.name, variant)] = {"counts": word_errors(normalize(r.reference), normalize(text)),
                                                        "text": text}
                print(f"{info['name']}, {wer_report.LABELS[variant]}: готово", flush=True)
    finally:
        engine.cancel_idle_unload()
        shutil.rmtree(data, ignore_errors=True)
    report = wer_report.save({"created": datetime.now(), "commit": commit(), "electron": electron_version,
                              "fingerprint": wer_set.fingerprint(measured, hashes, dictionary), "previous": last,
                              "settings": REQUEST, "dictionaryWords": len(dictionary), "variants": variants,
                              "recordings": recordings, "orphans": orphans, "durations": durations,
                              "models": results}, args.out / "reports")
    print(f"Отчёт: {report}", flush=True)
    return report


def main(argv=None):
    home = main_checkout()
    parser = argparse.ArgumentParser(description="Замер WER Шёпота на эталонном наборе (PRD, раздел 7).")
    parser.add_argument("--set", type=Path, default=home / ".private" / "wer-set",
                        help="папка набора: <устройство>/<вид>/имя.m4a и рядом имя.txt")
    parser.add_argument("--out", type=Path, default=home / ".private" / "wer",
                        help="обработанный звук, расшифровки и отчёты")
    parser.add_argument("--models", default="gigaam", help="модели через запятую или all: " + ", ".join(MODELS))
    parser.add_argument("--audio", default="all",
                        help="варианты обработки через запятую или all: " + ", ".join(wer_audio.VARIANTS))
    parser.add_argument("--jobs", type=int, default=8, help="сколько процессов обработки звука идут одновременно")
    parser.add_argument("--models-dir", type=Path,
                        default=Path(os.environ.get("SHOPOT_MODELS_DIR") or home / ".local" / "models"))
    parser.add_argument("--dictionary", type=Path, help="словарь набора; по умолчанию <набор>/dictionary.json")
    parser.add_argument("--import-dictionary", nargs="?", const=wer_set.default_store(), type=Path, metavar="STORE",
                        help="скопировать словарь из store.json Шёпота в набор и выйти")
    parser.add_argument("--replace", action="store_true", help="заменить уже скопированный словарь набора")
    args = parser.parse_args(argv)
    if args.import_dictionary:
        target = args.dictionary or args.set / wer_set.DICTIONARY_FILE
        try:
            count = wer_set.import_dictionary(args.import_dictionary, target, args.replace)
        except (OSError, ValueError) as error:
            sys.exit(str(error))
        print(f"Словарь набора: {count} слов, {target}")
        return target
    return measure(args)


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    block_network()
    main()
