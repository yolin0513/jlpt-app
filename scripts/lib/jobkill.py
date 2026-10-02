"""用 Windows Job Object 管住「這一次開出來的所有子孫」（2026-10-02）。

為什麼不從根往下找子孫：Git Bash 開程序是先 fork 出一個中間的 bash、再換成目標程式；中間那一支結束後，目標程式記著的
父 PID 指向一個不存在的程序，從根往下找的程序樹看不到它（TripQuest 同一天撞到；JLPT 在執行程式的逾時測試撞到：
kill_tree 殺完，兩個 sleep 還活著）。Job Object 是 Windows 自己記的：放進 job 的程序之後開的所有子孫都自動屬於它，
不管父 PID 接不接得上；結束 job 只會結束 job 裡的程序（不會因為 PID 重用殺到別的程序）。
建 job 時設 KILL_ON_JOB_CLOSE：連開它的程式自己被強制結束，job 關閉、裡面的程序也一起收掉。
"""
import ctypes
import os
import time
from ctypes import wintypes

if os.name == 'nt':
    _k32 = ctypes.WinDLL('kernel32', use_last_error=True)

    class _IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                                                      'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

    class _BASIC_LIMIT(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                    ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]

    class _EXT_LIMIT(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', _BASIC_LIMIT), ('IoInfo', _IO), ('ProcessMemoryLimit', ctypes.c_size_t),
                    ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t),
                    ('PeakJobMemoryUsed', ctypes.c_size_t)]

    class _ACCOUNTING(ctypes.Structure):
        _fields_ = [('TotalUserTime', ctypes.c_longlong), ('TotalKernelTime', ctypes.c_longlong),
                    ('ThisPeriodTotalUserTime', ctypes.c_longlong), ('ThisPeriodTotalKernelTime', ctypes.c_longlong),
                    ('TotalPageFaultCount', wintypes.DWORD), ('TotalProcesses', wintypes.DWORD),
                    ('ActiveProcesses', wintypes.DWORD), ('TotalTerminatedProcesses', wintypes.DWORD)]

    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _k32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000


class Job:
    """with Job() as job: p = Popen(...); job.add(p); …; job.kill() → 回傳殺完還活著的程序數（應該是 0）。"""

    def __init__(self):
        if os.name != 'nt':
            raise OSError('Job Object 只有 Windows 有')
        self.h = _k32.CreateJobObjectW(None, None)
        if not self.h:
            raise OSError(f'CreateJobObject 失敗（{ctypes.get_last_error()}）')
        info = _EXT_LIMIT()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not _k32.SetInformationJobObject(self.h, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(f'SetInformationJobObject 失敗（{ctypes.get_last_error()}）')

    def add(self, popen):
        if not _k32.AssignProcessToJobObject(self.h, int(popen._handle)):
            raise OSError(f'AssignProcessToJobObject 失敗（{ctypes.get_last_error()}）')

    def counts(self):
        """回傳 (job 裡現在還活著的程序數, 這個 job 開過的程序總數)。"""
        acc = _ACCOUNTING()
        if not _k32.QueryInformationJobObject(self.h, 1, ctypes.byref(acc), ctypes.sizeof(acc), None):
            raise OSError(f'QueryInformationJobObject 失敗（{ctypes.get_last_error()}）')
        return acc.ActiveProcesses, acc.TotalProcesses

    def kill(self, code=124, wait=10):
        """結束 job 裡的所有程序；等到活著的是 0 或超過 wait 秒。回傳殺完還活著的程序數。"""
        _k32.TerminateJobObject(self.h, code)
        t0 = time.time()
        while time.time() - t0 < wait:
            if self.counts()[0] == 0:
                return 0
            time.sleep(0.2)
        return self.counts()[0]

    def close(self):
        if self.h:
            _k32.CloseHandle(self.h)
            self.h = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
