import pytest

from wer_helpers import ROOT  # noqa: F401  (puts scripts/ on the path)
from wer_text import normalize, total, word_errors


@pytest.mark.parametrize("text, words", [
    ("Привет, Мир!", ["привет", "мир"]),
    ("Ёлка ещё ЁЖ", ["елка", "еще", "еж"]),
    ("кто-то — «здесь»…", ["кто", "то", "здесь"]),
    ("Бюджет 120 000₽, это 20%.", ["бюджет", "120000", "это", "20"]),
    ("1 000 000 и 2 3", ["1000000", "и", "2", "3"]),
    ("10\u00a0000 руб", ["10000", "руб"]),
    ("3,5 или 3.5", ["3", "5", "или", "3", "5"]),
    ("в 15:30", ["в", "15", "30"]),
    ("за\u0301мок", ["замок"]),
    ("и\u0306од", ["йод"]),
    ("C++ и iOS 18.2", ["c", "и", "ios", "18", "2"]),
    ("  ... — !", []),
])
def test_normalize_keeps_only_words(text, words):
    assert normalize(text) == words


def test_word_errors_count_substitutions_deletions_and_insertions():
    assert word_errors(["а", "б"], ["а", "б"])["errors"] == 0
    assert word_errors(["а", "б", "в"], ["а", "х", "в"]) == {
        "words": 3, "errors": 1, "substitutions": 1, "deletions": 0, "insertions": 0}
    assert word_errors(["а", "б", "в"], ["а", "в"]) == {
        "words": 3, "errors": 1, "substitutions": 0, "deletions": 1, "insertions": 0}
    assert word_errors(["а", "в"], ["а", "б", "в"]) == {
        "words": 2, "errors": 1, "substitutions": 0, "deletions": 0, "insertions": 1}
    assert word_errors(["а", "б"], []) == {"words": 2, "errors": 2, "substitutions": 0, "deletions": 2, "insertions": 0}
    assert word_errors([], ["а"]) == {"words": 0, "errors": 1, "substitutions": 0, "deletions": 0, "insertions": 1}
    assert word_errors("я сегодня иду в кино".split(), "я седня иду кино вечером".split())["errors"] == 3


def test_average_is_over_words_not_recordings():
    short = word_errors(["раз", "два", "три", "четыре", "пять"], ["раз", "два", "три", "четыре", "шесть"])  # 20 %
    long = word_errors(["слово"] * 95, ["слово"] * 95)  # 0 %
    assert total([short, long])["wer"] == pytest.approx(0.01)  # not (20 % + 0 %) / 2
    assert total([])["wer"] is None
