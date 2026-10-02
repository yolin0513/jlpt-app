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
}
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

        p = mutated(td, '    """回傳 ({pid: (ppid, 記憶體位元組, 程序名稱)}, 系統可用記憶體位元組)；取不到回傳 None。"""\n',
                    '    """回傳 ({pid: (ppid, 記憶體位元組, 程序名稱)}, 系統可用記憶體位元組)；取不到回傳 None。"""\n    return None\n',
                    'reslog_fail.py')
        rc, out, rows, idx = run_reslog(p, td, 'C')
        q = all(r[2] == '?' and r[3] == '?' for r in rows)
        summary = [l for l in out.splitlines() if l.startswith('RESLOG: ')]   # 只認 reslog 的摘要那一行
        said = len(summary) == 1 and f'取樣失敗 {idx[7]} 次' in summary[0]
        ok = rc == 3 and q and int(idx[7]) >= 3 and said
        record(ok, 'C 突變「取樣永遠失敗」：紀錄寫「?」、摘要寫取樣失敗次數',
               f'rc={rc}、各行程序數 {[r[2] for r in rows]}、取樣失敗 {idx[7]}、摘要那一行有寫同樣的次數：{said}')

        n, t = syn_count(load(SRC, 'reslog_src'))
        record(n == SYN_WANT and 50 not in t, f'D 工作程序的數法（合成程序表）：應該 {SYN_WANT}', f'算出 {n}；這一棵 {t}')
        for a, b, label in (
            ("            if not (parent and base_name(parent[2]) in BROWSERS):\n                n += 1",
             "            n += 1", '瀏覽器子程序各算一個'),
            ("        if is_python(name):", "        if is_python(name) or name == 'git':", 'git 也算'),
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
