"""The reference set (PRD, section 7): recordings, their verified transcripts and the set's dictionary.

Layout: <set>/<device>/<kind>/<name>.<ext>; the verified transcript is <name>.txt next to the recording.
A draft <name>.черновик.txt is never measured. <set>/dictionary.json is the owner's dictionary, copied once.
"""
import hashlib
import json
import os
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from wer_text import normalize

# The formats the engine accepts (backend/engine.py, Engine.audio_path).
AUDIO_EXTENSIONS = {".wav", ".webm", ".mp3", ".m4a", ".ogg", ".flac", ".mp4"}
DRAFT_SUFFIX = ".черновик.txt"
DICTIONARY_FILE = "dictionary.json"
STATES = {"verified": "проверена", "draft": "только черновик", "missing": "нет расшифровки",
          "duplicate": "два файла записи с одним именем", "unreadable": "расшифровка не в кодировке UTF-8",
          "empty": "в расшифровке нет слов"}


@dataclass
class Recording:
    path: Path
    name: str  # relative to the set, NFC, with «/»: the key in reports
    device: str  # first folder: windows, mac
    kind: str  # second folder: короткие, длинные, термины, шум, созвоны
    state: str  # a key of STATES; only "verified" is measured
    reference: str = ""


def scan(root):
    """Recordings with their state, and verified transcripts left without a recording.

    Names are compared in NFC: files copied from a Mac often carry NFD names.
    """
    root = Path(root)
    audio, texts = {}, {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = unicodedata.normalize("NFC", path.relative_to(root).as_posix())
        if any(part.startswith(".") for part in relative.split("/")):
            continue  # «._name» AppleDouble files from a Mac via a FAT drive, .DS_Store, .Trashes: not recordings
        if relative.lower().endswith(DRAFT_SUFFIX):
            texts.setdefault(relative[:-len(DRAFT_SUFFIX)], {})["draft"] = path
        elif relative.lower().endswith(".txt"):
            texts.setdefault(relative[:-len(".txt")], {})["verified"] = path
        elif path.suffix.lower() in AUDIO_EXTENSIONS:
            audio.setdefault(relative[:-len(path.suffix)], []).append((relative, path))
    recordings = []
    for stem, files in audio.items():
        folders = stem.split("/")[:-1]
        state, reference = _state(files, texts.get(stem, {}))
        for relative, path in files:
            recordings.append(Recording(path, relative, folders[0] if folders else "—",
                                        folders[1] if len(folders) > 1 else "—", state, reference))
    orphans = sorted(f"{stem}.txt" for stem, found in texts.items() if "verified" in found and stem not in audio)
    return sorted(recordings, key=lambda r: r.name), orphans


def _state(files, found):
    if len(files) > 1:
        return "duplicate", ""
    if "verified" not in found:
        return ("draft" if "draft" in found else "missing"), ""
    try:
        reference = found["verified"].read_text("utf-8-sig")
    except UnicodeDecodeError:
        return "unreadable", ""
    return ("verified" if normalize(reference) else "empty"), reference


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while block := source.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def fingerprint(measured, hashes, dictionary):
    """Equal only for the same recordings, the same words in their transcripts and the same dictionary."""
    digest = hashlib.sha256()
    for recording in sorted(measured, key=lambda r: r.name):
        digest.update(json.dumps([recording.name, hashes[recording.name], normalize(recording.reference)],
                                 ensure_ascii=False).encode())
    digest.update(json.dumps(dictionary, ensure_ascii=False, sort_keys=True).encode())
    return digest.hexdigest()[:12]


def clean_dictionary(entries):
    """Dictionary entries as the engine takes them, {"word", "aliases"}; ids and empty aliases are dropped."""
    if not isinstance(entries, list):
        raise ValueError("Словарь должен быть списком слов.")
    result = []
    for entry in entries:
        word = entry.get("word") if isinstance(entry, dict) else None
        aliases = entry.get("aliases", []) if isinstance(entry, dict) else None
        if (not isinstance(word, str) or not word.strip() or not isinstance(aliases, list)
                or not all(isinstance(alias, str) for alias in aliases)):
            raise ValueError(f"Неверная запись в словаре: {entry!r}")
        result.append({"word": word.strip(), "aliases": [alias.strip() for alias in aliases if alias.strip()]})
    return result


def load_dictionary(path):
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Нет словаря набора: {path}. "
                                "Скопируй словарь из Шёпота: python scripts/wer.py --import-dictionary")
    return clean_dictionary(json.loads(path.read_text("utf-8")))


def default_store():
    """store.json of the installed Shopot."""
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "Shopot" / "store.json"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Shopot" / "store.json"
    return Path.home() / ".config" / "Shopot" / "store.json"


def import_dictionary(store, target, replace=False):
    """Copy the dictionary, and nothing else, out of Shopot's store.json; the copy stays until replaced."""
    store, target = Path(store), Path(target)
    if target.exists() and not replace:
        raise FileExistsError(f"Словарь набора уже есть: {target}. Чтобы заменить его, добавь --replace.")
    if not store.is_file():
        raise FileNotFoundError(f"Не нашёл store.json Шёпота: {store}. "
                                "Укажи путь: --import-dictionary <путь к store.json>")
    data = json.loads(store.read_text("utf-8"))
    if not isinstance(data, dict) or "dictionary" not in data:
        raise ValueError(f"В {store} нет словаря Шёпота.")
    entries = clean_dictionary(data["dictionary"])
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".tmp")
    temp.write_text(json.dumps(entries, ensure_ascii=False, indent=2), "utf-8")
    os.replace(temp, target)
    return len(entries)
