import wave
from pathlib import Path

import pytest

from wer_helpers import write_tone
import wer_audio


def fake_capture(calls, fail=(), settings=None, short=False, delay=0.05, interrupt=False, silent=False):
    """Stands in for Electron: copies the prepared WAV (the decoder reads it like the WebM) and reports settings."""
    def capture(binary, wav, output, variant, seconds):
        calls.append(variant)
        if interrupt:
            raise KeyboardInterrupt
        if variant in fail and calls.count(variant) == 1:
            raise RuntimeError("Electron упал")
        with wave.open(str(wav)) as source, wave.open(str(output), "wb") as out:
            out.setparams(source.getparams())
            frames = source.readframes(source.getnframes())
            out.writeframes(bytes(len(frames)) if silent else frames[:len(frames) // 2] if short else frames)
        return {"ok": True, "settings": settings or wer_audio.wanted(variant), "startDelay": delay}
    return capture


QUIET = {"jobs": 2, "log": lambda message: None}


def test_processing_keeps_good_results_and_tries_failures_again(tmp_path):
    source = write_tone(tmp_path / "a.wav")
    calls = []

    def run(version="44.3.0"):
        return wer_audio.process({"abc": source}, tmp_path / "cache", ["none", "ns"],
                                 capture=fake_capture(calls, fail={"ns"}), binary=("electron", version), **QUIET)
    done, failed = run()
    assert set(done) == {("abc", "none")} and failed == {("abc", "ns"): "Electron упал"}
    done, failed = run()
    assert set(done) == {("abc", "none"), ("abc", "ns")} and failed == {}
    assert calls.count("none") == 1  # the kept result is used again
    assert not list((tmp_path / "cache" / "abc").glob("*.part.webm"))
    run(version="45.0.0")  # another Chromium processes differently: record again
    assert calls.count("none") == 2


def test_processing_refuses_other_settings_and_cut_audio(tmp_path):
    source = write_tone(tmp_path / "a.wav")
    off = {"autoGainControl": False, "noiseSuppression": False, "echoCancellation": False}
    _, failed = wer_audio.process({"abc": source}, tmp_path / "one", ["ns"], capture=fake_capture([], settings=off),
                                  binary=("electron", "44.3.0"), **QUIET)
    assert "не те настройки" in failed[("abc", "ns")]
    _, failed = wer_audio.process({"abc": source}, tmp_path / "two", ["ns"], capture=fake_capture([], short=True),
                                  binary=("electron", "44.3.0"), **QUIET)
    assert "Записалось" in failed[("abc", "ns")]
    assert not list((tmp_path / "one").rglob("*.webm")) and not list((tmp_path / "two").rglob("*.webm"))


def test_prepared_input_is_48_khz_mono_with_a_lead_of_silence(tmp_path):
    seconds = wer_audio.prepare(write_tone(tmp_path / "a.wav", seconds=1.0), tmp_path / "in.wav")
    with wave.open(str(tmp_path / "in.wav")) as prepared:
        assert (prepared.getframerate(), prepared.getnchannels(), prepared.getsampwidth()) == (48000, 1, 2)
        lead = prepared.readframes(int(48000 * wer_audio.LEAD_SECONDS))
    assert seconds == pytest.approx(1.0 + wer_audio.LEAD_SECONDS, abs=0.01)
    assert set(lead) == {0}


def test_processing_refuses_a_recorder_that_started_late(tmp_path):
    # The fake device plays the file from the moment it opens: a late recorder loses the first word.
    source = write_tone(tmp_path / "a.wav")
    _, failed = wer_audio.process({"abc": source}, tmp_path / "late", ["ns"],
                                  capture=fake_capture([], delay=wer_audio.LEAD_SECONDS), binary=("electron", "44.3.0"),
                                  **QUIET)
    assert "поздно" in failed[("abc", "ns")]
    assert not list((tmp_path / "late").rglob("*.webm"))


def test_interrupting_stops_the_queued_captures(tmp_path):
    source = write_tone(tmp_path / "a.wav")
    calls = []
    with pytest.raises(KeyboardInterrupt):
        wer_audio.process({"abc": source}, tmp_path / "cache", wer_audio.PROCESSED,
                          capture=fake_capture(calls, interrupt=True), binary=("electron", "44.3.0"),
                          jobs=1, log=lambda message: None)
    # Ctrl+C does not wait for the queued real-time captures; the worker may have taken the next one already.
    assert len(calls) <= 2


def test_kept_audio_follows_the_preparation_code(tmp_path, monkeypatch):
    before = wer_audio.capture_code()
    changed = tmp_path / "wer_audio.py"
    changed.write_bytes(Path(wer_audio.__file__).read_bytes() + b"\n# another lead of silence\n")
    monkeypatch.setattr(wer_audio, "__file__", str(changed))
    assert wer_audio.capture_code() != before


def test_processing_refuses_a_silent_capture(tmp_path):
    # Chromium records silence when its fake device cannot read the input; that is a failure, not a 100% WER.
    source = write_tone(tmp_path / "a.wav")
    _, failed = wer_audio.process({"abc": source}, tmp_path / "silent", ["ns"], capture=fake_capture([], silent=True),
                                  binary=("electron", "44.3.0"), **QUIET)
    assert "тишину" in failed[("abc", "ns")]
    assert not list((tmp_path / "silent").rglob("*.webm"))


@pytest.mark.parametrize("package", ["faster-whisper", "av", "numpy"])
def test_kept_audio_follows_the_installed_decoding_libraries(monkeypatch, package):
    # prepare() decodes with faster-whisper's decode_audio, which resamples with PyAV and numpy.
    from importlib import metadata
    before = wer_audio.capture_code()
    real = metadata.version
    monkeypatch.setattr(metadata, "version", lambda name: "99.0.0" if name == package else real(name))
    assert wer_audio.capture_code() != before
