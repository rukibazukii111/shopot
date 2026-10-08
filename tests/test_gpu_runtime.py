from pathlib import Path
import hashlib
import http.server
import io
import json
import sys
import threading
import zipfile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import gpu_runtime
from gpu_runtime import Component


def wheel(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()


@pytest.fixture
def server():
    """Local HTTP server with Range support; tests put files into `files` and see the Range headers.

    `truncate`: send only that many bytes of the body, then close. `portal`: answer a Range request with a short page.
    """
    state = {'files': {}, 'ranges': [], 'ignore_range': False, 'truncate': None, 'portal': False}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            data = state['files'][self.path]
            header = self.headers.get('Range')
            state['ranges'].append(header)
            if header and state['portal']:
                self.send_response(200)
                body = b'<html>login</html>'
            elif header and not state['ignore_range']:
                self.send_response(206)
                body = data[int(header.split('=')[1].split('-')[0]):]
            else:
                self.send_response(200)
                body = data
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body if state['truncate'] is None else body[:state['truncate']])
            self.close_connection = True

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    state['url'] = f'http://127.0.0.1:{httpd.server_port}'
    yield state
    httpd.shutdown()


@pytest.fixture
def wheels(server, monkeypatch):
    """Two small fake wheels pinned the same way as the real NVIDIA ones."""
    specs = []
    for index, dlls in enumerate([{'nvidia/a/bin/a.dll': b'A' * 5000},
                                  {'nvidia/b/bin/b.dll': b'B' * 7000, 'nvidia/b/bin/c.dll': b'C' * 300}]):
        data = wheel({**dlls, 'nvidia/a/include/skip.h': b'h'})
        server['files'][f'/w{index}.whl'] = data
        specs.append({'name': f'w{index}', 'file': f'w{index}.whl', 'url': f"{server['url']}/w{index}.whl",
                      'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                      'dlls': {name: len(content) for name, content in dlls.items()}})
    monkeypatch.setattr(gpu_runtime, 'WHEELS', specs)
    return specs


def quiet(*args, **kwargs):
    pass


def test_install_unpacks_only_pinned_dlls_and_marks_ready_last(tmp_path, wheels):
    component, seen = Component(tmp_path / 'gpu'), []
    assert not component.installed()
    component.install(lambda done, total, message, final=False: seen.append((done, total, final)))
    assert component.installed()
    assert sorted(p.name for p in component.runtime.iterdir()) == ['a.dll', 'b.dll', 'c.dll']
    assert not component.downloads.exists()
    total = sum(w['bytes'] for w in wheels)
    assert (total, total, False) in seen and seen[-1][2] is True


def test_interrupted_download_resumes_from_the_partial_file(tmp_path, wheels, server):
    component = Component(tmp_path / 'gpu')
    component.downloads.mkdir(parents=True)
    half = wheels[0]['bytes'] // 2
    (component.downloads / 'w0.whl.part').write_bytes(server['files']['/w0.whl'][:half])
    seen = []
    component.install(lambda done, total, message, final=False: seen.append(done))
    assert server['ranges'][0] == f'bytes={half}-'
    assert seen[0] > half  # the bar starts where the last attempt stopped
    assert component.installed()


def test_server_ignoring_range_restarts_the_file(tmp_path, wheels, server):
    server['ignore_range'] = True
    component = Component(tmp_path / 'gpu')
    component.downloads.mkdir(parents=True)
    (component.downloads / 'w0.whl.part').write_bytes(server['files']['/w0.whl'][:wheels[0]['bytes'] // 2])
    component.install(quiet)
    assert component.installed()


def test_dropped_connection_keeps_the_partial_file_and_resumes(tmp_path, wheels, server):
    half = wheels[0]['bytes'] // 2
    server['truncate'] = half  # the server closes the connection after half of the first archive
    component = Component(tmp_path / 'gpu')
    with pytest.raises(ValueError, match='продолжится с того же места'):
        component.install(quiet)
    part = component.downloads / 'w0.whl.part'
    assert part.stat().st_size == half
    server['truncate'], requests = None, len(server['ranges'])
    component.install(quiet)
    assert server['ranges'][requests] == f'bytes={half}-'
    assert component.installed()


def test_resume_answered_with_a_short_page_keeps_the_partial_file(tmp_path, wheels, server):
    server['portal'] = True
    component = Component(tmp_path / 'gpu')
    component.downloads.mkdir(parents=True)
    part = component.downloads / 'w0.whl.part'
    original = server['files']['/w0.whl'][:wheels[0]['bytes'] // 2]
    part.write_bytes(original)
    with pytest.raises(ValueError, match='продолжится с того же места'):
        component.install(quiet)
    assert part.read_bytes() == original


def test_corrupted_download_is_deleted_and_nothing_is_installed(tmp_path, wheels, server):
    server['files']['/w1.whl'] = server['files']['/w1.whl'][:-1] + b'X'
    component = Component(tmp_path / 'gpu')
    with pytest.raises(ValueError, match='не прошли проверку'):
        component.install(quiet)
    assert not component.installed()
    assert not (component.downloads / 'w1.whl.part').exists()
    assert (component.downloads / 'w0.whl').exists()  # the verified archive is kept for the next try


def test_oversized_partial_file_is_discarded(tmp_path, wheels):
    component = Component(tmp_path / 'gpu')
    component.downloads.mkdir(parents=True)
    (component.downloads / 'w0.whl.part').write_bytes(b'x' * (wheels[0]['bytes'] + 10))
    component.install(quiet)
    assert component.installed()


def test_failure_while_unpacking_leaves_no_installed_component(tmp_path, wheels, monkeypatch, server):
    component, original = Component(tmp_path / 'gpu'), gpu_runtime.zipfile.ZipFile

    def killed(*args, **kwargs):
        raise OSError('killed')
    monkeypatch.setattr(gpu_runtime.zipfile, 'ZipFile', killed)
    with pytest.raises(OSError):
        component.install(quiet)
    assert not component.installed()
    monkeypatch.setattr(gpu_runtime.zipfile, 'ZipFile', original)
    requests = len(server['ranges'])
    component.install(quiet)
    assert component.installed()
    assert len(server['ranges']) == requests  # verified archives are not downloaded again


def test_installed_needs_matching_marker_and_every_dll(tmp_path, wheels):
    component = Component(tmp_path / 'gpu')
    component.install(quiet)
    (component.runtime / 'b.dll').write_bytes(b'short')
    assert not component.installed()
    component.install(quiet)
    assert component.installed()
    component.marker.write_text(json.dumps({'component': 'other', 'wheels': []}), 'utf-8')
    assert not component.installed()


def test_not_enough_disk_space_is_reported_before_downloading(tmp_path, wheels, server, monkeypatch):
    monkeypatch.setattr(gpu_runtime.shutil, 'disk_usage', lambda path: type('Usage', (), {'free': 100})())
    with pytest.raises(ValueError, match='Не хватает места на диске'):
        Component(tmp_path / 'gpu').install(quiet)
    assert server['ranges'] == []


def test_network_failure_says_the_download_will_continue(tmp_path, wheels):
    wheels[0]['url'] = 'http://127.0.0.1:9/none.whl'
    with pytest.raises(ValueError, match='продолжится с того же места'):
        Component(tmp_path / 'gpu').install(quiet)


def test_best_device_prefers_more_memory():
    devices = [{'name': 'MX', 'memoryMb': 2048, 'driver': '1'}, {'name': 'RTX', 'memoryMb': 8151, 'driver': '1'}]
    assert gpu_runtime.best_device(devices)['name'] == 'RTX'
    assert gpu_runtime.best_device([]) is None


def test_no_nvidia_driver_means_no_devices(monkeypatch):
    def missing(path):
        raise OSError('no driver')
    monkeypatch.setattr(gpu_runtime, 'supported', lambda: True)
    monkeypatch.setattr(gpu_runtime.C, 'WinDLL', missing, raising=False)
    assert gpu_runtime.nvidia_devices() == []


def test_nominal_4_gb_card_has_enough_memory():
    # NVML reports a nominal 4 GB card a little under 4096 MiB; the minimum must still accept it.
    assert gpu_runtime.enough_memory({'memoryMb': 3584}) and gpu_runtime.enough_memory({'memoryMb': 4095})
    assert not gpu_runtime.enough_memory({'memoryMb': 3583}) and not gpu_runtime.enough_memory(None)


def test_real_wheels_are_pinned():
    assert [w['file'] for w in gpu_runtime.WHEELS] == ['nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl',
                                                       'nvidia_cudnn_cu12-9.10.2.21-py3-none-win_amd64.whl']
    assert all(len(w['sha256']) == 64 and w['url'].startswith('https://files.pythonhosted.org/')
               for w in gpu_runtime.WHEELS)


def test_nvml_failure_after_init_means_no_devices_and_status_still_works(tmp_path, monkeypatch):
    class BrokenNvml:
        def nvmlInit_v2(self):
            return 0

        def nvmlDeviceGetCount_v2(self, count):
            raise OSError('exception: access violation reading 0x0000000000000000')

        def nvmlShutdown(self):
            raise OSError('exception: access violation')
    monkeypatch.setattr(gpu_runtime, 'supported', lambda: True)
    monkeypatch.setattr(gpu_runtime.C, 'WinDLL', lambda path: BrokenNvml(), raising=False)
    assert gpu_runtime.nvidia_devices() == []
    from engine import Engine
    assert Engine(tmp_path).status()['gpu']['device'] is None


def test_engine_start_removes_archives_left_after_a_finished_install(tmp_path, wheels):
    component = Component(tmp_path / 'gpu')
    component.install(quiet)
    component.downloads.mkdir()
    (component.downloads / 'w0.whl').write_bytes(b'left after the install')
    from engine import Engine
    Engine(tmp_path)
    assert not component.downloads.exists()
    assert component.installed()


def test_partial_download_survives_engine_start_until_the_next_attempt(tmp_path, wheels):
    component = Component(tmp_path / 'gpu')
    component.downloads.mkdir(parents=True)
    part = component.downloads / 'w0.whl.part'
    part.write_bytes(b'half')
    from engine import Engine
    Engine(tmp_path)
    assert part.read_bytes() == b'half'


def test_status_reports_the_installed_size_of_the_pinned_dlls():
    assert sum(sum(w['dlls'].values()) for w in gpu_runtime.WHEELS) == 1795594032
    assert gpu_runtime.INSTALLED_SIZE == '1,8 ГБ'
