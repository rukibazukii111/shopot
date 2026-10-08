"""Optional NVIDIA acceleration for Whisper: find the card through the driver and install NVIDIA's libraries.

ctranslate2 ships the cuDNN loader (cudnn64_9.dll 9.10.2.21) but not cuBLAS or the cuDNN sub-libraries.
They come from NVIDIA's own wheels on PyPI, pinned by version and SHA-256, downloaded only on request.
A partial file is resumed with an HTTP Range request; the ready marker is written last.
"""
import ctypes as C
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import urllib.error
import urllib.request
import zipfile

COMPONENT_ID = "cublas-12.8.4.1-cudnn-9.10.2.21"
# A 4 GB card reports a little under 4096 MiB through NVML.
MIN_MEMORY_MB = 3584
SIZE = "1,3 ГБ"
CHUNK = 1 << 20
WHEELS = [
    {"name": "cuBLAS", "file": "nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl", "bytes": 567544208,
     "url": "https://files.pythonhosted.org/packages/70/61/7d7b3c70186fb651d0fbd35b01dbfc8e755f69fd58f817f3d0f642df20c3/"
            "nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl",
     "sha256": "47e9b82132fa8d2b4944e708049229601448aaad7e6f296f630f2d1a32de35af",
     "dlls": {"nvidia/cublas/bin/cublas64_12.dll": 113716224, "nvidia/cublas/bin/cublasLt64_12.dll": 674667520}},
    # The same version as the cudnn64_9.dll inside ctranslate2: cuDNN refuses mismatched sub-libraries.
    {"name": "cuDNN", "file": "nvidia_cudnn_cu12-9.10.2.21-py3-none-win_amd64.whl", "bytes": 692992268,
     "url": "https://files.pythonhosted.org/packages/3d/90/0bd6e586701b3a890fd38aa71c387dab4883d619d6e5ad912ccbd05bfd67/"
            "nvidia_cudnn_cu12-9.10.2.21-py3-none-win_amd64.whl",
     "sha256": "c6288de7d63e6cf62988f0923f96dc339cea362decb1bf5b3141883392a7d65e",
     "dlls": {f"nvidia/cudnn/bin/{name}.dll": size for name, size in [
         ("cudnn64_9", 266288), ("cudnn_adv64_9", 282445872), ("cudnn_cnn64_9", 4618272),
         ("cudnn_engines_precompiled64_9", 513926688), ("cudnn_engines_runtime_compiled64_9", 20201008),
         ("cudnn_graph64_9", 2420256), ("cudnn_heuristic64_9", 56823328), ("cudnn_ops64_9", 126508576)]}},
]
BROKEN = "Библиотеки NVIDIA не прошли проверку. Попробуй скачать ещё раз."


class _Memory(C.Structure):
    _fields_ = [("total", C.c_ulonglong), ("free", C.c_ulonglong), ("used", C.c_ulonglong)]


def supported():
    return sys.platform == "win32" and platform.machine().lower() in ("amd64", "x86_64")


def nvidia_devices():
    """NVIDIA cards as the driver reports them; empty without the driver. NVML is loaded from System32 only."""
    if not supported():
        return []
    try:
        nvml = C.WinDLL(os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvml.dll"))
        if nvml.nvmlInit_v2() != 0:
            return []
    except (OSError, AttributeError):
        return []
    try:
        count, driver = C.c_uint(), C.create_string_buffer(96)
        if nvml.nvmlDeviceGetCount_v2(C.byref(count)) != 0:
            return []
        nvml.nvmlSystemGetDriverVersion(driver, 96)
        found = []
        for index in range(count.value):
            handle, name, memory = C.c_void_p(), C.create_string_buffer(96), _Memory()
            if (nvml.nvmlDeviceGetHandleByIndex_v2(index, C.byref(handle)) == 0
                    and nvml.nvmlDeviceGetName(handle, name, 96) == 0
                    and nvml.nvmlDeviceGetMemoryInfo(handle, C.byref(memory)) == 0):
                found.append({"name": name.value.decode("utf-8", "replace"), "memoryMb": memory.total // 2**20,
                              "driver": driver.value.decode("utf-8", "replace")})
        return found
    finally:
        nvml.nvmlShutdown()


def best_device(devices):
    return max(devices, key=lambda device: device["memoryMb"], default=None)


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(8 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _gigabytes(size):
    return f"{max(size, 1e8) / 1e9:.1f}".replace(".", ",")


class Component:
    """The installed libraries under <dataDir>/gpu: runtime-<id>/*.dll plus shopot-ready.json."""

    def __init__(self, folder):
        self.folder = Path(folder)
        self.runtime = self.folder / f"runtime-{COMPONENT_ID}"
        self.downloads = self.folder / "downloads"
        self.marker = self.folder / "shopot-ready.json"

    def _ready(self):
        return {"component": COMPONENT_ID, "wheels": [wheel["sha256"] for wheel in WHEELS]}

    def installed(self):
        try:
            return json.loads(self.marker.read_text("utf-8")) == self._ready() and all(
                (self.runtime / Path(name).name).stat().st_size == size
                for wheel in WHEELS for name, size in wheel["dlls"].items())
        except (OSError, ValueError):
            return False

    def _have(self, wheel):
        """Bytes already on disk for this wheel; a verified archive counts in full."""
        target = self.downloads / wheel["file"]
        part = target.with_name(target.name + ".part")
        if target.is_file():
            return wheel["bytes"]
        return min(part.stat().st_size, wheel["bytes"]) if part.is_file() else 0

    def install(self, progress):
        """progress(completed, total, message, final=False); `final` marks a step without a byte count."""
        self.marker.unlink(missing_ok=True)
        self.downloads.mkdir(parents=True, exist_ok=True)
        total = sum(wheel["bytes"] for wheel in WHEELS)
        completed = sum(self._have(wheel) for wheel in WHEELS)
        need = total - completed + sum(sum(wheel["dlls"].values()) for wheel in WHEELS) + (200 << 20)
        free = shutil.disk_usage(self.folder).free
        if free < need:
            raise ValueError(f"Не хватает места на диске: для ускорения нужно ещё {_gigabytes(need - free)} ГБ.")
        try:
            for wheel in WHEELS:
                completed = self._fetch(wheel, completed, total, progress)
            progress(total, total, "Распаковываем библиотеки NVIDIA…", final=True)
            self._unpack()
        except OSError as error:
            if error.errno == errno.ENOSPC:
                raise ValueError("Не хватает места на диске для библиотек NVIDIA.") from error
            raise
        self.marker.write_text(json.dumps(self._ready()), "utf-8")
        shutil.rmtree(self.downloads, ignore_errors=True)

    def _fetch(self, wheel, completed, total, progress):
        target = self.downloads / wheel["file"]
        if target.is_file():
            return completed  # verified before it got this name, and already counted
        part = target.with_name(target.name + ".part")
        done = part.stat().st_size if part.is_file() else 0
        if done > wheel["bytes"]:
            part.unlink()
            completed, done = completed - wheel["bytes"], 0
        if done < wheel["bytes"]:
            try:
                headers = {"Range": f"bytes={done}-"} if done else {}
                with urllib.request.urlopen(urllib.request.Request(wheel["url"], headers=headers), timeout=60) as response:
                    if done and response.status != 206:
                        completed, done = completed - done, 0  # the server sent the whole file: start over
                    with open(part, "ab" if done else "wb") as out:
                        while chunk := response.read(CHUNK):
                            out.write(chunk)
                            done, completed = done + len(chunk), completed + len(chunk)
                            progress(completed, total, "Скачиваем библиотеки NVIDIA…")
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                raise ValueError("Не удалось скачать библиотеки NVIDIA. Проверь интернет и нажми «Скачать» ещё раз — "
                                 "загрузка продолжится с того же места.") from error
        progress(completed, total, "Проверяем библиотеки NVIDIA…", final=True)
        if part.stat().st_size != wheel["bytes"] or file_sha256(part) != wheel["sha256"]:
            part.unlink(missing_ok=True)
            raise ValueError(BROKEN)
        part.replace(target)
        return completed

    def _unpack(self):
        staging = self.folder / "runtime.part"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        for wheel in WHEELS:
            with zipfile.ZipFile(self.downloads / wheel["file"]) as archive:
                for name, size in wheel["dlls"].items():
                    destination = staging / Path(name).name
                    # zipfile checks each entry's CRC while reading it.
                    with archive.open(name) as source, open(destination, "wb") as out:
                        shutil.copyfileobj(source, out, CHUNK)
                    if destination.stat().st_size != size:
                        raise ValueError(BROKEN)
        shutil.rmtree(self.runtime, ignore_errors=True)
        staging.rename(self.runtime)
