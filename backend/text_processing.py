"""Conservative, deterministic formatting. No paraphrasing or hidden substitutions."""
import re


def vocabulary_prompt(entries, context=""):
    words = [str(e.get("word", "")).strip() for e in entries if e.get("word")]
    # Whisper's prompt has a small context budget; keep the most useful terms first.
    terms = ", ".join(dict.fromkeys(words))[:500]
    return f"{context.strip()[:200]}\n{terms}".strip()


def join_segments(texts, keep_capitalized=()):
    """Join independently recognized chunks into one text.

    Models such as GigaAM treat every chunk as a new sentence and capitalize its first word,
    even when the speaker only paused mid-sentence. The capital is dropped when the previous
    chunk has no sentence-ending punctuation, unless the word looks like a name or acronym
    (dictionary word, all caps, or mixed case such as iPhone).
    """
    keep = {str(word).casefold() for word in keep_capitalized}
    result = ""
    for text in (t.strip() for t in texts):
        if not text:
            continue
        first = re.match(r"\w+", text)
        if (result and first and not re.search(r"[.!?…]$", result)
                and re.fullmatch(r"[^\W\d_][^\W\d_A-ZА-ЯЁ]*", first.group())
                and first.group()[0].isupper() and first.group().casefold() not in keep):
            text = text[0].lower() + text[1:]
        result = f"{result} {text}" if result else text
    return result


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
