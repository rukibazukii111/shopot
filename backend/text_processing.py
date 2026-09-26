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


SENTENCE_BREAK = re.compile(r"(?<=[.!?…])\s+")
LAYOUT_TAGS = ("new", "same", "num", "bul")
ORDINALS = [
    ("во-первых", "первое", "первый пункт", "пункт первый"),
    ("во-вторых", "второе", "второй пункт", "пункт второй"),
    ("в-третьих", "третье", "третий пункт", "пункт третий"),
    ("в-четвертых", "четвертое", "четвертый пункт", "пункт четвертый"),
    ("в-пятых", "пятое", "пятый пункт", "пункт пятый"),
]
# Words that usually open a new thought in dictation.
TOPIC_STARTS = ("так", "теперь", "дальше", "далее", "также", "кроме того", "еще", "в общем", "итак",
                "по поводу", "что касается", "и последнее", "последнее", "плюс ко всему", "отдельно")
MAX_PARAGRAPH_SENTENCES = 5
MAX_PARAGRAPH_CHARS = 700
MAX_LAST_ITEM_SENTENCES = 2


def split_sentences(text):
    return [s for s in SENTENCE_BREAK.split(text.strip()) if s]


def _folded(sentence):
    return re.sub(r"^[\W_]+", "", sentence.casefold().replace("ё", "е"))


def _ordinal(sentence):
    """1-based ordinal a sentence opens with («Во-вторых, …», «Ну и третье …»), or None."""
    text = re.sub(r"^(?:(?:ну|и|а|итак|так)\W+)*", "", _folded(sentence))
    for number, forms in enumerate(ORDINALS, 1):
        if any(re.match(re.escape(form).replace(r"\-", r"[-\s]?") + r"(?!\w)", text) for form in forms):
            return number
    return None


def _starts_topic(sentence):
    text = _folded(sentence)
    return any(re.match(re.escape(start) + r"(?!\w)", text) for start in TOPIC_STARTS)


def _is_filler(sentence):
    return len(re.findall(r"\w+", sentence)) <= 2


def rule_tags(sentences, pauses=()):
    """Tag each sentence: new paragraph, same paragraph/item, numbered or bulleted item.

    pauses: indices of sentences preceded by a long pause in speech.
    """
    tags = ["same"] * len(sentences)
    if not sentences:
        return tags
    ordinals = [_ordinal(s) for s in sentences]
    # «…это раз.» closes the first item when the next ordinal follows.
    ordinals = [1 if o is None and re.search(r"(?i)\bэто раз\W*$", s) else o for o, s in zip(ordinals, sentences)]
    in_list = set()
    i = 0
    while i < len(sentences):
        # A numbered list needs consecutive ordinals in order: first, second, ...
        if ordinals[i] is not None:
            items, expected, j = [i], ordinals[i] + 1, i + 1
            while j < len(sentences):
                if ordinals[j] == expected:
                    items.append(j); expected += 1
                elif ordinals[j] is not None or (j in pauses and j - items[-1] > 1):
                    break
                j += 1
            if len(items) >= 2:
                # The last item runs until a pause or a couple of sentences, whichever comes first.
                end = items[-1] + 1
                while (end < len(sentences) and end - items[-1] <= MAX_LAST_ITEM_SENTENCES
                       and end not in pauses and not _starts_topic(sentences[end])):
                    end += 1
                for k in range(items[0], end):
                    tags[k] = "num" if k in items else "same"
                    in_list.add(k)
                if end < len(sentences):
                    tags[end] = "new"
                i = end
                continue
        i += 1
    count, chars = 0, 0
    for i, sentence in enumerate(sentences):
        if i in in_list:
            count, chars = 0, 0
            continue
        if i == 0 or tags[i] == "new":
            tags[i] = "new"
        elif not _is_filler(sentence) and count >= 2 and (
                i in pauses or _starts_topic(sentence) or count >= MAX_PARAGRAPH_SENTENCES or chars >= MAX_PARAGRAPH_CHARS):
            tags[i] = "new"
        if tags[i] == "new":
            count, chars = 0, 0
        count += 1
        chars += len(sentence)
    return tags


# A hesitation is one letter dragged out: «ааа», «а-а», «э-э-э», «мм». Real words mix letters,
# so «а», «но», «ну», «мы» are untouched. Acronyms (ООО) and units after a number (10 мм) are kept.
HESITATION = re.compile(r"(?<![^\W\d_])(?<!\d )(?<!-)(?P<word>(?P<letter>[аэыоумАЭЫОУМ])"
                        r"(?:\s*-\s*(?P=letter)|(?P=letter))+)(?![^\W\d_])(?:\s*(?:\.{2,}|[,…]))?", re.I)


def strip_hesitations(text):
    """Remove dragged-out hesitation sounds the model transcribed, with the comma or ellipsis after them."""
    def replace(match):
        word = match.group("word")
        return match.group(0) if word.isupper() and len(word) > 1 else " "

    kept = []
    for sentence in split_sentences(text):
        cleaned = re.sub(r"\s+", " ", HESITATION.sub(replace, sentence)).strip()
        cleaned = re.sub(r"^[\s,;:…·-]+", "", cleaned)
        cleaned = re.sub(r"\s+([,.;:!?…])", r"\1", cleaned)
        if not re.search(r"[^\W\d_]", cleaned):
            continue
        kept.append(_capitalize(cleaned) if sentence[:1].isupper() else cleaned)
    return " ".join(kept)


def _inline_bullets(sentence):
    """«Нужно купить: молоко, хлеб и яйца.» -> prefix and items, when the tail is a list of short items."""
    match = re.match(r"^(.*\S):\s+(.+?)[.!…]?$", sentence)
    if not match:
        return None
    items = [x.strip() for x in re.split(r",\s+|\s+и\s+(?=[^,]+$)", match.group(2))]
    if len(items) < 3 or any(not x or len(re.findall(r"\w+", x)) > 4 or re.search(r"[.!?;:]", x) for x in items):
        return None
    return match.group(1) + ":", items


def _capitalize(text):
    return text[:1].upper() + text[1:] if text[:1].islower() else text


def render_layout(sentences, tags):
    """Rebuild text from the original sentences. Words are never changed, only line breaks and list markers."""
    blocks = []  # [kind, [item, ...]]
    for sentence, tag in zip(sentences, tags):
        kind = {"num": "numbered", "bul": "bulleted"}.get(tag)
        if kind:
            if blocks and blocks[-1][0] == kind:
                blocks[-1][1].append(sentence)
            else:
                blocks.append([kind, [sentence]])
        elif tag == "same" and blocks:
            blocks[-1][1][-1] += " " + sentence
        else:
            blocks.append(["paragraph", [sentence]])
    parts = []
    for kind, items in blocks:
        if kind == "paragraph" or len(items) < 2:
            for item in items:
                parts.extend(_paragraph_with_bullets(_capitalize(item)))
        elif kind == "numbered":
            parts.append("\n".join(f"{n}. {_capitalize(t)}" for n, t in enumerate(items, 1)))
        else:
            parts.append("\n".join(f"• {_capitalize(t)}" for t in items))
    return "\n\n".join(parts)


def _paragraph_with_bullets(paragraph):
    """Split out a trailing «prefix: a, b, c» list inside a paragraph as a bulleted list."""
    sentences = split_sentences(paragraph)
    parts, current = [], []
    for sentence in sentences:
        bullets = _inline_bullets(sentence)
        if bullets:
            prefix, items = bullets
            parts.append(" ".join(current + [prefix]) + "\n" + "\n".join(f"• {item}" for item in items))
            current = []
        else:
            current.append(sentence)
    if current:
        parts.append(" ".join(current))
    return parts


def pause_sentences(texts, pause_before, keep_capitalized=()):
    """Sentence indices that follow a long pause.

    texts are recognized chunks in order; pause_before[i] is True when chunk i follows a long pause.
    A pause only counts where the previous chunk ended a sentence.
    """
    result = set()
    for i in range(1, len(texts)):
        if pause_before[i]:
            prefix = join_segments(texts[:i], keep_capitalized)
            if re.search(r"[.!?…]$", prefix):
                result.add(len(split_sentences(prefix)))
    return result


def layout_text(text, pauses=(), tags=None):
    """Paragraphs and lists for dictated text; tags may come from a language model."""
    sentences = split_sentences(text)
    if len(sentences) < 2 and not any(_inline_bullets(s) for s in sentences):
        return text
    if tags is None or len(tags) != len(sentences) or any(t not in LAYOUT_TAGS for t in tags):
        tags = rule_tags(sentences, set(pauses))
    else:
        # «Вот.», «Понял?» stay with the previous paragraph whoever decided the layout.
        tags = [("same" if i and t == "new" and _is_filler(s) else t) for i, (t, s) in enumerate(zip(tags, sentences))]
    return render_layout(sentences, tags)


SNIPPET_SEPARATOR = r"[\s,;:\-–—]+"


def _spoken_words(phrase):
    return re.findall(r"[^\W_]+", phrase)


def _word_pattern(word):
    # «е» and «ё» are the same letter in speech recognition output.
    return "".join("[её]" if c in "её" else "[ЕЁ]" if c in "ЕЁ" else re.escape(c) for c in word)


# «моя» has a two-letter stem; its forms (мою, моей, моего) still name the same thing.
_SHORT_STEMS = {"моя", "мой", "моё", "мое", "мои"}


def _inflected_pattern(word):
    """A Russian trigger word in any case form: «почта» also matches «почту» and «почтой», not «почтовый».

    The model follows grammar, so «моя почта» said mid-sentence comes out as «мою почту».
    Words in Latin letters or with digits match exactly.
    """
    folded = word.casefold().replace("ё", "е")
    if not re.fullmatch(r"[а-я]+", folded):
        return _word_pattern(word)
    stem = folded.rstrip("аеиоуыэюяьй")
    if len(stem) < 3 and folded not in _SHORT_STEMS:
        return _word_pattern(word)
    # Case endings start with a vowel or «ь» and are short; derived words («почтовый», «реквизитная») do not match.
    return _word_pattern(stem) + "(?:[аеёиоуыэюяь][а-яё]{0,2})?"


def expand_snippets(text, snippets, entries=()):
    """Replace spoken trigger phrases with the user's saved text. Returns (text, triggers used).

    The saved text goes in exactly as written and is never matched again. Punctuation and hyphens
    between the spoken words and Russian case endings do not matter, and a dictionary replacement
    inside the phrase still matches.
    A trigger that is a whole sentence takes the sentence's end punctuation with it, and a
    multi-line snippet then stands as its own paragraph.
    """
    alternatives = []
    for index, snippet in enumerate(snippets or []):
        trigger = str(snippet.get("trigger", ""))
        for variant in {trigger, format_transcript(trigger, entries)[0]}:
            words = _spoken_words(variant)
            if words:
                alternatives.append((sum(map(len, words)), index, SNIPPET_SEPARATOR.join(map(_inflected_pattern, words))))
    if not alternatives:
        return text, []
    # One pass over the text, longer phrases first, so «моя рабочая почта» wins over «моя почта».
    alternatives.sort(key=lambda item: -item[0])
    body = "|".join(f"(?P<s{n}_{index}>{words})" for n, (_, index, words) in enumerate(alternatives))
    pattern = re.compile(r"(?<![^\W_])(?:" + body + r")(?![^\W_])", re.IGNORECASE)
    parts, position, used = [], 0, []
    for match in pattern.finditer(text):
        snippet = snippets[int(match.lastgroup.split("_")[1])]
        saved = str(snippet.get("text", "")).replace("\r\n", "\n").strip("\n")
        start, end = match.span()
        tail = re.match(r"[.!?…]+", text[end:])
        after = end + (tail.end() if tail else 0)
        rest = text[after:]
        whole = bool(start == 0 or re.search(r"(?:[.!?…]\s+|\n\s*)$", text[:start])) and \
            bool(tail or not rest or rest[0] == "\n")
        block = whole and "\n" in saved
        head = text[position:start]
        # The spoken end punctuation goes when the saved text brings its own, or when nothing follows
        # (an address or a link at the end is pasted without a stray period).
        if tail and (block or re.search(r"[.!?…]$", saved) or (whole and not rest.strip())):
            end = after
        if block:
            head = head.rstrip()
            saved = ("\n\n" if head or parts else "") + saved
            if text[end:].strip():
                saved += "\n\n"
                end += len(text[end:]) - len(text[end:].lstrip())
        parts += [head, saved]
        position = end
        used.append(str(snippet.get("trigger", "")))
    parts.append(text[position:])
    return "".join(parts), used


VOICE_COMMANDS = {"новый абзац": "\n\n", "с нового абзаца": "\n\n", "новый параграф": "\n\n",
                  "новая строка": "\n", "с новой строки": "\n"}
_COMMAND_PATTERN = re.compile(
    # Commas and dashes the model put around the spoken command go with it; a colon before it stays («Список:»).
    r"[\s,;\-–—]*(?<![^\W_])(?P<command>"
    + "|".join(SNIPPET_SEPARATOR.join(map(_word_pattern, phrase.split()))
               for phrase in sorted(VOICE_COMMANDS, key=len, reverse=True))
    + r")(?![^\W_])[\s.,;:!?…\-–—]*", re.IGNORECASE)


def apply_voice_commands(text):
    """«Новый абзац» and «с новой строки» spoken during dictation become breaks. Returns (text, commands used).

    Nothing else is rewritten: only the command words, the punctuation around them and the capital after the break.
    """
    parts, position, used = [], 0, []
    for match in _COMMAND_PATTERN.finditer(text):
        command = " ".join(_spoken_words(match.group("command").casefold().replace("ё", "е")))
        parts += [text[position:match.start()], VOICE_COMMANDS[command]]
        position = match.end()
        used.append(command)
    if not used:
        return text, []
    parts.append(text[position:])
    result = re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()
    # A new line or paragraph starts with a capital, and so does text that opened with a command.
    result = re.sub(r"(\n)(\W*)(\w)", lambda m: m.group(1) + m.group(2) + m.group(3).upper(), result)
    return _capitalize(result) if not parts[0].strip() else result, used


def drop_final_period(text):
    """Messenger style: no period after the last sentence. An ellipsis, «?» and «!» stay."""
    return re.sub(r"(?<=[^.\s])\.\s*$", "", text)


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
