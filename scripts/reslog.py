"""資源紀錄（共用慣例 v11.3 §5.19、工單 3c）：包住一個指令，記它這一棵程序樹（本 repo 的工作程序）的數量與記憶體。

用法：python scripts/reslog.py --label 名稱 --estimate 秒數或unknown [--interval 60] [--sample 5] -- 指令 參數…
回傳值：被包住的指令自己的回傳值；reslog 本身出錯（取不到程序表等）時，另在紀錄與標準輸出寫明，不把「取不到」寫成 0。

- 量的是「這次開出來的那一棵程序樹」：被包住的指令本身＋它所有的後代（不含 reslog 自己、也不含取樣用的 PowerShell）。
  不寫「全機」——全機的工作程序由 Dispatch 管。
- 每 --sample 秒取樣一次（峰值用），每 --interval 秒寫一行到 .logs/reslog-<日期>-<label>.tsv：
  時間、經過秒數、程序數、這棵樹合計的記憶體（工作集，MB）、系統可用記憶體（MB）。開始與結束各一行。
- 結束時寫一行摘要到 .logs/reslog-index.tsv（進 .gitignore 的目錄）：日期、label、預估、實際秒數、峰值程序數、峰值記憶體、回傳值、取樣失敗次數。
  預估與實際寫在同一行（§5.19：預估要被回頭檢查）。
- 取樣失敗（PowerShell 叫不起來、輸出解析不了）記成「?」並計數，摘要裡寫出來；不當成 0 個程序（§5.13）。
- Windows 用 PowerShell 的 Win32_Process（ProcessId、ParentProcessId、WorkingSetSize）；其他系統用 ps。
"""
import argparse
import datetime
import io
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGDIR = os.path.join(ROOT, '.logs')

PS_CMD = ('$p = Get-CimInstance Win32_Process | ForEach-Object { "P`t$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$($_.Name)`t$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }; '
          '$p; "M`t$((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory)"')


def snapshot():
    """回傳 ({pid: (ppid, 記憶體位元組, 程序名稱, 建立時間)}, 系統可用記憶體位元組)；取不到回傳 None。
    建立時間：Windows 是 FILETIME（100 奈秒）、其他系統是秒；取不到記 0（認子程序時當成「不知道」）。"""
    try:
        if os.name == 'nt':
            r = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_CMD],
                               capture_output=True, timeout=60)
            if r.returncode != 0:
                return None
            procs, free = {}, None
            for line in r.stdout.decode('utf-8', 'replace').splitlines():
                f = line.strip().split('\t')
                if f[0] == 'P' and len(f) == 6:
                    procs[int(f[1])] = (int(f[2]), int(f[3] or 0), f[4], int(f[5] or 0))
                elif f[0] == 'M' and len(f) == 2:
                    free = int(f[1]) * 1024
            if not procs or free is None:
                return None
            return procs, free
        r = subprocess.run(['ps', '-eo', 'pid=,ppid=,rss=,etimes=,comm='], capture_output=True, timeout=60)
        now = time.time()
        if r.returncode != 0:
            return None
        procs = {}
        for line in r.stdout.decode().splitlines():
            a = line.split()
            if len(a) >= 5:
                procs[int(a[0])] = (int(a[1]), int(a[2]) * 1024, a[4], int(now - int(a[3])))
        free = None
        with open('/proc/meminfo') as fh:
            for line in fh:
                if line.startswith('MemAvailable:'):
                    free = int(line.split()[1]) * 1024
        return (procs, free) if procs and free is not None else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def ctime(procs, pid):
    v = procs.get(pid)
    return v[3] if v is not None and len(v) > 3 else 0


def tree(procs, root):
    """root 與它所有後代的 pid。root 已經不在時，仍會找出 ppid 指向它的孤兒（Windows 不會改掉孤兒的 ppid）。
    子程序必須比父程序晚建立才算（2026-10-02 實測踩到：Windows 會重用 PID，一個 04:57 開的 OneDrive 記著的父 PID
    剛好等於這次開跑的 bash，就被當成它的子程序；兩邊建立時間都知道、子比父早，就不是它的子程序）。"""
    kids = {}
    for pid, (ppid, *_rest) in procs.items():
        pc, cc = ctime(procs, ppid), ctime(procs, pid)
        if pc and cc and cc < pc:
            continue
        kids.setdefault(ppid, []).append(pid)
    out, stack = set(), [root]
    while stack:
        p = stack.pop()
        for c in kids.get(p, []):
            if c not in out and c != p:
                out.add(c)
                stack.append(c)
    if root in procs:
        out.add(root)
    return out


# ---- 工作程序怎麼數（照 MealMate scripts/reslog.mjs，四個 App 的數字才比得起來）----
# node／python 各算一個；瀏覽器實例算一個（瀏覽器程序的父程序不是瀏覽器才算，它的子程序不另算個數、記憶體照算）；
# git、shell、PowerShell 之類不算個數、記憶體照算。總程序數另外記一欄。
WORKERS = ('python', 'pythonw', 'node')
BROWSERS = ('chrome', 'chromium', 'msedge', 'headless_shell', 'chrome-headless-shell')


def base_name(n):
    n = (n or '').lower()
    return n[:-4] if n.endswith('.exe') else n


def is_python(n):
    return n in WORKERS or n.startswith('python3')


def count_workers(procs, pids):
    """pids 這一群裡有幾個工作程序。procs：{pid: (ppid, 記憶體, 名稱)}。"""
    n = 0
    for p in pids:
        name = base_name(procs[p][2])
        if is_python(name):
            n += 1
        elif name in BROWSERS:
            parent = procs.get(procs[p][0])
            if not (parent and base_name(parent[2]) in BROWSERS):
                n += 1
    return n


def measure(root):
    """回傳 (程序數, 這棵樹的記憶體, 系統可用記憶體, 這棵樹的 pid 集合, 工作程序數)；取不到回傳 None。"""
    s = snapshot()
    if s is None:
        return None
    procs, free = s
    t = tree(procs, root)
    return len(t), sum(procs[p][1] for p in t), free, t, count_workers(procs, t)


def resolve_cmd(cmd):
    """把裸的指令名稱照 PATH 解成完整路徑（2026-10-02 實際撞到：Windows 開子程序時先找 System32、才找 PATH，
    裸寫的 bash 會變成系統目錄 System32 底下的 bash.exe（WSL），被包住的驗法根本沒跑，回傳 1、峰值 0 個程序）。
    回傳 (解好的指令, 錯誤訊息或 None)：解出來是 System32 的 bash.exe 就拒絕。"""
    import shutil
    first = cmd[0]
    if not os.path.isabs(first) and os.sep not in first and '/' not in first:
        w = shutil.which(first)
        if w:
            first = w
    if os.name == 'nt' and os.path.basename(first).lower() == 'bash.exe' and 'system32' in first.lower():
        return cmd, f'解出來的 bash 是 {first}（WSL，不是 Git 的 bash）——不跑'
    return [first] + list(cmd[1:]), None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--label', required=True)
    ap.add_argument('--estimate', required=True, help='預估秒數，或 unknown（沒量過、預測不出）')
    ap.add_argument('--interval', type=float, default=60)
    ap.add_argument('--sample', type=float, default=5)
    ap.add_argument('--logdir', default=LOGDIR)
    ap.add_argument('cmd', nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    cmd = a.cmd[1:] if a.cmd[:1] == ['--'] else a.cmd
    if not cmd:
        print('RESLOG ABORT: 沒有要包住的指令')
        return 2
    cmd, why = resolve_cmd(cmd)
    if why:
        print(f'RESLOG ABORT: {why}')
        return 2
    os.makedirs(a.logdir, exist_ok=True)
    day = datetime.date.today().isoformat()
    path = os.path.join(a.logdir, f'reslog-{day}-{a.label}.tsv')
    fh = open(path, 'a', encoding='utf-8')
    fh.write('# ' + ' '.join(cmd) + f'\t預估 {a.estimate}\n')
    fh.write('時間\t經過秒數\t程序數\t工作程序數\t樹的記憶體MB\t系統可用MB\t備註\n')
    MB = 1024 * 1024
    t0 = time.time()
    child = subprocess.Popen(cmd)
    peak_n, peak_w, peak_m, fails, last_line = 0, 0, 0, 0, -1e9
    min_free = None   # 系統可用記憶體的最低值（每次取樣都更新，不只寫進紀錄的那幾行）

    def line(note, m):
        now = datetime.datetime.now().strftime('%H:%M:%S')
        el = f'{time.time() - t0:.0f}'
        if m is None:
            fh.write(f'{now}\t{el}\t?\t?\t?\t?\t{note}（取樣失敗）\n')
        else:
            fh.write(f'{now}\t{el}\t{m[0]}\t{m[4]}\t{m[1] / MB:.0f}\t{m[2] / MB:.0f}\t{note}\n')
        fh.flush()

    first = measure(child.pid)
    if first is None:
        fails += 1
    else:
        peak_n, peak_w, peak_m = max(peak_n, first[0]), max(peak_w, first[4]), max(peak_m, first[1])
        min_free = first[2]
    line('開始', first)
    last_line = time.time()
    while child.poll() is None:
        time.sleep(a.sample)
        if child.poll() is not None:
            break
        m = measure(child.pid)
        if m is None:
            fails += 1
        else:
            peak_n, peak_w, peak_m = max(peak_n, m[0]), max(peak_w, m[4]), max(peak_m, m[1])
            min_free = m[2] if min_free is None else min(min_free, m[2])
        if time.time() - last_line >= a.interval:
            line('', m)
            last_line = time.time()
    rc = child.returncode
    end = measure(child.pid)
    if end is None:
        fails += 1
    line(f'結束 rc={rc}', end)
    el = time.time() - t0
    fh.close()
    low = '?' if min_free is None else f'{min_free / MB:.0f}'
    idx = os.path.join(a.logdir, 'reslog-index.tsv')
    new = not os.path.exists(idx)
    with open(idx, 'a', encoding='utf-8') as ih:
        if new:
            ih.write('日期時間\tlabel\t預估秒\t實際秒\t峰值程序數\t峰值記憶體MB\t回傳值\t取樣失敗\t峰值工作程序數\t最低可用記憶體MB\n')
        ih.write(f'{datetime.datetime.now().isoformat(timespec="seconds")}\t{a.label}\t{a.estimate}\t{el:.0f}\t'
                 f'{peak_n}\t{peak_m / MB:.0f}\t{rc}\t{fails}\t{peak_w}\t{low}\n')
    warn = f'；取樣失敗 {fails} 次（峰值可能偏低）' if fails else ''
    print(f'RESLOG: {a.label} 預估 {a.estimate} 秒、實際 {el:.0f} 秒；峰值 {peak_w} 個工作程序（全部 {peak_n} 個程序）、{peak_m / MB:.0f} MB；系統可用記憶體最低 {low} MB；rc={rc}{warn}')
    return rc


if __name__ == '__main__':
    # 只在直接執行時重包輸出：被別支 import 時重包會把對方的輸出關掉
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.exit(main())
