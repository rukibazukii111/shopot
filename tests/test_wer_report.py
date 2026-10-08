import json
from datetime import datetime
from pathlib import Path

from wer_helpers import ROOT  # noqa: F401
from wer_report import markdown, previous, save
from wer_set import Recording


def rec(name, state="verified", reference="раз два три четыре пять"):
    device, kind = name.split("/")[:2]
    return Recording(Path(name), name, device, kind, state, reference if state == "verified" else "")


def counts(words, errors):
    return {"words": words, "errors": errors, "substitutions": errors, "deletions": 0, "insertions": 0}


def measurement(**changes):
    m = {"created": datetime(2026, 10, 7, 16, 30), "commit": "abc1234", "electron": "44.3.0", "fingerprint": "f1",
         "previous": None, "settings": {}, "dictionaryWords": 2, "variants": ["file", "agc+ns+ec"],
         "recordings": [rec("windows/короткие/01.m4a"), rec("mac/длинные/02.m4a", reference=" ".join(["слово"] * 95)),
                        rec("mac/шум/03.m4a", state="draft")],
         "orphans": [], "durations": {"windows/короткие/01.m4a": 3.0, "mac/длинные/02.m4a": 57.0},
         "models": [{"id": "gigaam", "name": "GigaAM v3", "installed": True, "cells": {
                         ("windows/короткие/01.m4a", "file"): {"counts": counts(5, 1), "text": "раз два три четыре шесть"},
                         ("mac/длинные/02.m4a", "file"): {"counts": counts(95, 0), "text": "…"},
                         ("windows/короткие/01.m4a", "agc+ns+ec"): {"counts": counts(5, 0), "text": "…"},
                         ("mac/длинные/02.m4a", "agc+ns+ec"): {"error": "Аудиофайл пуст."}}},
                    {"id": "small", "name": "Whisper small", "installed": False, "cells": {}}]}
    m.update(changes)
    return m


def test_report_weights_by_words_and_never_turns_a_failure_into_a_number():
    text = markdown(measurement())
    assert "Проверено 2 из 3 записей — итог неполный" in text
    assert "| GigaAM v3 | 1,0% | 0,0%* |" in text  # 1 error in 100 words; the failed recording is left out
    assert "| Whisper small | не скачана | не скачана |" in text
    assert "| mac/длинные/02.m4a | 95 | 0,0% | ошибка |" in text
    assert "- mac/шум/03.m4a — только черновик" in text
    assert "- GigaAM v3, А+Ш+Э (0.3.0), mac/длинные/02.m4a: Аудиофайл пуст." in text
    assert "не сравнимы" not in text


def test_report_warns_when_the_set_changed_since_the_last_one():
    changed = markdown(measurement(previous={"name": "2026-10-06-120000", "fingerprint": "f0"}))
    assert "Набор изменился после замера 2026-10-06-120000" in changed and "не сравнимы" in changed
    assert "не сравнимы" not in markdown(measurement(previous={"name": "2026-10-06-120000", "fingerprint": "f1"}))


def test_saved_reports_are_found_in_order_and_keep_the_numbers(tmp_path):
    save(measurement(), tmp_path)
    save(measurement(created=datetime(2026, 10, 7, 17, 0), fingerprint="f2"), tmp_path)
    assert previous(tmp_path) == {"name": "2026-10-07-170000", "fingerprint": "f2"}
    data = json.loads((tmp_path / "2026-10-07-163000.json").read_text("utf-8"))
    assert data["models"][0]["summary"]["file"]["wer"] == 0.01
    assert data["models"][0]["summary"]["agc+ns+ec"]["complete"] is False
    assert previous(tmp_path / "нет") is None


def test_counts_in_the_report_agree_with_their_words():
    text = markdown(measurement())  # 2 measured of 3, a dictionary of 2 words
    assert "- Набор: 2 записи," in text and "словарь набора (2 слова)" in text
    one = measurement(recordings=[rec("windows/короткие/01.m4a")], dictionaryWords=1)
    assert "- Набор: 1 запись," in markdown(one) and "словарь набора (1 слово)" in markdown(one)
    many = measurement(dictionaryWords=12, recordings=[rec(f"windows/короткие/{i:02}.m4a") for i in range(21)]
                       + [rec("mac/шум/99.m4a", state="draft")])
    text = markdown(many)
    assert "Проверено 21 из 22 записей" in text and "- Набор: 21 запись," in text and "(12 слов)" in text
    assert "Проверено 0 из 1 записи" in markdown(measurement(recordings=[rec("mac/шум/03.m4a", state="draft")]))
