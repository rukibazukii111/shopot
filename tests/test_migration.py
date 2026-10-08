"""Models downloaded by Shopot 0.3.0 stay installed (PRD, section 10)."""
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from engine import Engine  # noqa: E402

FIXTURE = Path(__file__).parent / 'fixtures' / 'data-0.3.0'


def test_models_downloaded_by_0_3_0_stay_installed(tmp_path):
    shutil.copytree(FIXTURE, tmp_path, dirs_exist_ok=True)
    engine = Engine(tmp_path)
    assert engine.is_installed('gigaam') and engine.is_installed('small')
    assert not engine.is_installed('turbo') and not engine.is_installed('large-v3')


def test_a_model_of_another_revision_is_not_installed(tmp_path):
    # Guards the test above: a changed pin in MODELS would make users download the model again.
    shutil.copytree(FIXTURE, tmp_path, dirs_exist_ok=True)
    (tmp_path / 'models' / 'small' / 'shopot-ready.json').write_text(json.dumps({'revision': 'other'}), 'utf-8')
    assert not Engine(tmp_path).is_installed('small')
