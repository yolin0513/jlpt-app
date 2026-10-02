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


# ---- 逐一計數（Dispatch 2026-10-02：取樣會系統性漏掉短命的程序——TripQuest 同一次逐一計數峰值 4、取樣只有 1）----
# 沒有管理員權限拿不到 ETW 的程序事件，改用 WMI 的建立／結束事件、WITHIN 0.1 輪詢（TripQuest 同樣做法）：
# 活不到 0.1 秒的程序仍可能漏——這句寫進輸出，不只寫在文件。
WATCH_PS = (
    "$ErrorActionPreference='Stop';"
    "Register-CimIndicationEvent -Query \"SELECT * FROM __InstanceCreationEvent WITHIN 0.1 WHERE TargetInstance ISA 'Win32_Process'\" -SourceIdentifier jc | Out-Null;"
    "Register-CimIndicationEvent -Query \"SELECT * FROM __InstanceDeletionEvent WITHIN 0.1 WHERE TargetInstance ISA 'Win32_Process'\" -SourceIdentifier jd | Out-Null;"
    "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush();"
    "while ($true) { $e = Wait-Event -Timeout 1; if ($e) { $t = $e.SourceEventArgs.NewEvent.TargetInstance;"
    " if ($e.SourceIdentifier -eq 'jc') { $ct = 0; if ($t.CreationDate) { $ct = $t.CreationDate.ToFileTimeUtc() };"
    " [Console]::Out.WriteLine(\"C`t$($t.ProcessId)`t$($t.ParentProcessId)`t$($t.Name)`t$ct\") }"
    " else { [Console]::Out.WriteLine(\"D`t$($t.ProcessId)\") };"
    " [Console]::Out.Flush(); Remove-Event -EventIdentifier $e.EventIdentifier } }")
EVENT_NOTE = '逐一計數用 WMI 建立／結束事件、每 0.1 秒輪詢（沒有管理員權限，拿不到 ETW）：活不到 0.1 秒的程序仍可能漏'


class EventCounter:
    """吃 C／D 事件，逐一加減「這一棵樹」的程序與工作程序，記峰值。父程序還沒進樹的建立事件先暫存，等父程序進來再補算
    （WMI 同一批事件的順序不保證：孫的建立事件可能比子的先到）。子程序要比父程序晚建立才算（PID 重用）。"""

    def __init__(self, root, root_ct=0):
        self.root = root
        self.ct = {root: root_ct}
        self.names = {root: ''}
        self.parent = {root: 0}
        self.alive = {root}
        self.pending = {}   # ppid → [(pid, name, ct)]
        self.peak_n = self.peak_w = 0

    def _workers(self):
        procs = {p: (self.parent.get(p, 0), 0, self.names.get(p, ''), self.ct.get(p, 0)) for p in self.alive}
        for p in self.alive:   # 父程序已經結束的，也要讓 count_workers 看得到它的名字（判斷瀏覽器的父程序）
            pp = self.parent.get(p, 0)
            if pp and pp not in procs and pp in self.names:
                procs[pp] = (0, 0, self.names[pp], self.ct.get(pp, 0))
        return count_workers(procs, self.alive)

    def _add(self, pid, ppid, name, ct):
        self.ct[pid], self.names[pid], self.parent[pid] = ct, name, ppid
        self.alive.add(pid)
        for c in self.pending.pop(pid, []):
            if not (ct and c[2] and c[2] < ct):
                self._add(c[0], pid, c[1], c[2])

    def feed(self, line):
        f = line.rstrip('\r\n').split('\t')
        if f[0] == 'C' and len(f) == 5 and f[1].isdigit() and f[2].isdigit():
            pid, ppid, name, ct = int(f[1]), int(f[2]), f[3], int(f[4] or 0)
            if pid == self.root:
                if ct:
                    self.ct[pid] = ct
                self.names[pid] = name
            elif ppid in self.ct:
                pc = self.ct.get(ppid, 0)
                if not (pc and ct and ct < pc):
                    self._add(pid, ppid, name, ct)
            else:
                self.pending.setdefault(ppid, []).append((pid, name, ct))
        elif f[0] == 'D' and len(f) == 2 and f[1].isdigit():
            pid = int(f[1])
            self.alive.discard(pid)
            for k in list(self.pending):
                self.pending[k] = [c for c in self.pending[k] if c[0] != pid]
        self.peak_n = max(self.peak_n, len(self.alive))
        self.peak_w = max(self.peak_w, self._workers())


def start_watcher():
    """回傳 (watcher Popen, 事件佇列) 或 (None, 原因)。READY 之前不開被包住的指令。"""
    import queue
    import threading
    if os.name != 'nt':
        return None, '不是 Windows，沒有 WMI 事件'
    try:
        w = subprocess.Popen(['powershell', '-NoProfile', '-NonInteractive', '-Command', WATCH_PS],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError as e:
        return None, f'PowerShell 叫不起來（{e}）'
    q = queue.Queue()

    def pump():
        for raw in w.stdout:
            q.put(raw.decode('utf-8', 'replace'))
        q.put(None)
    threading.Thread(target=pump, daemon=True).start()
    try:
        first = q.get(timeout=30)
    except Exception:
        first = None
    if not first or first.strip() != 'READY':
        w.kill()
        return None, f'WMI 事件監看沒有就緒（{(first or "沒有輸出").strip()[:60]}）'
    return w, q


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
    watcher, wq = start_watcher()   # 先就緒再開被包住的指令，不然一開始的程序會漏
    t0 = time.time()
    child = subprocess.Popen(cmd)
    ev = None
    if watcher is not None:
        sn = snapshot()
        ev = EventCounter(child.pid, ctime(sn[0], child.pid) if sn else 0)
        if sn:   # 監看就緒到開跑之間已經開出來的子程序（很少見）照程序表補進來
            for p in sorted(tree(sn[0], child.pid) - {child.pid}):
                ev.feed(f'C\t{p}\t{sn[0][p][0]}\t{sn[0][p][2]}\t{ctime(sn[0], p)}')
    ev_why = None if watcher is not None else wq

    def drain():
        if ev is None:
            return
        while True:
            try:
                x = wq.get_nowait()
            except Exception:
                return
            if x is None:
                return
            ev.feed(x)
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
        for _i in range(int(a.sample * 10)):   # 0.1 秒一次把事件吃進來，取樣照舊每 --sample 秒一次
            time.sleep(0.1)
            drain()
            if child.poll() is not None:
                break
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
    if ev is not None:
        time.sleep(0.5)   # 讓最後一批結束事件進來
        drain()
        watcher.kill()
    end = measure(child.pid)
    if end is None:
        fails += 1
    line(f'結束 rc={rc}', end)
    el = time.time() - t0
    fh.close()
    low = '?' if min_free is None else f'{min_free / MB:.0f}'
    ev_w, ev_n = (str(ev.peak_w), str(ev.peak_n)) if ev is not None else ('?', '?')
    idx = os.path.join(a.logdir, 'reslog-index.tsv')
    new = not os.path.exists(idx)
    with open(idx, 'a', encoding='utf-8') as ih:
        if new:
            ih.write('日期時間\tlabel\t預估秒\t實際秒\t峰值程序數\t峰值記憶體MB\t回傳值\t取樣失敗\t峰值工作程序數\t最低可用記憶體MB'
                     '\t逐一計數峰值工作程序數\t逐一計數峰值程序數\n')
        ih.write(f'{datetime.datetime.now().isoformat(timespec="seconds")}\t{a.label}\t{a.estimate}\t{el:.0f}\t'
                 f'{peak_n}\t{peak_m / MB:.0f}\t{rc}\t{fails}\t{peak_w}\t{low}\t{ev_w}\t{ev_n}\n')
    warn = f'；取樣失敗 {fails} 次（峰值可能偏低）' if fails else ''
    print(f'RESLOG: {a.label} 預估 {a.estimate} 秒、實際 {el:.0f} 秒；逐一計數峰值 {ev_w} 個工作程序（全部 {ev_n} 個程序）、'
          f'取樣峰值 {peak_w} 個工作程序（全部 {peak_n} 個）、{peak_m / MB:.0f} MB；系統可用記憶體最低 {low} MB；rc={rc}{warn}')
    if ev is not None:
        print(f'RESLOG LIMIT: {EVENT_NOTE}；取樣每 {a.sample:g} 秒一次，兩種峰值的差距就是取樣漏掉的量')
    else:
        print(f'RESLOG LIMIT: 逐一計數沒有啟動（{ev_why}），只有取樣峰值——取樣每 {a.sample:g} 秒一次，短命的程序會漏，峰值偏低')
    return rc


if __name__ == '__main__':
    # 只在直接執行時重包輸出：被別支 import 時重包會把對方的輸出關掉
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.exit(main())
