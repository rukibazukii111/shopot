from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from text_processing import format_transcript, vocabulary_prompt
from engine import Engine


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
        engine.transcribe({'model': 'turbo', 'audioFile': 'abc.wav'})


@pytest.mark.parametrize('filename', ['../abc.wav', '..\\abc.wav', '/abc.wav', 'C:\\abc.wav',
                                     'abc.txt', 'abc.wav:secret', '', None])
def test_engine_rejects_arbitrary_paths_and_formats(tmp_path, filename):
    engine = Engine(tmp_path)
    with pytest.raises(ValueError, match='имя'):
        engine.audio_path(filename)


def test_missing_recording_is_reported(tmp_path):
    with pytest.raises(ValueError, match='не найден'):
        Engine(tmp_path).audio_path('abc.webm')


def test_redirected_audio_directory_with_unredirected_parent(tmp_path, monkeypatch):
    logical = tmp_path / 'Roaming' / 'Shopot'
    redirected = tmp_path / 'LocalCache' / 'Roaming' / 'Shopot' / 'audio'
    redirected.mkdir(parents=True)
    recording = redirected / '123-abc.webm'
    recording.write_bytes(b'audio fixture')
    resolve = Path.resolve

    def msix_resolve(p, *args, **kwargs):
        canonical = resolve(p, *args, **kwargs)
        logical_audio = resolve(logical / 'audio')
        if canonical.is_relative_to(logical_audio):
            return resolve(redirected / canonical.relative_to(logical_audio))
        return canonical

    monkeypatch.setattr(Path, 'resolve', msix_resolve)
    engine = Engine(logical)
    assert engine.data_dir == resolve(logical)
    assert not engine.audio_dir.is_relative_to(engine.data_dir)
    assert engine.audio_path(recording.name) == resolve(recording)


def test_symlink_cannot_escape_audio_directory_even_with_matching_prefix(tmp_path, monkeypatch):
    engine = Engine(tmp_path)
    outside = tmp_path / 'audio-other' / 'abc.wav'
    outside.parent.mkdir()
    outside.write_bytes(b'outside')
    link = engine.audio_dir / 'abc.wav'
    resolve = Path.resolve
    # Emulate the canonical target without requiring Windows symlink privileges.
    monkeypatch.setattr(Path, 'resolve', lambda p, *a, **kw: outside if p == link else resolve(p, *a, **kw))
    with pytest.raises(ValueError, match='папке записей'):
        engine.audio_path(link.name)


def test_model_name_cannot_traverse_directories(tmp_path):
    with pytest.raises(ValueError):
        Engine(tmp_path).model_path('../../other')


def test_cancel_covers_running_and_queued_requests_but_not_later_ones(tmp_path):
    from engine import Canceled
    engine = Engine(tmp_path)
    engine.canceled_through = 5
    for request_id in (3, 5):
        with pytest.raises(Canceled):
            engine.check_canceled(request_id)
    engine.check_canceled(6)
    engine.check_canceled(None)


def test_stale_idle_timer_does_not_unload_a_model_used_after_it_fired(tmp_path):
    engine = Engine(tmp_path)
    engine.model, engine.loaded_key = object(), 'turbo'
    engine.schedule_idle_unload()
    stale = engine.idle_timer
    engine.schedule_idle_unload()
    try:
        engine._idle_unload(stale)
        assert engine.loaded_key == 'turbo'
        engine._idle_unload(engine.idle_timer)
        assert engine.model is None and engine.loaded_key is None
    finally:
        engine.cancel_idle_unload()


def test_join_segments_drops_chunk_capitals_mid_sentence_only():
    from text_processing import join_segments
    chunks = ['Столбики поставить', 'Иконки у меня расположены.', 'Всё готово', 'iPhone и XR', 'Москва ждёт']
    assert join_segments(chunks, ['Москва']) == (
        'Столбики поставить иконки у меня расположены. Всё готово iPhone и XR Москва ждёт')
    assert join_segments(['', '  ', 'Текст']) == 'Текст'


def test_speech_windows_merge_regions_without_exceeding_the_limit():
    from engine import speech_windows
    speech = [{'start': 0, 'end': 50}, {'start': 60, 'end': 90}, {'start': 95, 'end': 180}, {'start': 200, 'end': 230}]
    assert speech_windows(speech, 100) == [(0, 90), (95, 180), (200, 230)]
    assert speech_windows([], 100) == []


def test_gigaam_needs_all_onnx_files_and_rejects_other_languages(tmp_path):
    import json
    from engine import MODELS, GIGAAM_FILES
    engine = Engine(tmp_path)
    folder = engine.model_path('gigaam')
    folder.mkdir(parents=True)
    (folder / 'shopot-ready.json').write_text(json.dumps({'revision': MODELS['gigaam']['revision']}), 'utf-8')
    for name in GIGAAM_FILES[:-1]:
        (folder / name).write_bytes(b'x')
    assert not engine.is_installed('gigaam')
    (folder / GIGAAM_FILES[-1]).write_bytes(b'x')
    assert engine.is_installed('gigaam')
    (engine.audio_dir / 'abc.wav').write_bytes(b'x')
    with pytest.raises(ValueError, match='только русский'):
        engine.transcribe({'model': 'gigaam', 'audioFile': 'abc.wav', 'language': 'en'})


def _words(text):
    import re
    text = re.sub(r"(?m)^\s*(?:\d+\.|•)\s+", "", text)
    return re.findall(r"\w+", text.casefold())


LIST_TEXT = ('Давай обсудим план. Во-первых, нужно ускорить распознавание. Это важно. '
             'Во-вторых, надо поработать со вставкой. В-третьих, проверим память на Mac. '
             'Теперь про дизайн. Им займусь потом.')


def test_ordinals_become_a_numbered_list_without_changing_words():
    from text_processing import layout_text
    result = layout_text(LIST_TEXT)
    assert result == ('Давай обсудим план.\n\n'
                      '1. Во-первых, нужно ускорить распознавание. Это важно.\n'
                      '2. Во-вторых, надо поработать со вставкой.\n'
                      '3. В-третьих, проверим память на Mac.\n\n'
                      'Теперь про дизайн. Им займусь потом.')
    assert _words(result) == _words(LIST_TEXT)


def test_eto_raz_opens_a_list_and_a_lone_ordinal_does_not():
    from text_processing import layout_text
    spoken = 'Надо сделать абзацы, это раз. Второе замечание, нужно ускорить запись. Спасибо тебе большое.'
    assert layout_text(spoken).startswith('1. Надо сделать абзацы, это раз.\n2. Второе замечание')
    lone = 'Первое, что я бы хотел, это изучить файл. Потом расскажу о проекте. Вот так.'
    assert '1.' not in layout_text(lone)


def test_short_items_after_a_colon_become_bullets():
    from text_processing import layout_text
    result = layout_text('Проверим прогрев. Нужны соцсети: Instagram, TikTok, YouTube и Snapchat.')
    assert result == 'Проверим прогрев. Нужны соцсети:\n• Instagram\n• TikTok\n• YouTube\n• Snapchat'
    long_items = 'Смотри. Итог: мы долго думали над этим, потом ещё раз всё проверили, и всё заработало.'
    assert '•' not in layout_text(long_items)


def test_paragraphs_follow_pauses_and_topic_words_but_not_fillers():
    from text_processing import layout_text, rule_tags, split_sentences
    sentences = split_sentences('Раз два три. Четыре пять. Шесть семь восемь. Вот. Так, новая тема здесь. Девять десять.')
    assert rule_tags(sentences) == ['new', 'same', 'same', 'same', 'new', 'same']
    assert rule_tags(sentences, pauses={2}) == ['new', 'same', 'new', 'same', 'new', 'same']
    assert layout_text('Короткий текст.') == 'Короткий текст.'


def test_invalid_model_tags_fall_back_to_rules():
    from text_processing import layout_text, rule_tags, split_sentences
    expected = layout_text(LIST_TEXT)
    assert layout_text(LIST_TEXT, tags=['new', 'bogus']) == expected
    tags = ['new'] * len(split_sentences(LIST_TEXT))
    # Valid model tags are used as given, except that «Это важно.» (a filler) stays attached.
    assert layout_text(LIST_TEXT, tags=tags).count('\n\n') == len(tags) - 2


def test_pause_sentences_only_counts_pauses_after_a_finished_sentence():
    from text_processing import pause_sentences
    chunks = ['Первая мысль. Ещё фраза.', 'Вторая мысль', 'продолжается. Конец.']
    assert pause_sentences(chunks, [False, True, True]) == {2}


def test_long_pauses_start_a_new_speech_window():
    from engine import speech_windows
    speech = [{'start': 0, 'end': 50}, {'start': 60, 'end': 90}, {'start': 150, 'end': 180}]
    assert speech_windows(speech, 1000) == [(0, 180)]
    assert speech_windows(speech, 1000, split_gap=40) == [(0, 90), (150, 180)]


def test_model_answer_is_fixed_json_around_the_tags():
    import json
    import llm
    parts = llm.answer_parts(3)
    answer = parts[0] + 'new' + parts[1] + 'num' + parts[2] + 'num' + parts[3]
    assert json.loads(answer) == {'tags': [{'n': 1, 't': 'new'}, {'n': 2, 't': 'num'}, {'n': 3, 't': 'num'}]}


def test_model_tags_keep_fillers_attached():
    from text_processing import layout_text
    text = 'Первая мысль здесь. Вот. Вторая мысль тут.'
    assert layout_text(text, tags=['new', 'new', 'new']) == 'Первая мысль здесь. Вот.\n\nВторая мысль тут.'


def test_llm_failure_falls_back_to_rules(tmp_path, monkeypatch):
    from text_processing import layout_text
    engine = Engine(tmp_path)
    monkeypatch.setattr(engine, 'formatter_installed', lambda: True)

    def broken():
        raise RuntimeError('no GPU')
    monkeypatch.setattr(engine, 'load_formatter', broken)
    assert engine.layout(LIST_TEXT, set(), 'llm', 1) == (layout_text(LIST_TEXT), 'rules')
    monkeypatch.setattr(engine, 'formatter_installed', lambda: False)
    assert engine.layout(LIST_TEXT, set(), 'llm', 1)[1] == 'rules'


def test_formatter_is_not_installed_without_verified_marker(tmp_path):
    import json
    engine = Engine(tmp_path)
    runtime, model, marker = engine.formatter_paths()
    runtime.mkdir(parents=True); model.parent.mkdir(parents=True)
    for name in __import__('llm').library_names():
        (runtime / name).write_bytes(b'x')
    model.write_bytes(b'x')
    assert not engine.formatter_installed()
    marker.write_text(json.dumps({'runtime': 'other', 'model': 'other'}), 'utf-8')
    assert not engine.formatter_installed()


@pytest.mark.skipif(not __import__('os').environ.get('SHOPOT_LLM_TEST'), reason='needs llama.cpp runtime and Qwen model')
def test_real_model_tags_an_ordinal_list():
    import os
    import llm
    runtime, model = os.environ['SHOPOT_LLM_TEST'].split(os.pathsep)
    formatter = llm.Formatter(llm.Runtime(runtime), model, 4)
    try:
        tags = formatter.tags(['Давай обсудим план.', 'Во-первых, нужно ускорить распознавание.',
                               'Во-вторых, надо поработать со вставкой.', 'Теперь про дизайн.'])
        assert tags[1:3] == ['num', 'num'] and tags[0] == 'new'
    finally:
        formatter.close()
