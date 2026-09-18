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
