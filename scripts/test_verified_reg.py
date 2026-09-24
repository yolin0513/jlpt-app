"""驗法登記共用判斷（scripts/lib/verified_reg.py）的失敗分支常設測試（F10 1b，2026-09-24）。

用法：python scripts/test_verified_reg.py [被測的 verified_reg.py] [repo 根目錄]
      （test_pushsafe.sh 情境 27 從複本裡跑它，被測的是複本裡那一份——突變時是改壞的那一份）
回傳值：0＝全部符合；1＝有不符合；2＝前提沒造成。

每個「取不到就停」的分支一種情境（F10：拿掉那個「停」只能紅那一種；照樣停了但理由不對也算紅）：
  取不到 HEAD:<檔>   → 回 2、舊登記刪掉、訊息「取不到 HEAD:」
  git status 失敗    → 回 2、舊登記刪掉、訊息「比不出」
  hash-object 失敗   → 回 2、舊登記刪掉、訊息「算不出驗過的那一份」
前兩種以外的子指令照常交給真的 git（F10 1b 第 2 步：把執行 git 的函式當參數傳進去）；
另一種用 GIT_DIR 指向不存在的目錄，讓真的 git 整個失敗（第 1 步，不能只挑一個子指令）。
對照組：同一個 repo、真的 git、乾淨的工作區 → 回 0、有登記。
"""
import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, 'lib', 'verified_reg.py')
ROOT = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.dirname(HERE)
GUARD = 'scripts/pushsafe.sh'

spec = importlib.util.spec_from_file_location('verified_reg_under_test', HELPER)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
real_git = mod.git

if subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', GUARD], cwd=ROOT).returncode != 0:
    print(f'ABORT：{GUARD} 工作區跟 HEAD 不一樣（前提沒造成：這支要在乾淨的工作區跑）')
    sys.exit(2)

bad = 0


def run(git, env=None):
    """回傳（回傳值, 輸出, 舊登記還在不在）。先放一份舊登記。"""
    t = tempfile.mkdtemp()
    reg = os.path.join(t, 'reg')
    open(reg, 'w').write('舊登記\n')
    argv = [ROOT, reg, 'yes', f'{GUARD}={os.path.join(ROOT, GUARD)}']
    if env is None:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = mod.main(argv, git=git)
        out = buf.getvalue()
    else:
        r = subprocess.run([sys.executable, HELPER, *argv], capture_output=True, env=env)
        rc, out = r.returncode, r.stdout.decode('utf-8', 'replace')
    left = os.path.exists(reg)
    if left:
        os.remove(reg)
    os.rmdir(t)
    return rc, out, left


def failing(sub, match=''):
    """只讓某一個子指令（第一個參數＝sub、而且參數裡含 match）失敗，其他交給真的 git。"""
    def g(root, *a):
        if a and a[0] == sub and match in ' '.join(a):
            return 128, ''
        return real_git(root, *a)
    return g


def report(name, ok, detail=''):
    global bad
    if not ok:
        bad = 1
    print(f'{"yes" if ok else "no ":4s} {name:30s} {detail}')


rc, out, left = run(real_git)
report('對照組：真的 git、乾淨', rc == 0 and left and '已登記' in out, f'rc={rc}')
if not (rc == 0 and left):
    print('ABORT：對照組就不過，後面的失敗情境沒有意義'); sys.exit(2)

for name, g, want in (('取不到 HEAD:<檔>', failing('rev-parse', 'HEAD:'), '取不到 HEAD:'),
                      ('git status 失敗', failing('status'), '比不出'),
                      ('hash-object 失敗', failing('hash-object'), '算不出驗過的那一份')):
    rc, out, left = run(g)
    report(name, rc == 2 and not left and want in out,
           f'rc={rc}' + ('（舊登記還在）' if left else '') + ('' if want in out else f'（訊息不是「{want}」：{out.strip()[:60]}）'))

env = dict(os.environ, GIT_DIR=os.path.join(tempfile.gettempdir(), 'no-such-git-dir-for-test'))
rc, out, left = run(None, env=env)
report('GIT_DIR 指向不存在的目錄', rc == 2 and not left and '取不到 HEAD:' in out,
       f'rc={rc}' + ('（舊登記還在）' if left else '') + ('' if '取不到 HEAD:' in out else f'（訊息：{out.strip()[:60]}）'))

print('全部符合' if not bad else '有不符合')
sys.exit(bad)
