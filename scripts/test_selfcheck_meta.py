"""公開前自查「commit 訊息與作者欄取到了卻不對」的第二道——常設測試（2026-09-25，F10 1b 第 2 步）。

用法：python scripts/test_selfcheck_meta.py <被測的 selfcheck_public.py> <基準>
      （test_pushsafe.sh 情境 28 從複本裡跑：被測的是複本裡那一份自查，突變時是改壞的那一份；複本裡要有 ≥ 2 個待推 commit）
回傳值：0＝全部符合；1＝有不符合；2＝前提沒造成。

「git 成功卻回傳空的」沒辦法靠讓真的 git 失敗造出來（F10 1b 第 1 步只能造「失敗」），所以這裡在測試用的
包裝行程裡把 subprocess.run 換掉（外部依賴當參數傳入的同一種做法；正式的自查裡沒有任何為測試開的分支）：
只有「取 commit 訊息與作者欄」那一個 git 呼叫的回傳被改掉，其他照常交給真的 git。四種：
  對照組   原樣                      → SELF-CHECK OK
  空的     回傳 0、內容是空的          → 停，訊息「取到 0 筆」
  少一筆   回傳 0、少了最後一個 commit  → 停，訊息「取到 N-1 筆」
  作者欄空白   回傳 0、第一筆的作者信箱是空的   → 停，訊息「作者欄是空的：1 筆」
  提交者欄空白 回傳 0、第一筆的提交者信箱是空的 → 停，訊息「提交者欄是空的：1 筆」
  （作者、提交者兩半各自一格——2026-09-25 補充十一：一半的檢查不能被另一半順便補上）
每一種都比對擋下的是這一道（訊息），不是只看回傳值——被別的關卡擋下不算。
"""
import io
import os
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
if len(sys.argv) < 3:
    print('ABORT：用法：test_selfcheck_meta.py <selfcheck_public.py> <基準>'); sys.exit(2)
SC, BASE = os.path.abspath(sys.argv[1]), sys.argv[2]
META_FMT = '--format=%an%n%ae%n%cn%n%ce%n%B%x00'

n = subprocess.run(['git', 'rev-list', '--count', f'{BASE}..HEAD'], capture_output=True, text=True)
if n.returncode != 0 or int(n.stdout.strip() or 0) < 2:
    print(f'ABORT：{BASE}..HEAD 要有至少 2 個 commit（前提沒造成：「少一筆」要有東西可以少）'); sys.exit(2)
N = int(n.stdout.strip())

# 包裝行程：換掉 subprocess.run，只改「取 commit 訊息與作者欄」那一個呼叫的回傳；真的有攔到才寫記號檔
WRAP = '''import runpy, subprocess, sys
mode, sc, base, mark = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
META_FMT = %r
_real = subprocess.run
def fake(args, *a, **k):
    r = _real(args, *a, **k)
    if isinstance(args, list) and args[:2] == ['git', 'log'] and META_FMT in args:
        open(mark, 'w').write('yes')
        out = r.stdout
        if mode == 'empty':
            out = b''
        elif mode == 'short':
            recs = out.split(b'\\x00')
            out = b'\\x00'.join(recs[:-2] + recs[-1:])
        elif mode in ('blank', 'blankc'):
            lines = out.split(b'\\n')
            lines[1 if mode == 'blank' else 3] = b''
            out = b'\\n'.join(lines)
        return subprocess.CompletedProcess(r.args, 0, out, r.stderr)
    return r
subprocess.run = fake
sys.argv = [sc, base]
runpy.run_path(sc, run_name='__main__')
''' % META_FMT

t = tempfile.mkdtemp()
wrap = os.path.join(t, 'wrap.py')
open(wrap, 'w', encoding='utf-8').write(WRAP)
bad = 0


def report(name, ok, detail=''):
    global bad
    if not ok:
        bad = 1
    print(f'{"yes" if ok else "no ":4s} {name:12s} {detail}')


for mode, want_rc, must in (('ok', 0, 'SELF-CHECK OK'),
                            ('empty', 1, f'取到 0 筆、要推的 commit 有 {N} 個'),
                            ('short', 1, f'取到 {N - 1} 筆、要推的 commit 有 {N} 個'),
                            ('blank', 1, '作者欄是空的：1 筆'),
                            ('blankc', 1, '提交者欄是空的：1 筆')):
    mark = os.path.join(t, mode + '.mark')
    r = subprocess.run([sys.executable, wrap, mode, SC, BASE, mark], capture_output=True)
    out = (r.stdout + r.stderr).decode('utf-8', 'replace')
    msg = [l for l in out.splitlines() if l.startswith('SELF-CHECK ')]   # 只看判定訊息那一行
    hooked = os.path.exists(mark)
    ok = hooked and r.returncode == want_rc and any(must in l for l in msg)
    report(mode, ok, f'rc={r.returncode}' + ('' if hooked else '（沒攔到取作者欄那一個呼叫：情境沒造成）')
           + ('' if any(must in l for l in msg) else f'（判定訊息不是「{must}」：{" ".join(msg)[:80]}）'))

print('全部符合' if not bad else '有不符合')
sys.exit(bad)
