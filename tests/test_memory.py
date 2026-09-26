from pathlib import Path
import json
import sys
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import memory
import engine as engine_module
from engine import Engine, GIGAAM_FILES, MODELS

MB = 1024 * 1024
GB = 1024 * MB
desktop = pytest.mark.skipif(sys.platform not in ('win32', 'darwin'), reason='implemented for Windows and macOS')


@desktop
def test_memory_readings_are_plausible_on_this_machine():
    total = memory.total_memory()
    assert total > GB
    assert 5 * MB < memory.process_memory() < total
    assert memory.memory_pressure() in ('normal', 'warn', 'critical')


@desktop
def test_peak_sampler_notices_a_short_allocation():
    before = memory.process_memory()
    with memory.PeakSampler(interval=0.01) as sampler:
        block = b'x' * (200 * MB)
        time.sleep(0.2)
        del block
    assert sampler.peak - before > 150 * MB


def test_small_machines_give_memory_back_sooner(tmp_path, monkeypatch):
    monkeypatch.setattr(memory, 'total_memory', lambda: 8 * GB)
    assert Engine(tmp_path).idle_unload_seconds == engine_module.LOW_MEMORY_IDLE_UNLOAD_SECONDS
    monkeypatch.setattr(memory, 'total_memory', lambda: 32 * GB)
    assert Engine(tmp_path).idle_unload_seconds == engine_module.IDLE_UNLOAD_SECONDS


def test_idle_model_is_dropped_when_the_machine_runs_short_of_memory(tmp_path, monkeypatch):
    engine = Engine(tmp_path)
    engine.model, engine.loaded_key = object(), 'gigaam'
    pressure = ['normal']
    monkeypatch.setattr(memory, 'memory_pressure', lambda: pressure[0])
    engine.schedule_idle_unload()
    try:
        first = engine.idle_timer
        engine._idle_check(first)
        # Enough memory: the model stays and the next check is armed.
        assert engine.loaded_key == 'gigaam' and engine.idle_timer not in (None, first)
        pressure[0] = 'warn'
        engine._idle_check(engine.idle_timer)
        assert engine.model is None and engine.loaded_key is None and engine.idle_timer is None
    finally:
        engine.cancel_idle_unload()


def test_idle_model_is_dropped_after_the_idle_time(tmp_path, monkeypatch):
    engine = Engine(tmp_path)
    engine.model, engine.loaded_key = object(), 'gigaam'
    monkeypatch.setattr(memory, 'memory_pressure', lambda: 'normal')
    engine.schedule_idle_unload()
    try:
        engine.idle_since -= engine.idle_unload_seconds
        engine._idle_check(engine.idle_timer)
        assert engine.model is None
    finally:
        engine.cancel_idle_unload()


def test_dictation_reports_its_memory_peak_including_the_model_load(tmp_path, monkeypatch):
    engine = Engine(tmp_path)
    folder = engine.model_path('gigaam')
    folder.mkdir(parents=True)
    (folder / 'shopot-ready.json').write_text(json.dumps({'revision': MODELS['gigaam']['revision']}), 'utf-8')
    for name in GIGAAM_FILES:
        (folder / name).write_bytes(b'x')
    (engine.audio_dir / 'abc.wav').write_bytes(b'x')
    monkeypatch.setattr(engine, '_transcribe', lambda *args: {'text': 'Готово.'})
    request = {'model': 'gigaam', 'audioFile': 'abc.wav', 'language': 'ru'}
    try:
        # The model was loaded at the hotkey (preload): its peak belongs to this dictation, then resets.
        engine.load_peak = 64 * GB
        assert engine.transcribe(request)['memoryPeak'] == 64 * GB and engine.load_peak == 0
        peak = engine.transcribe(request)['memoryPeak']
        assert peak is None or peak < 64 * GB
    finally:
        engine.cancel_idle_unload()
