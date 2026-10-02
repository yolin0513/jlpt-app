"""閘門驗法被強制終止時，主 repo 的原始碼會不會被改壞（共用慣例 v11.3 §5.20；Dispatch 2026-10-02）。

用法：python scripts/test_pushsafe_kill.py [--r-timeout 秒數] [--only-r]
  驗「反向那一步逾時」那條路：python scripts/test_pushsafe_kill.py --only-r --r-timeout 2 → 必須回 4、行首「⊘ 情境未成立」、
  整棵殺掉、留下的暫存目錄清掉、主 repo 等於 HEAD（造一條必然超過 1800 秒的情境太貴，所以把逾時值做成可覆寫）。
回傳值：0＝全部符合；1＝有不符；2＝造情境失敗（git 之類的步驟壞了，沒驗到）；
        4＝情境未成立（重試 3 次都沒在「壞檔在磁碟上、情境在跑」的時候殺到——這次什麼都沒量到，不是通過也不是紅）。
什麼時候跑：改過 test_pushsafe.sh 的「複製、cd、改檔、清理、登記」那幾段就跑。重負載（含一次完整的閘門驗法，約 6～7 分鐘）。
每一次嘗試的完整輸出寫在 .logs/kill-<日期時間>-<第幾次>.log（證據不留在暫存區）。

「突變只改暫存 clone、主工作區不會被改壞」原本只是讀程式得出的（test_pushsafe.sh 先 clone 到 mktemp -d、cd 進去才改檔）。
這支用真的強制終止驗它：
  前置：檢查器自己的對照組——在一個暫存 clone 裡改一個檔，「工作區等於 HEAD」的判斷必須判不等；不改必須判相等。
  三種結果分開判（照 MealMate docs/HOWTO_範圍化突變與帳本.md「情境未成立」）：
    情境是否成立，只看情境自己留下的痕跡，五項都要有——
      (a) 殺之前輸出裡已有「MUTATION ACTIVE」（複本裡的檔已改壞並 commit）與第 1 個情境的結果；
      (b) 殺的那一刻被測程序還在跑；(c) 殺之前量到這一棵程序樹 ≥ 2 個程序；
      (d) 殺之後輸出沒有結尾那一行（真的是中途）；(e) 殺之後暫存複本裡的 pushsafe.sh 是改壞的樣子
          （被殺之後檔案不會自己變壞，所以殺的當下壞檔就在磁碟上）。
    任一項沒有＝情境未成立：不算紅、不算通過、不算數；換一次新的開跑重試，最多 3 次；都沒成立就印行首「⊘ 情境未成立」、回傳 4。
    成立了才判主 repo：每一個追蹤中的檔原始位元組與開跑前相同、git 算出的內容雜湊等於 HEAD、git status 乾淨。
    驗法登記（.git/pushsafe-verified）中斷前後的狀態、留下的暫存目錄照實記錄（第 23 項），暫存目錄清掉並確認。
    每一次嘗試（含沒成立的）之後都檢查主 repo 等於 HEAD。
  C 對照組「一定不成立」：開跑後馬上殺（突變還沒生效），必須判成情境未成立——不能判成紅、也不能判成綠。
  R 反向：不殺、正常跑完一次完整的閘門驗法（兩種順序），之後主 repo 同樣要等於 HEAD——否則上面只是驗到一個永遠相等的東西。
"""
import datetime
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import reslog  # noqa: E402

ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
LOGDIR = os.path.join(ROOT, '.logs')
STAMP = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
MAX_TRIES = 3
NOT_ESTABLISHED = '⊘ 情境未成立'
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


def ours(dirs):
    """只認本 repo 驗法開的暫存目錄：裡面有複本，或有它一開跑就寫的 sample1.txt（被殺得太早、clone 還沒完成時靠這個認）。
    別的專案同時在暫存區開 tmp.* 不會被誤認。"""
    def mine(d):
        if os.path.isfile(os.path.join(d, 'work', 'scripts', 'test_pushsafe.sh')):
            return True
        s1 = os.path.join(d, 'sample1.txt')
        return os.path.isfile(s1) and 'path 命中' in open(s1, encoding='utf-8', errors='replace').read()
    return sorted(d for d in dirs if mine(d))


# ---- 讀驗法的輸出只認行首（MealMate 2026-10-02：子字串會把別一行裡提到的字誤當成那一行） ----
def mutation_active(text):
    return any(l.startswith('MUTATION ACTIVE: ') for l in text.splitlines())


def first_scenario_done(text):
    """驗法每個情境印一行：「yes  01 …」或「no   01 …」。"""
    return any(l.startswith(('yes ', 'no ')) and l.split()[1:2] == ['01'] for l in text.splitlines())


def finished(text):
    return any(l.startswith('TEST-PUSHSAFE: ') for l in text.splitlines())


def parser_controls():
    """擷取函式自己的對照組（§5.11 第二層）：別一行裡提到那幾個字，不能被當成那一行。"""
    fake = '\n'.join(['       實際：MUTATION ACTIVE: nofetch', 'ABORT: 造情境失敗（TEST-PUSHSAFE: 不是結尾）', 'x yes  01 y'])
    real = '\n'.join(['MUTATION ACTIVE: nofetch（已確認…）', 'yes  01 新增行命中自查', 'TEST-PUSHSAFE: 有不符合預期的情況；沒有登記'])
    ok = (not mutation_active(fake) and not first_scenario_done(fake) and not finished(fake)
          and mutation_active(real) and first_scenario_done(real) and finished(real))
    record(ok, '擷取函式的對照組：別一行裡提到「MUTATION ACTIVE」「yes  01」「TEST-PUSHSAFE:」不算；行首的才算')


# ---- 殺程序樹：不用 taskkill /T（2026-10-02，Dispatch 轉 TripQuest 的發現）----
# Windows 會重用 PID：一個早就開著的程序（2026-10-02 實際撞到的是 OneDrive 同步服務）記著的父 PID 剛好等於這次的 bash，
# 就會被認成它的子程序；真殺下去會砍掉 Yolin 正在同步的檔案。兩道：
#   一、子程序必須比父程序晚建立才算（reslog.tree；根程序被殺之後仍用殺之前記下的建立時間判斷）；
#   二、只殺名稱在可殺清單裡的；不在清單裡的就算被認成子程序也不殺，只印出來。
KILLABLE = {
    'bash', 'sh', 'python', 'python3', 'git', 'git-remote-http', 'git-remote-https', 'timeout', 'node', 'conhost',
    'powershell',   # reslog.py 取樣用的，是 reslog 自己的子程序
    'cat', 'grep', 'sed', 'awk', 'gawk', 'cut', 'sort', 'tr', 'wc', 'head', 'tail', 'mktemp', 'rm', 'chmod', 'cmp',
    'date', 'mkdir', 'cp', 'mv', 'ls', 'env', 'printf', 'sleep', 'tee', 'find', 'xargs', 'diff', 'uniq', 'basename',
    'dirname', 'readlink', 'realpath', 'touch', 'expr', 'seq', 'od', 'sha256sum', 'file', 'cygpath',
}


def kill_tree(root):
    """殺 root 這一棵（兩道見上）。回傳 (殺了的 [(pid, 名稱)], 沒殺的 [(pid, 名稱)], 殺完還在的可殺程序 [pid])。
    最多 3 輪：每一輪重新取程序表、重新算樹（殺的時候可能又開了新的子程序）。"""
    snap = reslog.snapshot()
    if snap is None:
        raise SetupError('要殺之前取不到程序表')
    root_ct = reslog.ctime(snap[0], root)
    killed, skipped, skip_ids = [], [], set()

    def tree_now():
        sn = reslog.snapshot()
        if sn is None:
            raise SetupError('殺的途中取不到程序表')
        procs = dict(sn[0])
        if root not in procs and root_ct:
            procs[root] = (0, 0, '', root_ct)   # 根已經被殺：補上它殺之前的建立時間，PID 重用的孤兒照樣被擋
        return procs, reslog.tree(procs, root) & set(sn[0])

    for _round in range(3):
        procs, t = tree_now()
        todo = sorted((p for p in t if p not in skip_ids), key=lambda x: (x != root, x))   # 先殺根，讓它不再開新的
        if not todo:
            break
        for p in todo:
            name = reslog.base_name(procs[p][2])
            if name in KILLABLE:
                subprocess.run(['taskkill', '/PID', str(p), '/F'], capture_output=True)
                killed.append((p, name))
            else:
                skipped.append((p, procs[p][2]))
                skip_ids.add(p)
                print(f'[未殺] PID {p} {procs[p][2]}：被認成這棵樹的程序，但名稱不在可殺清單——只印出、不殺')
        time.sleep(1)
    procs, t = tree_now()
    remaining = sorted(p for p in t if p not in skip_ids)
    return killed, skipped, remaining


def kill_tree_controls():
    """kill_tree 兩道的對照組（每次都跑，秒級）。
    一、合成程序表（不碰真的程序）：根 100、真子程序 101（晚於根建立）、PID 重用的舊程序 50（記著父 PID＝根，但比根早建立）。
        殺的動作換成記錄；根被殺之後程序表裡沒有根——舊程序照樣不能被殺（靠殺之前記下的根建立時間）。
    二、真的程序：一個 python 根、底下一個改了名字（不在可殺清單）的子程序；根要被殺、子程序只印出不殺，最後由這裡精準收掉。"""
    import types
    ROOT_PID, KID, STALE = 900001, 900002, 900003
    state = {ROOT_PID: (1, 10, 'bash.exe', 100), KID: (ROOT_PID, 10, 'python.exe', 101), STALE: (ROOT_PID, 10, 'python.exe', 50)}
    calls = []
    real_snapshot, real_run = reslog.snapshot, subprocess.run

    def fake_snapshot():
        return dict(state), 10 ** 9

    def fake_run(args, **k):
        if args[:1] == ['taskkill']:
            pid = int(args[2])
            calls.append(pid)
            state.pop(pid, None)
            return types.SimpleNamespace(returncode=0, stdout=b'', stderr=b'')
        return real_run(args, **k)
    reslog.snapshot, subprocess.run = fake_snapshot, fake_run
    try:
        killed, skipped, alive = kill_tree(ROOT_PID)
    finally:
        reslog.snapshot, subprocess.run = real_snapshot, real_run
    ok1 = sorted(calls) == [ROOT_PID, KID] and STALE not in calls and not alive and not skipped
    record(ok1, 'kill_tree 對照組一（合成）：殺根與真子程序；PID 重用的舊程序在根死後也不殺', f'殺了 {calls}、殺完還在 {alive}')

    # 二、真的程序：不在清單的名字
    td = tempfile.mkdtemp(prefix='jlpt-killctl2-')
    odd = os.path.join(td, 'notkillable.exe')
    shutil.copy(sys.executable, odd)
    parent = subprocess.Popen([sys.executable, '-c',
                               'import subprocess,sys,time; subprocess.Popen([sys.argv[1], "-c", "import time; time.sleep(60)"]); time.sleep(60)',
                               odd])
    kid_pid = None
    try:
        for _ in range(20):
            time.sleep(0.5)
            sn = reslog.snapshot()
            kids = [p for p, v in (sn[0].items() if sn else []) if v[0] == parent.pid and reslog.base_name(v[2]) == 'notkillable']
            if kids:
                kid_pid = kids[0]
                break
        if kid_pid is None:
            raise SetupError('kill_tree 對照組二：改名的子程序沒起來')
        killed, skipped, alive = kill_tree(parent.pid)
        sn = reslog.snapshot()
        still = sn is not None and kid_pid in sn[0]
        ok2 = (parent.pid, 'python') in killed and [p for p, _n in skipped] == [kid_pid] and still and not alive
        record(ok2, 'kill_tree 對照組二（真的程序）：python 根被殺、不在可殺清單的子程序只印出不殺',
               f'殺了 {killed}、沒殺 {skipped}、那個子程序事後還在 {still}')
    finally:
        if kid_pid:
            subprocess.run(['taskkill', '/PID', str(kid_pid), '/F'], capture_output=True)   # 這一支是這裡自己開的，精準收掉
        try:
            parent.kill()
        except OSError:
            pass
        time.sleep(1)
        rmtree(td)


def attempt(bash, mode, label):
    """跑一次「開跑→殺」。mode='real'：等到改壞並開始跑情境才殺；mode='early'：開跑後 1 秒就殺（對照組，一定不成立）。
    回傳 (成立與否, 痕跡說明, 暫存目錄或 None)。每一次都把完整輸出留在 .logs/。"""
    os.makedirs(LOGDIR, exist_ok=True)
    out = os.path.join(LOGDIR, f'kill-{STAMP}-{label}.log')
    t_before = tmpdirs()
    env = dict(ENV, TEST_PUSHSAFE_MUTATE='nofetch')
    fh = open(out, 'wb')
    child = subprocess.Popen([bash, 'scripts/test_pushsafe.sh'], cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, env=env)
    t0, text = time.time(), ''
    if mode == 'early':
        time.sleep(1)
        text = open(out, encoding='utf-8', errors='replace').read()
    else:
        while time.time() - t0 < 300:
            time.sleep(1)
            text = open(out, encoding='utf-8', errors='replace').read()
            if (mutation_active(text) and first_scenario_done(text)) or child.poll() is not None:
                break
    a = mutation_active(text) and first_scenario_done(text)
    b = child.poll() is None
    m = reslog.measure(child.pid) if b else None
    c = m is not None and m[0] >= 2
    killed, skipped, alive = kill_tree(child.pid) if b else ([], [], [])
    try:
        child.wait(timeout=60)
    except subprocess.TimeoutExpired:
        pass
    fh.close()
    time.sleep(1)
    if alive or skipped:
        for d in ours(tmpdirs() - t_before):   # 丟出之前先清掉自己留下的暫存目錄（2026-10-02 這裡中止時留下一個）
            rmtree(d)
        raise SetupError(f'殺掉之後還有可殺的程序活著：{alive}；不在可殺清單、沒殺的：{skipped}')
    final = open(out, encoding='utf-8', errors='replace').read()
    d = not finished(final)
    ts = ours(tmpdirs() - t_before)
    T = ts[0] if len(ts) == 1 else None
    ps = os.path.join(T, 'work', 'scripts', 'pushsafe.sh') if T else ''
    e = bool(T) and os.path.exists(ps) and 'fetch -q origin main' not in open(ps, encoding='utf-8').read()
    traces = (f'(a) 已改壞且情境開跑 {a}、(b) 殺時還在跑 {b}、(c) 程序樹 {m[0] if m else "?"} 個、'
              f'(d) 沒有結尾 {d}、(e) 複本裡是壞檔 {e}；開跑後 {time.time() - t0:.0f} 秒；'
              f'殺了 {len(killed)} 個（{sorted({n for _p, n in killed})}）；log {os.path.relpath(out, ROOT)}')
    for extra in ts[1:] if len(ts) > 1 else []:
        rmtree(extra)
    return a and b and c and d and e, traces, T


def run_k(bash, mode, before_raw, tag):
    """最多 MAX_TRIES 次；回傳 (成立與否, 最後一次的痕跡, 暫存目錄, 嘗試次數)。每一次之後都檢查主 repo。"""
    for i in range(1, MAX_TRIES + 1):
        ok, traces, T = attempt(bash, mode, f'{tag}{i}')
        raw, diff, status = tree_state(ROOT)
        if raw != before_raw or diff or status.strip():
            record(False, f'{tag} 第 {i} 次嘗試之後主 repo 不等於開跑前', f'與 HEAD 不同 {diff}；status {status.strip()}')
        print(f'  {tag} 第 {i} 次：{"成立" if ok else "沒成立"}——{traces}')
        if ok:
            return True, traces, T, i
        if T and os.path.isdir(T):
            rmtree(T)
    return False, traces, None, MAX_TRIES


def run_r(bash, before_raw, timeout):
    """反向：不殺、讓閘門驗法正常跑完。回傳 None＝情境成立且已判（record）；回傳 4＝情境未成立。
    逾時：subprocess 的 timeout 只殺得到直接的子程序（reslog.py），底下整棵閘門驗法會變成孤兒繼續跑——
    所以自己等、逾時就用 kill_tree 殺這一棵（不用 taskkill /T）、確認都不在了、清掉留下的暫存目錄，再判「情境未成立」。"""
    os.makedirs(LOGDIR, exist_ok=True)   # 新 clone 裡沒有 .logs/（2026-10-02 在暫存 clone 跑突變時崩潰才發現；主 repo 一直有，所以沒露出來）
    rlog = os.path.join(LOGDIR, f'kill-{STAMP}-R.log')
    t_before = tmpdirs()
    fh = open(rlog, 'wb')
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, 'scripts', 'reslog.py'), '--label', 'test_pushsafe-reverse',
                          '--estimate', '363', '--', bash, 'scripts/test_pushsafe.sh'], cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, env=ENV)
    try:
        p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        killed, skipped, alive = kill_tree(p.pid)
        try:
            p.wait(timeout=60)
        except subprocess.TimeoutExpired:
            pass
        fh.close()
        time.sleep(1)
        left = ours(tmpdirs() - t_before)
        for d in left:
            rmtree(d)
        raw, diff, status = tree_state(ROOT)
        clean = raw == before_raw and not diff and not status.strip()
        record(not alive and not skipped and not any(os.path.exists(d) for d in left) and clean,
               f'R 逾時（{timeout} 秒）的收尾：整棵殺掉（只殺可殺清單裡的）、留下的暫存目錄清掉、主 repo 等於 HEAD',
               f'殺了 {len(killed)} 個（{sorted({n for _p, n in killed})}）、不在清單沒殺的 {skipped}、殺完還在 {alive}、'
               f'找到留下的暫存目錄 {len(left)} 個、清完還在 {sum(os.path.exists(d) for d in left)} 個、主 repo {"等於" if clean else "不等於"} HEAD')
        print(f'{NOT_ESTABLISHED}：R 閘門驗法 {timeout} 秒沒跑完（逾時）——「正常跑完之後主 repo 等於 HEAD」這次沒量到'
              f'（log {os.path.relpath(rlog, ROOT)}）')
        if not results[-1]:   # 收尾本身不符（還有程序活著、目錄沒清掉、主 repo 被動到）是真的不符，不能被「未成立」的 4 蓋掉
            print('TEST-KILL FAILED: 逾時之後的收尾不符')
            return 1
        return 4
    fh.close()
    rtext = open(rlog, encoding='utf-8', errors='replace').read()
    tail = rtext.strip().splitlines()[-3:]
    r_raw, r_diff, r_status = tree_state(ROOT)
    # R 的情境是「正常跑完」：只認驗法自己在行首印的全過那一行，不看回傳值（v11.4：崩潰與逾時不得被回傳值吃掉）
    if not any(l.startswith('TEST-PUSHSAFE: 全部符合預期（兩種順序）') for l in rtext.splitlines()):
        print(f'{NOT_ESTABLISHED}：R 閘門驗法沒有正常跑完（rc={p.returncode}；{" ／ ".join(tail)}；log {os.path.relpath(rlog, ROOT)}）'
              '——「正常跑完之後主 repo 等於 HEAD」這次沒量到')
        return 4
    record(p.returncode == 0 and r_raw == before_raw and not r_diff and not r_status.strip(),
           'R 反向：正常跑完閘門驗法（全符合）後，主 repo 同樣等於 HEAD',
           f'rc={p.returncode}；{" ／ ".join(tail)}；與 HEAD 不同的 {r_diff}；log {os.path.relpath(rlog, ROOT)}')
    print(f'[紀錄] R 之後主 repo 的驗法登記：{reg_state()}')
    return None


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--r-timeout', type=float, default=1800, help='反向那一步的逾時秒數（驗逾時那條路時調短，例：2）')
    ap.add_argument('--only-r', action='store_true', help='只跑前置與反向那一步（驗逾時那條路用；不跑 C、K）')
    args = ap.parse_args()
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
        parser_controls()
        kill_tree_controls()
        reg0 = reg_state()

        if args.only_r:
            print('[紀錄] --only-r：只跑前置與反向那一步，C、K 這次不跑')
        # ---- C：對照組「一定不成立」——開跑後 1 秒就殺，突變還沒生效 ----
        ok, traces, T, n = run_k(bash, 'early', before_raw, 'C') if not args.only_r else (False, '', None, 0)
        if not args.only_r:
          record(not ok and T is None, f'C 對照組「一定不成立」：{n} 次都判成情境未成立（不是紅、不是綠）',
               '判成未成立' if not ok else f'竟然判成成立：{traces}')

        # ---- K：強制終止 ----
        ok, traces, T, n = run_k(bash, 'real', before_raw, 'K') if not args.only_r else (True, '', None, 0)
        if not ok:
            print(f'{NOT_ESTABLISHED}：K 重試 {n} 次都沒在「壞檔在磁碟上、情境在跑」的時候殺到——這次什麼都沒量到（最後一次：{traces}）')
            return 4
        after_raw, after_diff, after_status = tree_state(ROOT)
        if not args.only_r:
          record(after_raw == before_raw and not after_diff and not after_status.strip(),
               f'K 情境成立（第 {n} 次）：主 repo 每個追蹤中的檔原始位元組與開跑前相同、內容雜湊等於 HEAD、git status 乾淨',
               f'{len(after_raw)} 支檔；位元組有變的 {[f for f in after_raw if after_raw[f] != before_raw.get(f)]}；'
               f'與 HEAD 不同的 {after_diff}；status {after_status.strip() or "乾淨"}')
        if not args.only_r:
          reg1 = reg_state()
          print(f'[紀錄] K 主 repo 的驗法登記：中斷前 {reg0}；中斷後 {reg1}（{"沒變" if reg0 == reg1 else "變了"}）')
          print(f'[紀錄] K 被殺之後留下的暫存目錄：{"有" if os.path.isdir(T) else "沒有"}（trap 不會跑，預期會留下）')
          rmtree(T)
          record(not os.path.exists(T), 'K 留下的暫存目錄已清掉')

        # ---- R：反向，正常跑完 ----
        rc_r = run_r(bash, before_raw, args.r_timeout)
        if rc_r is not None:
            return rc_r
    except SetupError as e:
        print(f'TEST-KILL ABORT: 造情境失敗：{e}（沒驗到，不是通過）')
        return 2
    print('TEST-KILL OK' if all(results) else f'TEST-KILL FAILED: {results.count(False)} 項不符')
    return 0 if all(results) else 1


if __name__ == '__main__':
    # 只在直接執行時重包輸出：run_gate_mutations 會 import 這支拿 kill_tree，載入時重包會把它的輸出關掉（2026-10-02 撞到）
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.exit(main())
