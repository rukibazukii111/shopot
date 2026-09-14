import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from text_processing import format_transcript, vocabulary_prompt
from engine import Engine, MODELS


def test_dictionary_respects_unicode_word_boundaries_and_does_not_chain():
    terms = [{'word': 'LocalSend', 'aliases': ['локал сенд']}, {'word': 'Шёпот', 'aliases': ['LocalSend']}]
    text, replacements = format_transcript('Открой ЛОКАЛ СЕНД. Не трогай локал сендовый.', terms)
    assert text == 'Открой LocalSend. Не трогай локал сендовый.'
    assert len(replacements) == 1


def test_raw_mode_preserves_slang_and_punctuation_without_aliases():
    source = 'Бля, короче... локал сенд, видосы.'
    assert format_transcript(source, [{'word': 'LocalSend', 'aliases': ['локал сенд']}], 'raw') == (source, [])


def test_minimal_mode_does_not_destroy_versions_urls_or_acronyms():
    text, _ = format_transcript('iOS 18.2, example.com! C++: готово.', mode='minimal')
    assert text == 'iOS 18.2 example.com C++ готово'


def test_aliases_are_literal_not_regular_expressions():
    assert format_transcript('C++ C plus', [{'word': 'C++', 'aliases': ['C plus']}])[0] == 'C++ C++'


def test_vocab_prompt_is_bounded():
    assert len(vocabulary_prompt([{'word': 'а' * 5000}], 'б' * 5000)) <= 701


def test_partial_download_is_not_usable(tmp_path):
    engine = Engine(tmp_path)
    model = tmp_path / 'models' / 'turbo'
    model.mkdir()
    (model / 'model.bin').write_bytes(b'incomplete')
    assert not engine.is_installed('turbo')
    with pytest.raises(ValueError, match='скачай'):
        engine.transcribe({'model': 'turbo', 'path': str(tmp_path / 'audio.wav')})


def test_engine_rejects_audio_outside_its_data_folder(tmp_path):
    engine = Engine(tmp_path)
    model = tmp_path / 'models' / 'turbo'
    model.mkdir()
    for name in ('model.bin', 'config.json', 'tokenizer.json'):
        (model / name).write_text('fixture')
    (model / 'shopot-ready.json').write_text(json.dumps({'revision': MODELS['turbo']['revision']}))
    with pytest.raises(ValueError, match='папке данных'):
        engine.transcribe({'model': 'turbo', 'path': str(tmp_path.parent / 'outside.wav')})


def test_model_name_cannot_traverse_directories(tmp_path):
    with pytest.raises(ValueError):
        Engine(tmp_path).model_path('../../other')
