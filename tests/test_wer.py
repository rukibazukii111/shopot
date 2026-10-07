import pytest

from wer_helpers import fake_models, write_tone
import wer
from wer_text import normalize


def fake_recognition(monkeypatch, spoken, heard=None):
    """Only recognition is faked: decoding, the dictionary, cleanup and voice commands run for real."""
    from engine import Engine

    def segments(self, audio, duration, request_id):
        if heard is not None:
            heard.append(duration)
        return [{"start": 0.0, "end": 1.0, "text": spoken, "noSpeechProbability": 0.0}]
    monkeypatch.setattr(Engine, "load", lambda self, key, request_id=None: 0.0)
    monkeypatch.setattr(Engine, "_gigaam_segments", segments)


def test_measured_text_is_what_shopot_gives_without_layout(tmp_path, monkeypatch):
    fake_recognition(monkeypatch, "Во-первых, гитхаб. Во-вторых, э-э тест.")
    engine, data = wer.make_engine(fake_models(tmp_path / "models"))
    try:
        text = wer.transcribe(engine, write_tone(tmp_path / "a.wav"), "gigaam",
                              [{"word": "GitHub", "aliases": ["гитхаб"]}])
        assert not list(engine.audio_dir.iterdir())  # the copy for the engine is gone
    finally:
        engine.cancel_idle_unload()
    # The dictionary and the «э-э» cleanup worked; without layout no list numbers were added.
    assert normalize(text) == ["во", "первых", "github", "во", "вторых", "тест"]


def set_with_one_verified(root):
    write_tone(root / "windows" / "короткие" / "01.wav")
    (root / "windows" / "короткие" / "01.txt").write_text("Привет, мир!", "utf-8")
    write_tone(root / "mac" / "шум" / "02.wav")
    (root / "mac" / "шум" / "02.черновик.txt").write_text("черновик", "utf-8")
    return root


def test_measurement_writes_a_report_and_keeps_transcripts(tmp_path, monkeypatch):
    heard = []
    fake_recognition(monkeypatch, "Привет мир", heard)
    monkeypatch.setattr(wer, "keep_awake", lambda: None)
    work = set_with_one_verified(tmp_path / "set")
    (work / "dictionary.json").write_text("[]", "utf-8")
    args = ["--set", str(work), "--out", str(tmp_path / "out"), "--models", "gigaam,small", "--audio", "file",
            "--models-dir", str(fake_models(tmp_path / "models"))]
    report = wer.main(args).read_text("utf-8")
    assert "Проверено 1 из 2 записей — итог неполный" in report
    assert "| GigaAM v3 | 0,0% |" in report
    assert "| Whisper small | не скачана |" in report
    assert "- mac/шум/02.wav — только черновик" in report
    wer.main(args)
    assert len(heard) == 1  # same audio, model, settings, dictionary and engine code: the kept transcript is used
    (work / "dictionary.json").write_text('[{"word": "Мир", "aliases": []}]', "utf-8")
    wer.main(args)
    assert len(heard) == 2  # another dictionary: recognized again


def test_measurement_needs_the_set_dictionary(tmp_path):
    work = set_with_one_verified(tmp_path / "set")
    with pytest.raises(SystemExit, match="--import-dictionary"):
        wer.main(["--set", str(work), "--out", str(tmp_path / "out"), "--audio", "file"])


def test_import_dictionary_command_copies_into_the_set(tmp_path):
    store = tmp_path / "store.json"
    store.write_text('{"dictionary": [{"word": "GitHub", "aliases": ["гитхаб"]}], "history": []}', "utf-8")
    target = wer.main(["--set", str(tmp_path / "set"), "--import-dictionary", str(store)])
    assert target == tmp_path / "set" / "dictionary.json" and target.is_file()
    with pytest.raises(SystemExit, match="--replace"):
        wer.main(["--set", str(tmp_path / "set"), "--import-dictionary", str(store)])


def test_kept_transcripts_follow_the_recognition_libraries(tmp_path, monkeypatch):
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "engine.py").write_text("engine", "utf-8")
    (tmp_path / "backend" / "requirements.txt").write_text("faster-whisper==1.2.1\n", "utf-8")
    monkeypatch.setattr(wer, "ROOT", tmp_path)
    before = wer.code_version()
    (tmp_path / "backend" / "requirements.txt").write_text("faster-whisper==1.3.0\n", "utf-8")
    assert wer.code_version() != before
