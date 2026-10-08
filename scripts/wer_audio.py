"""Chromium's microphone processing for the set's recordings (PRD 6.19), the way Shopot records the microphone.

A recording stands in for the microphone through Chromium's fake capture (scripts/wer-audio.cjs), in real time,
in a window that is never shown. Every variant runs in its own Electron process: one page cannot hold tracks
with different processing on one device — Chromium hands back an existing source and ignores the request
(checked 07.10.2026, Electron 44.3.0). Results are kept while the recording, the capture code and Electron
stay the same; a failure is reported and tried again next time, never kept.
"""
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import wave
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib import metadata
from pathlib import Path

import numpy as np

from wer_text import plural

ROOT = Path(__file__).resolve().parents[1]
CAPTURE = (ROOT / "scripts" / "wer-audio.cjs", ROOT / "scripts" / "wer-audio.html")
PROCESSED = ["none", "agc", "ns", "ec", "agc+ns", "agc+ec", "ns+ec", "agc+ns+ec"]
VARIANTS = ["file"] + PROCESSED
RATE = 48000
# The fake device plays the file from the moment it opens, a moment before the recorder starts:
# a second of silence keeps the first word whole, and a later start is refused.
LEAD_SECONDS = 1.0
MAX_START_DELAY = LEAD_SECONDS - 0.2
TAIL_SECONDS = 1.0
MARK = "SHOPOT_WER "
# The engine treats audio quieter than this as no speech (backend/engine.py, Engine._transcribe).
SILENCE = 0.0001


def versions(*packages):
    """Installed versions of the packages: worktrees share one .venv, so requirements.txt may not match it."""
    found = {}
    for package in packages:
        try:
            found[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            found[package] = None
    return found


def wanted(variant):
    parts = set(variant.split("+"))
    return {"autoGainControl": "agc" in parts, "noiseSuppression": "ns" in parts, "echoCancellation": "ec" in parts}


def electron():
    """The Electron binary and its version: processing changes with Chromium, so the version keys the results."""
    script = "process.stdout.write(JSON.stringify([require('electron'), require('electron/package.json').version]))"
    found = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True)
    path, version = json.loads(found.stdout)
    return path, version


def capture_code():
    digest = hashlib.sha256()
    # This module prepares the input (lead of silence, resampling), so its code keys the results too.
    for path in (*CAPTURE, Path(__file__)):
        digest.update(path.read_bytes())
    # prepare() decodes with faster-whisper's decode_audio, which resamples with PyAV and numpy.
    digest.update(json.dumps(versions("faster-whisper", "av", "numpy"), sort_keys=True).encode())
    return digest.hexdigest()[:12]


def prepare(source, target):
    """48 kHz mono 16-bit WAV with a short lead of silence: the only input Chromium's fake capture reads."""
    from faster_whisper.audio import decode_audio
    audio = np.concatenate([np.zeros(int(RATE * LEAD_SECONDS), dtype=np.float32),
                            decode_audio(str(source), sampling_rate=RATE)])
    with wave.open(str(target), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return len(audio) / RATE


def remove_profile(folder, attempts=10):
    """Chromium's helper processes may hold the profile for a moment after Electron exits: retry, then leave it."""
    for _ in range(attempts):
        shutil.rmtree(folder, ignore_errors=True)
        if not os.path.exists(folder):
            return
        time.sleep(0.2)


def run_capture(binary, wav, output, variant, seconds):
    """One hidden Electron process records one variant for `seconds`; returns its report."""
    env = {key: value for key, value in os.environ.items() if key != "ELECTRON_RUN_AS_NODE"}
    profile = tempfile.mkdtemp(prefix="shopot-wer-profile-")
    try:
        run = subprocess.run([binary, str(CAPTURE[0]), f"--wer-input={wav}", f"--wer-output={output}",
                              f"--wer-variant={variant}", f"--wer-seconds={seconds:.3f}",
                              f"--wer-profile={profile}"], env=env, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=seconds + 120)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Electron не закончил запись вовремя") from None
    finally:
        remove_profile(profile)
    answers = [line[len(MARK):] for line in run.stdout.splitlines() if line.startswith(MARK)]
    if not answers:
        raise RuntimeError(f"Electron завершился без ответа, код {run.returncode}: {run.stderr.strip()[-300:]}")
    report = json.loads(answers[-1])
    if not report.get("ok"):
        raise RuntimeError(report.get("error") or "Chromium не записал звук")
    return report


def check(output, seconds, report, want):
    """The recording is whole and Chromium applied exactly the processing asked for."""
    if report.get("settings") != want:
        raise RuntimeError(f"Chromium применил не те настройки обработки: {report.get('settings')}")
    delay = report.get("startDelay")
    if not isinstance(delay, (int, float)) or delay > MAX_START_DELAY:
        raise RuntimeError(f"Запись началась слишком поздно: через {delay} с, первое слово могло пропасть")
    from faster_whisper.audio import decode_audio
    audio = decode_audio(str(output), sampling_rate=16000)
    captured = len(audio) / 16000
    if captured < seconds - 0.1:
        raise RuntimeError(f"Записалось {captured:.1f} с из {seconds:.1f} с")
    # The fake device records silence when it cannot read the input; it must not count as a recognized 100%.
    if not len(audio) or float(np.max(np.abs(audio))) < SILENCE:
        raise RuntimeError("Chromium записал тишину: звук записи до него не дошёл")


def cached(folder, variant, key):
    try:
        if (json.loads((folder / f"{variant}.json").read_text("utf-8")).get("key") == key
                and (folder / f"{variant}.webm").is_file()):
            return folder / f"{variant}.webm"
    except (OSError, ValueError):
        pass
    return None


def process(sources, cache, variants, jobs, log=print, capture=run_capture, binary=None):
    """Processed audio for each source and variant: ({(sha, variant): path}, {(sha, variant): reason}).

    sources maps a recording's sha256 to its file, so equal recordings are processed once.
    """
    binary, version = binary or electron()
    key = f"{version}/{capture_code()}"
    cache = Path(cache)
    done, failed, todo = {}, {}, []
    for sha in sources:
        for variant in variants:
            hit = cached(cache / sha, variant, key)
            if hit:
                done[(sha, variant)] = hit
            else:
                todo.append((sha, variant))
    if not todo:
        return done, failed
    items = plural(len(todo), "запись-вариант", "записи-варианта", "записей-вариантов")
    log(f"Обработка звука: {len(todo)} {items} в реальном времени, по {jobs} одновременно.")
    with tempfile.TemporaryDirectory(prefix="shopot-wer-wav-", ignore_cleanup_errors=True) as temp:
        prepared = {}
        for sha in dict.fromkeys(sha for sha, _ in todo):
            try:
                prepared[sha] = prepare(sources[sha], Path(temp) / f"{sha}.wav")
            except Exception as error:  # an unreadable recording fails alone, with the decoder's reason
                failed.update({item: f"Не удалось прочитать запись: {error}" for item in todo if item[0] == sha})

        def one(sha, variant):
            folder = cache / sha
            folder.mkdir(parents=True, exist_ok=True)
            part = folder / f"{variant}.part.webm"
            try:
                report = capture(binary, Path(temp) / f"{sha}.wav", part, variant, prepared[sha] + TAIL_SECONDS)
                check(part, prepared[sha], report, wanted(variant))
            except Exception:
                part.unlink(missing_ok=True)
                raise
            os.replace(part, folder / f"{variant}.webm")
            (folder / f"{variant}.json").write_text(json.dumps({"key": key, "settings": report["settings"]}), "utf-8")
            return folder / f"{variant}.webm"

        runs = [item for item in todo if item[0] in prepared]
        pool = ThreadPoolExecutor(max_workers=max(1, jobs))
        try:
            futures = {pool.submit(one, *item): item for item in runs}
            for count, future in enumerate(as_completed(futures), 1):
                try:
                    done[futures[future]] = future.result()
                except Exception as error:  # one failed capture must not stop the others; the report lists it
                    failed[futures[future]] = str(error)
                log(f"Обработка звука: {count} из {len(runs)}")
        except BaseException:
            # Ctrl+C: queued captures are dropped instead of running on in real time; kept ones stay for next time.
            pool.shutdown(wait=True, cancel_futures=True)
            raise
        pool.shutdown()
    return done, failed
