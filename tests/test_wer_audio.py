import wave

import pytest

from wer_helpers import write_tone
import wer_audio


def fake_capture(calls, fail=(), settings=None, short=False):
    """Stands in for Electron: copies the prepared WAV (the decoder reads it like the WebM) and reports settings."""
    def capture(binary, wav, output, variant, seconds):
        calls.append(variant)
        if variant in fail and calls.count(variant) == 1:
            raise RuntimeError("Electron упал")
        with wave.open(str(wav)) as source, wave.open(str(output), "wb") as out:
            out.setparams(source.getparams())
            frames = source.readframes(source.getnframes())
            out.writeframes(frames[:len(frames) // 2] if short else frames)
        return {"ok": True, "settings": settings or wer_audio.wanted(variant)}
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
