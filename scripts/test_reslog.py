"""reslog.py 的驗法（工單 3c；共用慣例 v11.3 §5.20：先證明紀錄真的記得到）。

用法：python scripts/test_reslog.py
回傳值：0＝全部符合；1＝有不符；2＝造情境失敗（沒驗到）。
什麼時候跑：改過 reslog.py 或這支就跑；秒級單支檢查（約 30 秒，單線）。

情境（每一個在暫存目錄裡跑，紀錄寫到暫存目錄，不寫 repo 的 .logs/）：
  A 原樣：假工作（1 個父程序＋2 個子程序，都是 python、各睡 6 秒）跑到一半，紀錄裡那一行的程序數與工作程序數都必須 ≥ 3；
    峰值 ≥ 3；結束那一行是 0（反向：工作結束後不能還算到）；回傳值照傳（假工作回 3 → reslog 回 3）。
  B 突變「取程序數回 0」：A 的對照必須紅。
  C 突變「取樣永遠失敗」：紀錄要寫「?」、摘要要寫取樣失敗次數，不能寫成 0 個程序（§5.13 失敗那一條路要真的走過）。
  D 工作程序的數法（合成的程序表，答案事先寫好）：node、python 各算一個；瀏覽器實例算一個、它的子程序不另算；
    git、shell、PowerShell 不算——一棵「bash→node→chrome(＋3 個 chrome 子程序)、bash→python→git、powershell」的樹必須是 3。
    突變「瀏覽器子程序各算一個」「git 也算」各一，D 必須紅。
假工作最多 3 個程序，加上取樣用的 PowerShell 與 reslog 本身，本 repo 同時不超過 4 個工作程序（§5.19）。
"""
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'scripts', 'reslog.py')

FAKE = '''import subprocess, sys, time
kids = [subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(6)']) for _ in range(2)]
time.sleep(6)
for k in kids:
    k.wait()
sys.exit(3)
'''

# 合成的程序表：{pid: (ppid, 記憶體, 名稱)}；根是 1
SYN = {
    1: (0, 10, 'bash.exe'), 2: (1, 10, 'node.exe'), 3: (2, 10, 'chrome.exe'),
    4: (3, 10, 'chrome.exe'), 5: (3, 10, 'chrome.exe'), 6: (3, 10, 'chrome.exe'),
    7: (1, 10, 'python.exe'), 8: (7, 10, 'git.exe'), 9: (1, 10, 'powershell.exe'),
    50: (0, 10, 'node.exe'),   # 別的樹：不在這一棵裡，不能算到
    60: (1, 10, 'python.exe', 1),   # PID 重用：記著的父 PID 是 1，但比 1 早建立——不是它的子程序，不能算到
}
SYN = {k: (v + (100 + k,)) if len(v) == 3 else v for k, v in SYN.items()}   # 其餘的建立時間都晚於根
SYN_WANT = 3

results = []


def record(ok, label, detail=''):
    results.append(ok)
    print(f'[{"符合" if ok else "不符"}] {label}' + (f'：{detail}' if detail else ''))


def run_reslog(script, td, label):
    fake = os.path.join(td, 'fake_job.py')
    open(fake, 'w', encoding='utf-8').write(FAKE)
    logdir = os.path.join(td, 'logs-' + label)
    r = subprocess.run([sys.executable, script, '--label', label, '--estimate', '10', '--interval', '1', '--sample', '1',
                        '--logdir', logdir, '--', sys.executable, fake], capture_output=True, timeout=180)
    tsv = [os.path.join(logdir, f) for f in os.listdir(logdir) if f.startswith('reslog-2')] if os.path.isdir(logdir) else []
    if len(tsv) != 1 or not os.path.exists(os.path.join(logdir, 'reslog-index.tsv')):
        raise RuntimeError(f'{label}：紀錄檔沒產生（{tsv}）')
    rows = [l.split('\t') for l in open(tsv[0], encoding='utf-8').read().splitlines() if l and not l.startswith(('#', '時間'))]
    idx = open(os.path.join(logdir, 'reslog-index.tsv'), encoding='utf-8').read().splitlines()[-1].split('\t')
    return r.returncode, r.stdout.decode('utf-8', 'replace'), rows, idx


def mutated(td, a, b, name):
    s = open(SRC, encoding='utf-8').read()
    if s.count(a) != 1:
        raise RuntimeError(f'突變錨點不是恰好一處：{a!r}')
    p = os.path.join(td, name)
    open(p, 'w', encoding='utf-8').write(s.replace(a, b, 1))
    if b not in open(p, encoding='utf-8').read():
        raise RuntimeError('突變沒寫進去')
    return p


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# 欄位：時間、經過秒數、程序數、工作程序數、樹的記憶體、系統可用、備註；索引：…、峰值程序數[4]、…、取樣失敗[7]、峰值工作程序數[8]
def judge_a(rc, rows, idx):
    mid = [r for r in rows if r[6] == '']
    mid_ok = any(r[2] != '?' and int(r[2]) >= 3 and int(r[3]) >= 3 for r in mid)
    end_ok = rows[-1][6].startswith('結束') and rows[-1][2] == '0' and rows[-1][3] == '0'
    peak_ok = int(idx[4]) >= 3 and int(idx[8]) >= 3 and idx[9].isdigit() and int(idx[9]) > 0   # 最低可用記憶體要有值
    return rc == 3 and mid_ok and end_ok and peak_ok and idx[7] == '0', \
        (f'rc={rc}、中間各行（程序／工作程序）{[(r[2], r[3]) for r in mid]}、結束那一行 {rows[-1][2]}／{rows[-1][3]}、'
         f'峰值 {idx[4]}／{idx[8]}、取樣失敗 {idx[7]}')


def syn_count(mod):
    t = mod.tree(SYN, 1)
    return mod.count_workers(SYN, t), sorted(t)


def main():
    td = tempfile.mkdtemp(prefix='jlpt-reslog-')
    try:
        rc, out, rows, idx = run_reslog(SRC, td, 'A')
        ok, d = judge_a(rc, rows, idx)
        record(ok, 'A 原樣：跑到一半記得到程序、結束後是 0、回傳值照傳', d)

        p = mutated(td, '    return len(t), sum(procs[p][1] for p in t), free, t, count_workers(procs, t)',
                    '    return 0, sum(procs[p][1] for p in t), free, t, 0', 'reslog_zero.py')
        rc, out, rows, idx = run_reslog(p, td, 'B')
        ok, d = judge_a(rc, rows, idx)
        # 抓到＝改壞的 reslog 完整跑完（回傳值照傳 3、沒有取樣失敗），而且記下的正是「0 個」——不是崩潰或別的原因讓 A 不成立
        zero = rc == 3 and idx[7] == '0' and idx[4] == '0' and idx[8] == '0' and all(r[2] == '0' for r in rows)
        record(not ok and zero, 'B 突變「取程序數回 0」：A 的對照必須紅，而且紅的理由是記成 0',
               ('紅了、理由對：' if not ok and zero else '不能算抓到：') + d)

        p = mutated(td, "    try:\n        if os.name == 'nt':\n            r = subprocess.run(['powershell'",
                    "    return None\n    try:\n        if os.name == 'nt':\n            r = subprocess.run(['powershell'", 'reslog_fail.py')
        rc, out, rows, idx = run_reslog(p, td, 'C')
        q = all(r[2] == '?' and r[3] == '?' for r in rows)
        summary = [l for l in out.splitlines() if l.startswith('RESLOG: ')]   # 只認 reslog 的摘要那一行
        said = len(summary) == 1 and f'取樣失敗 {idx[7]} 次' in summary[0]
        ok = rc == 3 and q and int(idx[7]) >= 3 and said
        record(ok, 'C 突變「取樣永遠失敗」：紀錄寫「?」、摘要寫取樣失敗次數',
               f'rc={rc}、各行程序數 {[r[2] for r in rows]}、取樣失敗 {idx[7]}、摘要那一行有寫同樣的次數：{said}')

        # E 裸寫的 bash 要解成 Git 的 bash（不是 System32 的 WSL）：被包住的 bash -c "exit 7" 必須真的跑、回傳值照傳 7
        logdir = os.path.join(td, 'logs-E')
        r = subprocess.run([sys.executable, SRC, '--label', 'E', '--estimate', '1', '--interval', '1', '--sample', '1',
                            '--logdir', logdir, '--', 'bash', '-c', 'exit 7'], capture_output=True, timeout=120)
        summ = [l for l in r.stdout.decode('utf-8', 'replace').splitlines() if l.startswith('RESLOG: ')]
        record(r.returncode == 7 and len(summ) == 1, 'E 裸寫的 bash 解成 Git 的 bash：bash -c "exit 7" 真的跑了、回傳值照傳',
               f'rc={r.returncode}、摘要 {summ[:1]}')
        if os.name == 'nt':
            # 錨點逐行接起來（整段寫成一個字串時，「if w」後面接冒號再接換行跳脫，會被自查的路徑樣式誤認成磁碟代號）
            anchor = '\n'.join(['        w = shutil.which(first)', '        if w' + ':', '            first = w']) + '\n'
            pe = mutated(td, anchor, "        pass\n", 'reslog_noresolve.py')
            r = subprocess.run([sys.executable, pe, '--label', 'E2', '--estimate', '1', '--interval', '1', '--sample', '1',
                                '--logdir', os.path.join(td, 'logs-E2'), '--', 'bash', '-c', 'exit 7'], capture_output=True, timeout=120)
            record(r.returncode != 7, 'E 突變「不解路徑」：裸寫的 bash 落到別的 bash（WSL），回傳值不是 7——對照必須紅',
                   f'rc={r.returncode}')
            # F 拒絕那一條路：直接給 System32 的 bash.exe（WSL），reslog 必須不跑、回 2、行首 RESLOG ABORT
            sysroot = os.environ.get('SystemRoot')
            if not sysroot:
                raise RuntimeError('取不到 SystemRoot，F 造不出來')
            wsl = os.path.join(sysroot, 'System32', 'bash.exe')
            r = subprocess.run([sys.executable, SRC, '--label', 'F', '--estimate', '1', '--logdir', os.path.join(td, 'logs-F'),
                                '--', wsl, '-c', 'exit 7'], capture_output=True, timeout=120)
            ab = [l for l in r.stdout.decode('utf-8', 'replace').splitlines() if l.startswith('RESLOG ABORT: ')]
            record(r.returncode == 2 and len(ab) == 1 and 'WSL' in ab[0], 'F 給的是 System32 的 bash.exe：拒絕、回 2、不跑',
                   f'rc={r.returncode}、{ab[:1]}')
        # G 逐一計數（Dispatch 2026-10-02：取樣會系統性漏掉短命的程序）：假工作在第 4 秒同時開 3 個子程序、各活 1 秒，
        #   逐一計數的工作程序峰值必須 ≥ 4（父＋3）——子程序各活 1 秒，比 0.1 秒的輪詢長得多，不受時機影響。
        #   取樣峰值照印、不綁死（第一次取樣什麼時候落下會變，§5.8）。
        if os.name == 'nt':
            burst = os.path.join(td, 'burst.py')
            open(burst, 'w', encoding='utf-8').write(
                'import subprocess, sys, time\ntime.sleep(4)\n'
                'ks = [subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1)"]) for _ in range(3)]\n'
                '[k.wait() for k in ks]\ntime.sleep(4)\n')
            def run_g(script, label):
                logdir = os.path.join(td, 'logs-' + label)
                r = subprocess.run([sys.executable, script, '--label', label, '--estimate', '9', '--sample', '5',
                                    '--logdir', logdir, '--', sys.executable, burst], capture_output=True, timeout=180)
                out = r.stdout.decode('utf-8', 'replace').splitlines()
                idx = open(os.path.join(logdir, 'reslog-index.tsv'), encoding='utf-8').read().splitlines()[-1].split('\t')
                return r.returncode, out, idx
            rc, out, idx = run_g(SRC, 'G')
            lim = [l for l in out if l.startswith('RESLOG LIMIT: ')]
            record(rc == 0 and idx[10].isdigit() and int(idx[10]) >= 4 and len(lim) == 1 and '活不到 0.1 秒的程序仍可能漏' in lim[0],
                   'G 逐一計數：同時開 3 個子程序 → 工作程序峰值 ≥ 4；輸出寫明 0.1 秒輪詢的限制',
                   f'rc={rc}、逐一計數 {idx[10]}／{idx[11]}、取樣 {idx[8]}／{idx[4]}（取樣不綁死）')
            pg = mutated(td, "                if not (pc and ct and ct < pc):\n                    self._add(pid, ppid, name, ct)\n",
                         "                pass\n", 'reslog_noadd.py')
            rc, out, idx = run_g(pg, 'G2')
            record(idx[10].isdigit() and int(idx[10]) < 4, 'G 突變「建立事件不加一」→ 逐一計數數不到 4、對照必須紅', f'逐一計數 {idx[10]}')
            ph = mutated(td, "    if os.name != 'nt':\n        return None, '不是 Windows，沒有 WMI 事件'\n",
                         "    return None, '（測試）監看故意不啟動'\n", 'reslog_nowatch.py')
            rc, out, idx = run_g(ph, 'H')
            lim = [l for l in out if l.startswith('RESLOG LIMIT: ')]
            record(rc == 0 and idx[10] == '?' and idx[11] == '?' and len(lim) == 1 and '逐一計數沒有啟動' in lim[0],
                   'H 監看沒啟動 → index 寫「?」、不寫 0，輸出寫明只有取樣峰值', f'逐一計數 {idx[10]}／{idx[11]}、{lim[:1]}')
        n, t = syn_count(load(SRC, 'reslog_src'))
        record(n == SYN_WANT and 50 not in t and 60 not in t, f'D 工作程序的數法（合成程序表）：應該 {SYN_WANT}，PID 重用的 60 不在樹裡', f'算出 {n}；這一棵 {t}')
        for a, b, label in (
            ("            if not (parent and base_name(parent[2]) in BROWSERS):\n                n += 1",
             "            n += 1", '瀏覽器子程序各算一個'),
            ("        if is_python(name):", "        if is_python(name) or name == 'git':", 'git 也算'),
            ("        if pc and cc and cc < pc:\n            continue\n", "", '不看建立時間（PID 重用的也算進來）'),
        ):
            n2, _t = syn_count(load(mutated(td, a, b, 'reslog_d.py'), 'reslog_d_' + str(len(results))))
            record(n2 != SYN_WANT, f'D 突變「{label}」：數法必須跟答案不同', f'算出 {n2}')
    except (RuntimeError, OSError, subprocess.TimeoutExpired, IndexError, ValueError) as e:
        print(f'TEST-RESLOG ABORT: 造情境失敗：{e}（沒驗到，不是通過）')
        return 2
    finally:
        shutil.rmtree(td, ignore_errors=True)
    print('TEST-RESLOG OK' if all(results) else f'TEST-RESLOG FAILED: {results.count(False)} 項不符')
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
