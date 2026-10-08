"""The WER report: Markdown to read and JSON to compare (PRD, section 7). Both stay in .private, never in Git."""
import json
from collections import Counter
from pathlib import Path

from wer_set import STATES
from wer_text import normalize, plural, total

LABELS = {"file": "Исходный файл", "none": "Всё выключено", "agc": "А", "ns": "Ш", "ec": "Э",
          "agc+ns": "А+Ш", "agc+ec": "А+Э", "ns+ec": "Ш+Э", "agc+ns+ec": "А+Ш+Э (0.3.0)"}


def summarize(cells, names, variants):
    """WER of each variant over the given recordings. A variant that lost any of them is incomplete, never zero."""
    result = {}
    for variant in variants:
        found = [cells.get((name, variant), {}) for name in names]
        result[variant] = {**total([cell["counts"] for cell in found if "counts" in cell]),
                           "complete": all("counts" in cell for cell in found)}
    return result


def shown(summary):
    if summary["wer"] is None:
        return "ошибка"
    return f"{summary['wer'] * 100:.1f}%".replace(".", ",") + ("" if summary["complete"] else "*")


def escape(text):
    return str(text).replace("|", "\\|")


def table(title, rows, variants):
    lines = [f"| {title} | Слов | " + " | ".join(LABELS[v] for v in variants) + " |",
             "|---|---|" + "---|" * len(variants)]
    lines += [f"| {escape(label)} | {words} | " + " | ".join(shown(summary[v]) for v in variants) + " |"
              for label, words, summary in rows]
    return lines


def markdown(m):
    measured = [r for r in m["recordings"] if r.state == "verified"]
    names = [r.name for r in measured]
    words = {r.name: len(normalize(r.reference)) for r in measured}
    variants, installed = m["variants"], [model for model in m["models"] if model["installed"]]
    summaries = {model["id"]: summarize(model["cells"], names, variants) for model in installed}
    lines = [f"# Замер WER, {m['created']:%d.%m.%Y %H:%M}", ""]
    if len(measured) < len(m["recordings"]):
        lines += [f"> **Проверено {len(measured)} из {len(m['recordings'])} "
                  f"{plural(len(m['recordings']), 'записи', 'записей', 'записей')} — итог неполный.**", ""]
    last = m["previous"]
    if last and last["fingerprint"] != m["fingerprint"]:
        lines += [f"> **Набор изменился после замера {last['name']}: записи, эталоны или словарь другие. "
                  "Числа этих замеров не сравнимы.**", ""]
    devices = ", ".join(f"{device}: {count}" for device, count in sorted(Counter(r.device for r in measured).items()))
    minutes = f"{sum(m['durations'].values()) / 60:.1f}".replace(".", ",")
    lines += [f"- Набор: {len(measured)} {plural(len(measured), 'запись', 'записи', 'записей')}, {minutes} мин ({devices}). Отпечаток набора: {m['fingerprint']}.",
              f"- Текст: итог Шёпота — русский язык, режим «Естественно», словарь набора ({m['dictionaryWords']} "
              f"{plural(m['dictionaryWords'], 'слово', 'слова', 'слов')}), "
              "чистка «э-э», голосовые команды, без абзацев и списков.",
              f"- Код: {m['commit']}." + (f" Обработка звука: Chromium из Electron {m['electron']}." if m["electron"] else ""),
              "- WER — доля ошибочных слов: замены, пропуски и вставки, делённые на число слов эталонов группы.",
              "- «Исходный файл» — запись как есть: так Шёпот распознаёт открытый файл. Остальные — запись через "
              "Chromium, как с микрофона: А — автогромкость, Ш — шумоподавление, Э — эхоподавление. "
              "«А+Ш+Э» — как в Шёпоте 0.3.0."]
    if any(model["id"] == "large-v3" for model in installed):
        lines.append("- Черновики расшифровок делала Whisper large-v3, поэтому её WER немного занижен.")
    if any(not summary["complete"] for model in summaries.values() for summary in model.values()):
        lines.append("- \\* — не все записи распознаны, итог неполный. Что не вошло — в конце отчёта.")
    lines += ["", "## Средний WER", "", "| Модель | " + " | ".join(LABELS[v] for v in variants) + " |",
              "|---|" + "---|" * len(variants)]
    for model in m["models"]:
        cells = ([shown(summaries[model["id"]][v]) for v in variants] if model["installed"]
                 else ["не скачана"] * len(variants))
        lines.append(f"| {model['name']} | " + " | ".join(cells) + " |")
    for title, field, column in (("По видам записей", "kind", "Вид"), ("По устройствам", "device", "Устройство")):
        lines += ["", f"## {title}"]
        groups = {}
        for r in measured:
            groups.setdefault(getattr(r, field), []).append(r.name)
        for model in installed:
            rows = [(group, sum(words[name] for name in members), summarize(model["cells"], members, variants))
                    for group, members in sorted(groups.items())]
            lines += ["", f"### {model['name']}", ""] + table(column, rows, variants)
    lines += ["", "## Записи"]
    for model in installed:
        rows = [(name, words[name], summarize(model["cells"], [name], variants)) for name in names]
        lines += ["", f"### {model['name']}", ""] + table("Запись", rows, variants)
    problems = [f"- {escape(r.name)} — {STATES[r.state]}" for r in m["recordings"] if r.state != "verified"]
    problems += [f"- {escape(name)} — расшифровка без записи" for name in m["orphans"]]
    for model in installed:
        problems += [f"- {model['name']}, {LABELS[variant]}, {escape(name)}: {cell['error']}"
                     for (name, variant), cell in sorted(model["cells"].items()) if "error" in cell]
    if problems:
        lines += ["", "## Не вошло в замер", ""] + problems
    return "\n".join(lines) + "\n"


def to_json(m):
    measured = [r for r in m["recordings"] if r.state == "verified"]
    names = [r.name for r in measured]
    return {"created": m["created"].isoformat(timespec="seconds"), "commit": m["commit"], "electron": m["electron"],
            "fingerprint": m["fingerprint"], "settings": m["settings"], "dictionaryWords": m["dictionaryWords"],
            "variants": m["variants"],
            "set": {"recordings": len(m["recordings"]), "verified": len(measured),
                    "seconds": round(sum(m["durations"].values()), 1)},
            "notMeasured": [{"name": r.name, "state": r.state} for r in m["recordings"] if r.state != "verified"],
            "orphans": m["orphans"],
            "models": [{"id": model["id"], "name": model["name"], "installed": model["installed"],
                        "summary": summarize(model["cells"], names, m["variants"]) if model["installed"] else None,
                        "cells": [{"name": name, "variant": variant, **cell}
                                  for (name, variant), cell in sorted(model["cells"].items())]}
                       for model in m["models"]]}


def save(m, folder):
    """Writes <date-time>.json and .md; returns the Markdown path."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"{m['created']:%Y-%m-%d-%H%M%S}"
    (folder / f"{stem}.json").write_text(json.dumps(to_json(m), ensure_ascii=False, indent=2), "utf-8")
    (folder / f"{stem}.md").write_text(markdown(m), "utf-8")
    return folder / f"{stem}.md"


def previous(folder):
    """The latest earlier report, so a new one can say whether the set changed since."""
    reports = sorted(Path(folder).glob("*.json"))
    if not reports:
        return None
    try:
        return {"name": reports[-1].stem, "fingerprint": json.loads(reports[-1].read_text("utf-8"))["fingerprint"]}
    except (OSError, ValueError, KeyError):
        return None
