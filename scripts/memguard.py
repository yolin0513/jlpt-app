"""外部記憶體監看（2026-10-08 最小版，Dispatch：系統可用記憶體掉到 1268 MB 時當下沒有任何東西在看）。

  python scripts/memguard.py [--threshold-mb 2048] [--interval 5] [--consecutive 3] [--label 名稱] -- 指令…

把指令放進一個 Windows Job Object（scripts/lib/jobkill.py；之後開的所有子孫都屬於它，Git Bash 父 PID 接不起來也管得到），
每 interval 秒讀一次系統可用記憶體；**連續 consecutive 次**低於門檻，就把記憶體前 10 名寫進 log、結束整個 job、
確認 job 裡剩 0 個，印「MEMGUARD TRIGGERED」並回 7（不硬撐完）。沒觸發就照傳指令的回傳值。
log：.logs/memguard-<日期時間>-<label>.log（每次讀數一行＋觸發時的前 10 名）。

跟 STATUS「③ 外部記憶體監看的規格」的差別（照實寫，不是完整版）：規格要「獨立程序、不碰執行程式、停之前核對名稱／指令列／建立時間」；
這一版是包在外面的那一層，手上直接握著 job 的 handle，所以不需要用名稱去找要停的對象（也就不會停錯）——但它跟被監看的指令同生共死：
它自己被殺掉，KILL_ON_JOB_CLOSE 會把裡面的一起收掉，監看不會留著一個沒人管的工作。
驗法：python scripts/test_memguard.py
"""
import argparse
import ctypes
import io
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'lib'))
import jobkill  # noqa: E402

TRIGGERED_RC = 7


class _MEMSTAT(ctypes.Structure):
    _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong), ('ullTotalPhys', ctypes.c_ulonglong),
                ('ullAvailPhys', ctypes.c_ulonglong), ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong), ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]


def avail_mb():
    """系統可用實體記憶體（MB）；讀不到回 None（不當成 0，也不當成夠）"""
    st = _MEMSTAT()
    st.dwLength = ctypes.sizeof(st)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
        return None
    return st.ullAvailPhys // (1024 * 1024)


def should_stop(readings, threshold, k):
    """最近 k 次讀數都低於門檻才停（讀不到的那一次算「低」：看不見就當成危險，不放過）。純函式。"""
    if len(readings) < k:
        return False
    return all(r is None or r < threshold for r in readings[-k:])


def top10():
    """記憶體前 10 名（tasklist）；取不到就回一行說明，不回空的"""
    try:
        out = subprocess.run(['tasklist', '/fo', 'csv', '/nh'], capture_output=True, timeout=30).stdout.decode('mbcs', 'replace')
    except (OSError, subprocess.TimeoutExpired) as e:
        return [f'（取不到程序表：{e}）']
    rows = []
    for line in out.splitlines():
        f = [x.strip('"') for x in line.split('","')]
        if len(f) >= 5:
            try:
                rows.append((int(''.join(ch for ch in f[4] if ch.isdigit())) // 1024, f[0], f[1]))
            except ValueError:
                continue
    rows.sort(reverse=True)
    return [f'{mb:6d} MB  {name}  pid={pid}' for mb, name, pid in rows[:10]] or ['（程序表是空的）']


def main(argv=None):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    argv = sys.argv[1:] if argv is None else argv
    if '--' not in argv:
        print('MEMGUARD FAILED: 用法：memguard.py [選項] -- 指令…'); return 2
    i = argv.index('--')
    ap = argparse.ArgumentParser()
    ap.add_argument('--threshold-mb', type=float, default=2048)
    ap.add_argument('--interval', type=float, default=5)
    ap.add_argument('--consecutive', type=int, default=3)
    ap.add_argument('--label', default='run')
    a = ap.parse_args(argv[:i])
    cmd = argv[i + 1:]
    os.makedirs(os.path.join(ROOT, '.logs'), exist_ok=True)
    log = os.path.join(ROOT, '.logs', f'memguard-{time.strftime("%Y%m%d-%H%M%S")}-{a.label}.log')
    lf = open(log, 'w', encoding='utf-8')

    def say(s, to_stdout=True):
        lf.write(s + '\n'); lf.flush()
        if to_stdout:
            print(s)
    say(f'MEMGUARD: 門檻 {a.threshold_mb:g} MB、每 {a.interval:g} 秒、連續 {a.consecutive} 次就停；log {os.path.relpath(log, ROOT)}')
    readings = []
    with jobkill.Job() as job:
        p = subprocess.Popen(cmd)
        job.add(p)
        lowest = None
        while True:
            try:
                rc = p.wait(timeout=a.interval)
                say(f'MEMGUARD: 指令結束 rc={rc}；讀了 {len(readings)} 次、最低 {lowest} MB；沒有觸發')
                return rc
            except subprocess.TimeoutExpired:
                pass
            m = avail_mb()
            readings.append(m)
            lowest = m if lowest is None or (m is not None and m < lowest) else lowest
            say(f'{time.strftime("%H:%M:%S")}\t可用 {m if m is not None else "?"} MB', to_stdout=False)
            if should_stop(readings, a.threshold_mb, a.consecutive):
                say(f'MEMGUARD TRIGGERED: 連續 {a.consecutive} 次低於 {a.threshold_mb:g} MB（最近：{readings[-a.consecutive:]}）——停掉整個 job')
                say('記憶體前 10 名：')
                for line in top10():
                    say('  ' + line)
                left = job.kill(TRIGGERED_RC)
                say(f'MEMGUARD: job 裡剩 {left} 個程序（必須是 0）')
                return TRIGGERED_RC if left == 0 else 8


if __name__ == '__main__':
    sys.exit(main())
