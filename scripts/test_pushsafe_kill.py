"""閘門驗法被強制終止時，主 repo 的原始碼會不會被改壞（共用慣例 v11.3 §5.20；Dispatch 2026-10-02）。

用法：python scripts/test_pushsafe_kill.py
回傳值：0＝全部符合；1＝有不符；2＝造情境失敗（沒驗到，不是通過）。
什麼時候跑：改過 test_pushsafe.sh 的「複製、cd、改檔、清理、登記」那幾段就跑。重負載（含一次完整的閘門驗法，約 6～7 分鐘）。

「突變只改暫存 clone、主工作區不會被改壞」原本只是讀程式得出的（test_pushsafe.sh 先 clone 到 mktemp -d、cd 進去才改檔）。
這支用真的強制終止驗它：
  前置：檢查器自己的對照組——在一個暫存 clone 裡改一個檔，「工作區等於 HEAD」的判斷必須判不等；不改必須判相等。
  K 強制終止：以突變 nofetch 開跑閘門驗法，等它印出「MUTATION ACTIVE」（複本裡的檔已改壞並 commit）而且第一個情境已有結果，
    取下這一棵程序樹，用 taskkill /T /F 整棵殺掉；確認殺掉之前的每一個程序都不在了、輸出沒有結尾那一行（真的是中途被殺）、
    暫存複本裡的 pushsafe.sh 真的是改壞的樣子（改壞的檔確實在磁碟上），然後：
    - 主 repo 每一個追蹤中的檔：原始位元組的 sha256 與開跑前相同，而且 git 算出的內容雜湊等於 HEAD；git status 乾淨。
    - 主 repo 的驗法登記（.git/pushsafe-verified）中斷前後的狀態照實記錄（第 23 項）。
    - 留下的暫存目錄（被殺時 trap 不會跑）照實記錄，然後清掉、確認清掉了。
  R 反向：不殺、正常跑完一次完整的閘門驗法（兩種順序），之後主 repo 同樣要等於 HEAD——否則上面只是驗到一個永遠相等的東西。
"""
import glob
import hashlib
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import reslog  # noqa: E402

ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
results = []


class SetupError(Exception):
    pass


def record(ok, label, detail=''):
    results.append(ok)
    print(f'[{"符合" if ok else "不符"}] {label}' + (f'：{detail}' if detail else ''))


def git(root, *a):
    r = subprocess.run(['git', '-c', 'core.quotepath=false', *a], cwd=root, capture_output=True, env=ENV)
    if r.returncode != 0:
        raise SetupError(f'git {a[:2]} 失敗：{r.stderr.decode("utf-8", "replace")[:200]}')
    return r.stdout.decode('utf-8', 'replace')


def rmtree(p):
    def onerr(func, path, _e):
        os.chmod(path, stat.S_IWRITE)
        func(path)
    shutil.rmtree(p, onerror=onerr)


def tree_state(root):
    """(每個追蹤中檔案原始位元組的 sha256, 與 HEAD 內容雜湊不同的檔, git status 的輸出)。"""
    files = [f for f in git(root, 'ls-files', '-z').split('\0') if f]
    if not files:
        raise SetupError('追蹤中的檔案清單是空的')
    raw = {}
    for f in files:
        p = os.path.join(root, f)
        raw[f] = hashlib.sha256(open(p, 'rb').read()).hexdigest() if os.path.isfile(p) else None
    head = {}
    for line in git(root, 'ls-tree', '-r', 'HEAD').splitlines():
        meta, path = line.split('\t', 1)
        head[path] = meta.split()[2]
    present = [f for f in files if raw[f] is not None]
    r = subprocess.run(['git', 'hash-object', '--stdin-paths'], cwd=root, input='\n'.join(present).encode('utf-8'),
                       capture_output=True, env=ENV)
    if r.returncode != 0:
        raise SetupError('git hash-object 失敗')
    now = dict(zip(present, r.stdout.decode().split()))
    if len(now) != len(present):
        raise SetupError(f'hash-object 回來 {len(now)} 筆、要 {len(present)} 筆')
    diff = sorted(f for f in files if raw[f] is None or now.get(f) != head.get(f))
    status = git(root, 'status', '--porcelain')
    return raw, diff, status


def reg_state():
    p = git(ROOT, 'rev-parse', '--path-format=absolute', '--git-path', 'pushsafe-verified').strip()
    if not os.path.exists(p):
        return '不存在'
    b = open(p, 'rb').read()
    return f'存在、{len(b.splitlines())} 行、sha256 {hashlib.sha256(b).hexdigest()[:12]}'


def checker_control():
    td = tempfile.mkdtemp(prefix='jlpt-killctl-')
    try:
        w = os.path.join(td, 'w')
        subprocess.run(['git', 'clone', '-q', '--no-local', ROOT, w], check=True, env=ENV, capture_output=True)
        _r, d0, s0 = tree_state(w)
        p = os.path.join(w, 'scripts', 'pushsafe.sh')
        open(p, 'ab').write(b'# changed\n')
        _r, d1, s1 = tree_state(w)
        ok = d0 == [] and not s0.strip() and d1 == ['scripts/pushsafe.sh'] and s1.strip()
        record(ok, '前置：「工作區等於 HEAD」的判斷——不改判相等、改一個檔判出那一個', f'不改 {d0}、改了 {d1}')
    finally:
        rmtree(td)


def tmpdirs():
    return set(glob.glob(os.path.join(tempfile.gettempdir(), 'tmp.*')))


def main():
    bash = shutil.which('bash')
    if not bash or 'system32' in bash.lower():
        print(f'ABORT: 找不到 Git 的 bash（{bash}）')
        return 2
    try:
        before_raw, before_diff, before_status = tree_state(ROOT)
        if before_diff or before_status.strip():
            print(f'ABORT: 開跑前主 repo 就不等於 HEAD（{before_diff or before_status.strip()}），先 commit')
            return 2
        checker_control()
        reg0 = reg_state()

        # ---- K：強制終止 ----
        out = os.path.join(tempfile.gettempdir(), f'jlpt-kill-{os.getpid()}.log')
        t_before = tmpdirs()
        env = dict(ENV, TEST_PUSHSAFE_MUTATE='nofetch')
        fh = open(out, 'wb')
        child = subprocess.Popen([bash, 'scripts/test_pushsafe.sh'], cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, env=env)
        t0, text = time.time(), ''
        while time.time() - t0 < 300:
            time.sleep(1)
            text = open(out, encoding='utf-8', errors='replace').read()
            if 'MUTATION ACTIVE' in text and ('yes  01' in text or 'no   01' in text):
                break
            if child.poll() is not None:
                break
        if child.poll() is not None or 'MUTATION ACTIVE' not in text:
            fh.close()
            raise SetupError(f'沒等到「改壞並開始跑情境」就結束了（rc={child.returncode}）')
        m = reslog.measure(child.pid)
        if m is None or m[0] < 2:
            raise SetupError(f'取不到這一棵程序樹（{m and m[0]}）')
        pids = m[3]
        # 只認這一次的：新出現、而且裡面有本 repo 的複本（別的專案同時在暫存區開 tmp.* 不會被誤認）
        new_t = sorted(d for d in tmpdirs() - t_before if os.path.isfile(os.path.join(d, 'work', 'scripts', 'test_pushsafe.sh')))
        k = subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True)
        child.wait(timeout=60)
        fh.close()
        time.sleep(2)
        el = time.time() - t0
        snap = reslog.snapshot()
        if snap is None:
            raise SetupError('殺掉之後取不到程序表')
        alive = sorted(p for p in pids if p in snap[0])
        text = open(out, encoding='utf-8', errors='replace').read()
        os.remove(out)
        mid = 'TEST-PUSHSAFE:' not in text
        record(k.returncode == 0 and not alive and mid,
               'K 強制終止：taskkill /T /F 整棵殺掉、殺掉前的程序都不在了、輸出沒有結尾（真的是中途）',
               f'跑了 {el:.0f} 秒、殺掉 {len(pids)} 個程序、還活著 {alive}、taskkill rc={k.returncode}、有結尾那一行：{not mid}')
        if len(new_t) != 1:
            raise SetupError(f'找不到這一次的暫存目錄（新出現 {new_t}）')
        T = new_t[0]
        ps = os.path.join(T, 'work', 'scripts', 'pushsafe.sh')
        broken = os.path.exists(ps) and 'fetch -q origin main' not in open(ps, encoding='utf-8').read()
        record(broken, 'K 中斷當下，改壞的檔確實在磁碟上（在暫存複本裡：pushsafe.sh 的 fetch 那段已拿掉）', f'{broken}')
        after_raw, after_diff, after_status = tree_state(ROOT)
        same = after_raw == before_raw
        record(same and not after_diff and not after_status.strip(),
               'K 主 repo：每個追蹤中的檔原始位元組與開跑前相同、內容雜湊等於 HEAD、git status 乾淨',
               f'{len(after_raw)} 支檔；位元組有變的 {[f for f in after_raw if after_raw[f] != before_raw.get(f)]}；'
               f'與 HEAD 不同的 {after_diff}；status {after_status.strip() or "乾淨"}')
        reg1 = reg_state()
        print(f'[紀錄] K 主 repo 的驗法登記：中斷前 {reg0}；中斷後 {reg1}（{"沒變" if reg0 == reg1 else "變了"}）')
        print(f'[紀錄] K 被殺之後留下的暫存目錄：{"有" if os.path.isdir(T) else "沒有"}（trap 不會跑，預期會留下）')
        rmtree(T)
        record(not os.path.exists(T), 'K 留下的暫存目錄已清掉')

        # ---- R：反向，正常跑完 ----
        rr = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'reslog.py'), '--label', 'test_pushsafe-reverse',
                             '--estimate', '363', '--', bash, 'scripts/test_pushsafe.sh'], cwd=ROOT, capture_output=True, env=ENV)
        tail = rr.stdout.decode('utf-8', 'replace').strip().splitlines()[-3:]
        r_raw, r_diff, r_status = tree_state(ROOT)
        record(rr.returncode == 0 and r_raw == before_raw and not r_diff and not r_status.strip(),
               'R 反向：正常跑完閘門驗法（全符合）後，主 repo 同樣等於 HEAD',
               f'rc={rr.returncode}；{" ／ ".join(tail)}；與 HEAD 不同的 {r_diff}')
        print(f'[紀錄] R 之後主 repo 的驗法登記：{reg_state()}')
    except SetupError as e:
        print(f'TEST-KILL ABORT: 造情境失敗：{e}（沒驗到，不是通過）')
        return 2
    print('TEST-KILL OK' if all(results) else f'TEST-KILL FAILED: {results.count(False)} 項不符')
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
