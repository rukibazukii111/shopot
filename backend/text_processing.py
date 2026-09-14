"""Conservative, deterministic formatting. No paraphrasing or hidden substitutions."""
import re


def vocabulary_prompt(entries, context=""):
    words = [str(e.get("word", "")).strip() for e in entries if e.get("word")]
    # Whisper's prompt has a small context budget; keep the most useful terms first.
    terms = ", ".join(dict.fromkeys(words))[:500]
    return f"{context.strip()[:200]}\n{terms}".strip()


def format_transcript(text, entries=None, mode="natural"):
    text = text.strip()
    if mode == "raw":
        return text, []
    replacements = []
    alternatives = {}
    for entry in entries or []:
        canonical = str(entry.get("word", "")).strip()
        if not canonical:
            continue
        for alias in entry.get("aliases", []):
            alias = str(alias).strip()
            if alias and alias.casefold() != canonical.casefold():
                alternatives.setdefault(alias.casefold(), (alias, canonical))
    # One pass: replacements must never trigger another replacement.
    if alternatives:
        ordered = sorted(alternatives.values(), key=lambda x: len(x[0]), reverse=True)
        pattern = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(a) for a, _ in ordered) + r")(?!\w)", re.I)

        def replace(match):
            target = alternatives[match.group().casefold()][1]
            replacements.append({"from": match.group(), "to": target})
            return target

        text = pattern.sub(replace, text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" +([,.;:!?])", r"\1", text)
    if mode == "minimal":
        # Preserve punctuation INSIDE technical tokens: iOS 18.2, example.com, C++.
        text = re.sub(r"(?<!\w)[«»\"“”]|[«»\"“”](?!\w)", "", text)
        text = re.sub(r"[,;:!?…]+(?=\s|$)", "", text)
        text = re.sub(r"\.+(?=\s|$)", "", text)
        text = re.sub(r"[ \t]+", " ", text)
    return text.strip(), replacements
