"""Models and the formatter downloaded by Shopot 0.3.0 stay installed (PRD, section 10)."""
import json
import os
import platform
import shutil
import sys
from pathlib import Path

import pytest

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


# What 0.3.0 pinned for the text-formatting model (Windows x64 only), copied from 0.3.0's engine.py and llm.py.
FORMATTER_0_3_0 = {'build': 'b11040', 'file': 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 'bytes': 2497281120,
                   'model': '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
                   'runtimes': {('win32', 'amd64'): '1f71a94bb3b7f615f110b0db5721618535feccff0b3fb0aba9b98c507e751b62'}}


def test_formatter_pins_of_0_3_0_are_kept():
    # A new llama.cpp build or model file would make 0.3.0 users download ~2.4 GB again.
    import llm
    from engine import FORMATTER
    assert llm.LLAMA_BUILD == FORMATTER_0_3_0['build']
    assert {key: FORMATTER['model'][key] for key in ('file', 'bytes', 'sha256')} == {
        'file': FORMATTER_0_3_0['file'], 'bytes': FORMATTER_0_3_0['bytes'], 'sha256': FORMATTER_0_3_0['model']}
    for key, sha256 in FORMATTER_0_3_0['runtimes'].items():
        assert FORMATTER['runtimes'][key]['sha256'] == sha256


@pytest.mark.skipif((sys.platform, platform.machine().lower()) != ('win32', 'amd64'),
                    reason='0.3.0 installed the formatter only on Windows x64')
def test_formatter_downloaded_by_0_3_0_stays_installed(tmp_path, monkeypatch):
    shutil.copytree(FIXTURE, tmp_path, dirs_exist_ok=True)
    model = tmp_path / 'formatter' / 'model' / FORMATTER_0_3_0['file']
    real_stat = Path.stat

    def stat(self, **kwargs):
        # The fixture model is a one-byte stand-in; report the size of the real 0.3.0 download.
        result = real_stat(self, **kwargs)
        if self == model:
            return os.stat_result((*result[:6], FORMATTER_0_3_0['bytes'], *result[7:10]))
        return result

    monkeypatch.setattr(Path, 'stat', stat)
    assert Engine(tmp_path).formatter_installed()
