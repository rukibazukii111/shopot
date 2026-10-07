"""Comparing a transcript with its reference for the WER measurement (PRD, section 7)."""
import re
import unicodedata

# «120 000» and «120000» are one number; GigaAM writes thousands with a space.
THOUSANDS = re.compile(r"(?<!\d)(\d{1,3})((?: \d{3})+)(?!\d)")


def normalize(text):
    """Words to compare: lower case, «ё» as «е», every mark a space (so «кто-то» is «кто то»), «1 000» as «1000»."""
    text = unicodedata.normalize("NFC", text)
    # Combining marks left after NFC (stress marks) are not letters; «й» and «ё» are single characters by now.
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    text = " ".join(re.sub(r"[\W_]+", " ", text.lower().replace("ё", "е")).split())
    return THOUSANDS.sub(lambda match: match.group(1) + match.group(2).replace(" ", ""), text).split()


def word_errors(reference, hypothesis):
    """Fewest substitutions, deletions and insertions that turn the reference words into the hypothesis."""
    # A cell is (errors, substitutions, deletions, insertions) for reference[:i] against hypothesis[:j].
    previous = [(j, 0, 0, j) for j in range(len(hypothesis) + 1)]
    for i, expected in enumerate(reference, 1):
        current = [(i, 0, i, 0)]
        for j, heard in enumerate(hypothesis, 1):
            if expected == heard:
                current.append(previous[j - 1])
                continue
            e, s, d, n = previous[j - 1]
            substitute = (e + 1, s + 1, d, n)
            e, s, d, n = previous[j]
            delete = (e + 1, s, d + 1, n)
            e, s, d, n = current[j - 1]
            insert = (e + 1, s, d, n + 1)
            current.append(min(substitute, delete, insert, key=lambda cell: cell[0]))
        previous = current
    errors, substitutions, deletions, insertions = previous[-1]
    return {"words": len(reference), "errors": errors, "substitutions": substitutions,
            "deletions": deletions, "insertions": insertions}


def total(counts):
    """WER of a group: all its errors over all its reference words (owner's decision, 07.10.2026)."""
    result = {key: sum(c[key] for c in counts)
              for key in ("words", "errors", "substitutions", "deletions", "insertions")}
    result["wer"] = result["errors"] / result["words"] if result["words"] else None
    return result
