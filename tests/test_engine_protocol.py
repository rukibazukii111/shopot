from pathlib import Path
import json
import os
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from engine import MODELS, Canceled, Engine, UserError, error_reply


def test_only_the_engines_own_refusals_are_expected():
    """The app's journal keeps an error's message only when it is expected; library messages can quote paths."""
    assert error_reply(1, UserError('Аудиофайл пуст.')) == {
        'id': 1, 'error': 'Аудиофайл пуст.', 'kind': 'UserError', 'expected': True}
    assert error_reply(2, Canceled('Операция отменена.')) == {
        'id': 2, 'error': 'Операция отменена.', 'kind': 'Canceled', 'expected': True, 'canceled': True}
    assert error_reply(3, KeyError('model'))['expected'] is False

    class LibraryError(ValueError):
        pass
    reply = error_reply(4, LibraryError(r'Invalid data found when processing input: C:\Users\Ivan\встреча.mp3'))
    assert reply['kind'] == 'LibraryError' and reply['expected'] is False
    assert error_reply(5, RuntimeError())['error'] == 'RuntimeError'


def test_engine_refusals_stay_value_errors_for_existing_callers(tmp_path):
    assert issubclass(UserError, ValueError)
    try:
        Engine(tmp_path).audio_path('../escape.wav')
    except UserError as error:
        assert str(error) == 'Недопустимое имя аудиозаписи.'
    else:
        raise AssertionError('a bad audio name must be refused')


def test_status_names_the_pinned_revision_of_every_model(tmp_path):
    models = {model['id']: model for model in Engine(tmp_path).status()['models']}
    assert {key: models[key]['revision'] for key in MODELS} == {key: value['revision'] for key, value in MODELS.items()}


def test_error_replies_over_the_pipe_carry_kind_and_expected(tmp_path):
    engine_py = Path(__file__).resolve().parents[1] / 'backend' / 'engine.py'
    commands = [{'id': 1, 'command': 'nope'}, {'id': 2, 'command': 'download'}]
    done = subprocess.run([sys.executable, str(engine_py), '--data-dir', str(tmp_path)],
                          input=''.join(json.dumps(c) + '\n' for c in commands), capture_output=True,
                          text=True, encoding='utf-8', timeout=180,
                          env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    replies = {m['id']: m for m in map(json.loads, done.stdout.splitlines()) if 'id' in m}
    assert replies[1] == {'id': 1, 'error': 'Неизвестная команда', 'kind': 'UserError', 'expected': True}
    assert replies[2]['kind'] == 'KeyError' and replies[2]['expected'] is False
