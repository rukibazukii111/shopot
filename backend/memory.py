"""Process and system memory through the OS, without extra packages.

Used for the per-dictation memory peak in history and to free RAM when the machine runs short.
Every function returns None where the platform gives no answer; callers treat that as unknown.
Nothing here may break the engine: a failed OS call means "unknown", never an exception.
"""
import ctypes
import os
import sys
import threading

# 8 GB machines report a little under or over 8 GiB; anything below this counts as small.
LOW_MEMORY_BYTES = 9 * 1000 ** 3

_memory_status = _process_memory = _sysctl_number = None

if sys.platform == "win32":
    try:
        from ctypes import wintypes

        class _MemoryStatus(ctypes.Structure):
            _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD),
                        ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                        ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                        ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                        ("ullAvailExtendedVirtual", ctypes.c_uint64)]

        class _ProcessCounters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
                        ("PrivateUsage", ctypes.c_size_t)]

        _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        _kernel32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessCounters),
                                                      wintypes.DWORD]
        _kernel32.K32GetProcessMemoryInfo.restype = wintypes.BOOL
        _kernel32.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(_MemoryStatus)]
        _kernel32.GlobalMemoryStatusEx.restype = wintypes.BOOL

        def _memory_status():
            status = _MemoryStatus(dwLength=ctypes.sizeof(_MemoryStatus))
            return status if _kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None

        def _process_memory():
            counters = _ProcessCounters(cb=ctypes.sizeof(_ProcessCounters))
            if not _kernel32.K32GetProcessMemoryInfo(_kernel32.GetCurrentProcess(), ctypes.byref(counters),
                                                     counters.cb):
                return None
            # The working set is what this process holds in RAM right now.
            return counters.WorkingSetSize
    except (AttributeError, OSError):
        _memory_status = _process_memory = None

elif sys.platform == "darwin":
    try:
        class _RusageInfo(ctypes.Structure):
            # struct rusage_info_v0 from <sys/resource.h>
            _fields_ = [("uuid", ctypes.c_uint8 * 16), ("user_time", ctypes.c_uint64),
                        ("system_time", ctypes.c_uint64), ("pkg_idle_wkups", ctypes.c_uint64),
                        ("interrupt_wkups", ctypes.c_uint64), ("pageins", ctypes.c_uint64),
                        ("wired_size", ctypes.c_uint64), ("resident_size", ctypes.c_uint64),
                        ("phys_footprint", ctypes.c_uint64), ("proc_start_abstime", ctypes.c_uint64),
                        ("proc_exit_abstime", ctypes.c_uint64)]

        _system = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        _system.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        _system.proc_pid_rusage.restype = ctypes.c_int
        _system.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                                         ctypes.c_void_p, ctypes.c_size_t]
        _system.sysctlbyname.restype = ctypes.c_int

        def _sysctl_number(name):
            value = ctypes.c_uint64(0)  # zeroed: 32-bit answers fill the low half (Macs are little-endian)
            size = ctypes.c_size_t(ctypes.sizeof(value))
            if _system.sysctlbyname(name.encode(), ctypes.byref(value), ctypes.byref(size), None, 0) != 0:
                return None
            return value.value

        def _process_memory():
            info = _RusageInfo()
            if _system.proc_pid_rusage(os.getpid(), 0, ctypes.byref(info)) != 0:  # 0: RUSAGE_INFO_V0
                return None
            # The footprint is the "Memory" column of Activity Monitor: private memory, including compressed.
            return info.phys_footprint
    except (AttributeError, OSError):
        _process_memory = _sysctl_number = None


def total_memory():
    """Physical RAM in bytes."""
    try:
        if _memory_status:
            status = _memory_status()
            return status.ullTotalPhys if status else None
        if _sysctl_number:
            return _sysctl_number("hw.memsize")
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (AttributeError, OSError, ValueError):
        return None


def is_low_memory(total=None):
    total = total_memory() if total is None else total
    return bool(total) and total < LOW_MEMORY_BYTES


def process_memory():
    """RAM held by this process in bytes: the working set on Windows, the physical footprint on macOS."""
    try:
        return _process_memory() if _process_memory else None
    except (AttributeError, OSError, ValueError):
        return None


def memory_pressure():
    """'normal', 'warn' or 'critical' for the whole machine."""
    try:
        if _sysctl_number:
            # 1 normal, 2 warning, 4 critical: the level behind Activity Monitor's memory pressure graph.
            return {1: "normal", 2: "warn", 4: "critical"}.get(_sysctl_number("kern.memorystatus_vm_pressure_level"))
        if _memory_status:
            status = _memory_status()
            if not status or not status.ullTotalPhys:
                return None
            # Available memory includes the standby cache that Windows gives back on demand.
            free = status.ullAvailPhys / status.ullTotalPhys
            return "critical" if free < 0.10 else "warn" if free < 0.20 else "normal"
    except (AttributeError, OSError, ValueError):
        pass
    return None


class PeakSampler:
    """Highest process_memory() seen while the block runs, sampled on a background thread."""

    def __init__(self, interval=0.05):
        self.interval = interval
        self.peak = 0
        self._stop = threading.Event()
        self._thread = None

    def sample(self):
        value = process_memory()
        if value:
            self.peak = max(self.peak, value)

    def _run(self):
        while not self._stop.wait(self.interval):
            self.sample()

    def __enter__(self):
        self.sample()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        self._thread.join()
        self.sample()
        return False
