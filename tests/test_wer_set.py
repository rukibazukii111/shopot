import json
import unicodedata

import pytest

from wer_helpers import ROOT  # noqa: F401
from wer_set import Recording, fingerprint, import_dictionary, load_dictionary, scan


def put(root, relative, content=b"x"):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, "utf-8")
    return path


def test_scan_reads_device_kind_and_the_state_of_each_recording(tmp_path):
    put(tmp_path, "windows/короткие/01.m4a")
    put(tmp_path, "windows/короткие/01.txt", "﻿Привет, мир.")
    put(tmp_path, "windows/короткие/02.m4a")
    put(tmp_path, "windows/короткие/02.черновик.txt", "черновик")
    put(tmp_path, "mac/шум/03.wav")
    put(tmp_path, "mac/шум/04.m4a")
    put(tmp_path, "mac/шум/04.wav")
    put(tmp_path, "mac/шум/04.txt", "дубль")
    put(tmp_path, "mac/шум/05.m4a")
    put(tmp_path, "mac/шум/05.txt", " … ")
    put(tmp_path, "mac/шум/06.m4a")
    put(tmp_path, "mac/шум/06.txt", "Привет".encode("cp1251"))
    put(tmp_path, "mac/шум/старое.txt", "без записи")
    put(tmp_path, "dictionary.json", "[]")
    put(tmp_path, "заметки.docx")
    recordings, orphans = scan(tmp_path)
    assert {r.name: (r.device, r.kind, r.state) for r in recordings} == {
        "windows/короткие/01.m4a": ("windows", "короткие", "verified"),
        "windows/короткие/02.m4a": ("windows", "короткие", "draft"),
        "mac/шум/03.wav": ("mac", "шум", "missing"),
        "mac/шум/04.m4a": ("mac", "шум", "duplicate"),
        "mac/шум/04.wav": ("mac", "шум", "duplicate"),
        "mac/шум/05.m4a": ("mac", "шум", "empty"),
        "mac/шум/06.m4a": ("mac", "шум", "unreadable"),
    }
    # The BOM is dropped and a draft is never a reference.
    assert [r.reference for r in recordings if r.state == "verified"] == ["Привет, мир."]
    assert orphans == ["mac/шум/старое.txt"]


def test_names_copied_from_a_mac_match_their_transcripts(tmp_path):
    put(tmp_path, unicodedata.normalize("NFD", "mac/термины/йога.m4a"))
    put(tmp_path, "mac/термины/йога.txt", "Йога по утрам")
    recordings, orphans = scan(tmp_path)
    assert [(r.name, r.state) for r in recordings] == [("mac/термины/йога.m4a", "verified")]
    assert orphans == []


def test_fingerprint_follows_recordings_words_and_dictionary(tmp_path):
    def rec(reference):
        return Recording(tmp_path / "01.m4a", "windows/короткие/01.m4a", "windows", "короткие", "verified", reference)
    hashes = {"windows/короткие/01.m4a": "aaa"}
    base = fingerprint([rec("Привет, мир.")], hashes, [])
    assert fingerprint([rec("привет мир")], hashes, []) == base  # case and marks do not count
    assert fingerprint([rec("Привет, мир и всё.")], hashes, []) != base  # the words changed
    assert fingerprint([rec("Привет, мир.")], {"windows/короткие/01.m4a": "bbb"}, []) != base  # re-recorded
    assert fingerprint([rec("Привет, мир.")], hashes, [{"word": "GitHub", "aliases": ["гитхаб"]}]) != base


def test_import_copies_only_the_dictionary_and_keeps_an_existing_copy(tmp_path):
    store = put(tmp_path, "Shopot/store.json", json.dumps({
        "settings": {"model": "gigaam"}, "history": [{"text": "личная диктовка"}],
        "dictionary": [{"id": "x1", "word": " GitHub ", "aliases": ["гитхаб", " "]}]}, ensure_ascii=False))
    target = tmp_path / "set" / "dictionary.json"
    assert import_dictionary(store, target) == 1
    assert "личная диктовка" not in target.read_text("utf-8")
    assert load_dictionary(target) == [{"word": "GitHub", "aliases": ["гитхаб"]}]
    with pytest.raises(FileExistsError, match="--replace"):
        import_dictionary(store, target)
    put(tmp_path, "Shopot/store.json", json.dumps({"dictionary": []}))
    assert import_dictionary(store, target, replace=True) == 0
    with pytest.raises(FileNotFoundError, match="--import-dictionary"):
        load_dictionary(tmp_path / "нет.json")
    with pytest.raises(FileNotFoundError, match="store.json"):
        import_dictionary(tmp_path / "нет" / "store.json", tmp_path / "другой.json")
