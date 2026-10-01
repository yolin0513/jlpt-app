"""公開前自查（推送閘門的第一關）：掃「所有還沒推的 commit」的新增行，以及每個 commit 的訊息與作者、提交者的
名字與信箱，查四類——金鑰或 token、email、本機使用者名稱、本機路徑。命中時標明是「新增行」還是「commit 訊息或作者欄」。

回傳值：0＝通過；1＝有命中、任何一類的對照組沒命中、取不到使用者名稱、或沒有要推的 commit（都不該推）。
由 scripts/pushsafe.sh 呼叫；也可以單獨跑：python scripts/selfcheck_public.py [基準，預設 origin/main]

寫法上的刻意之處：
- 對照組是當場組出來的合成樣本，跑的是同一個樣式（共用慣例 §5.3）；樣本與樣式都拆開寫，
  讓這支檔本身的文字不會被自己的掃描命中（這支檔進 repo 時也會被掃到）。
- 掃的是每一個 commit 的新增行（git log -p），不是只看最後一個：中間 commit 加了又刪掉的內容，推上去照樣在歷史裡。
- 使用者名稱只從環境變數取，不寫進任何檔、命中時也不印出那一行。
"""
import io
import os
import re
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# 入口拒絕（Python 這一層）：git 自己認得的 GIT_ 變數設著時，下面每一個 git 呼叫都可能對著別的 repo（2026-09-25）
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
import gitenv  # noqa: E402
_err = gitenv.self_check()
if _err:
    print(f'SELF-CHECK FAILED: {_err}（檢查器壞了）')
    sys.exit(1)
_bad = gitenv.offending()
if _bad:
    print(f'SELF-CHECK FAILED: 環境裡設了 git 自己認得的變數：{" ".join(_bad)}——可能對著別的 repo 查完說通過；先 unset 再跑')
    sys.exit(1)


def git(*args):
    r = subprocess.run(['git', *args], capture_output=True)
    return r.returncode, r.stdout.decode('utf-8', 'replace')


base = sys.argv[1] if len(sys.argv) > 1 else 'origin/main'
rc, commits = git('rev-list', f'{base}..HEAD')
if rc != 0:
    print(f'SELF-CHECK FAILED: 算不出 {base}..HEAD（基準不存在？）')
    sys.exit(1)
commits = [c for c in commits.split() if c]
if not commits:
    print(f'SELF-CHECK FAILED: {base}..HEAD 沒有要推的 commit')
    sys.exit(1)
rc, patch = git('-c', 'core.quotepath=false', 'log', '--format=', '-p', '-U0', '--no-color', f'{base}..HEAD')
if rc != 0:
    print('SELF-CHECK FAILED: 取不到 diff')
    sys.exit(1)


def extract_added(text):
    """照 diff 的結構抽新增行：只有 @@ 之後、以 + 開頭的才是內容。
    不能用「以 +++ 開頭就當檔頭跳過」——內容本身以 ++ 開頭的行加上 diff 的 + 也是 +++，會被默默丟掉（2026-09-24）。"""
    out, in_hunk = [], False
    for line in text.split('\n'):
        if line.startswith('diff --git '):
            in_hunk = False
        elif line.startswith('@@'):
            in_hunk = True
        elif in_hunk and line.startswith('+'):
            out.append(line[1:])
    return out


def category(path):
    return os.path.splitext(path)[1].lower() or '(無副檔名)'


def added_by_category(text):
    """照 diff 結構（跟 extract_added 同一套判斷）數每一類的新增行；檔名取 diff --git 那一行最後一個「 b/」之後。"""
    out, in_hunk, cat = {}, False, None
    for line in text.split('\n'):
        if line.startswith('diff --git '):
            in_hunk, cat = False, category(line.rsplit(' b/', 1)[-1])
        elif line.startswith('@@'):
            in_hunk = True
        elif in_hunk and line.startswith('+'):
            out[cat] = out.get(cat, 0) + 1
    return out


def numstat_path(p):
    """numstat 的改名寫法（a/{x => y}、x => y）取新的檔名。"""
    if '{' in p and ' => ' in p:
        return re.sub(r'\{[^{}]*? => ([^{}]*)\}', r'\1', p).replace('//', '/')
    return p.split(' => ', 1)[-1]


def numstat_by_category(text):
    out = {}
    for x in text.splitlines():
        f = x.split('\t')
        if len(f) >= 3 and f[0].isdigit() and int(f[0]) > 0:
            c = category(numstat_path(f[2]))
            out[c] = out.get(c, 0) + int(f[0])
    return out


added = extract_added(patch)
# ---- 核對行數：用獨立來源（numstat）算新增行數，對不上就停——抽取壞了（或換環境抽少了）時，零命中不可信 ----
rc, numstat = git('-c', 'core.quotepath=false', 'log', '--format=', '--numstat', f'{base}..HEAD')
if rc != 0:
    print('SELF-CHECK FAILED: 取不到 numstat，沒辦法核對新增行數')
    sys.exit(1)
expected = sum(int(x.split('\t')[0]) for x in numstat.splitlines() if x and x.split('\t')[0].isdigit())
if len(added) != expected:
    print(f'SELF-CHECK FAILED: 新增行抽出 {len(added)} 行、git 算 {expected} 行（抽取壞了，零命中不可信）')
    sys.exit(1)
# 分類報數（2026-10-02，Dispatch）：總數對得上，不代表每一類都對——某一類抽少、另一類抽多也能湊平。
# 每一類（副檔名）的新增行數，照 diff 結構數一次、numstat 再算一次，兩邊每一類都要相等；加總要等於上面的總數。
by_cat = added_by_category(patch)
by_cat_git = numstat_by_category(numstat)
print('新增行分類：' + ('、'.join(f'{c} {n}' for c, n in sorted(by_cat.items())) or '（沒有新增行）')
      + f'，合計 {sum(by_cat.values())}／git 算 {expected}')
if by_cat != by_cat_git or sum(by_cat.values()) != len(added):
    diff_cats = sorted(c for c in set(by_cat) | set(by_cat_git) if by_cat.get(c, 0) != by_cat_git.get(c, 0))
    print(f'SELF-CHECK FAILED: 新增行分類對不上：{[(c, by_cat.get(c, 0), by_cat_git.get(c, 0)) for c in diff_cats]}'
          f'（類別、照 diff 數、git 算），或分類加總 {sum(by_cat.values())} ≠ 抽出的 {len(added)} 行（抽取壞了，零命中不可信）')
    sys.exit(1)
# ---- 核對結束 ----
# commit 訊息與作者、提交者的名字與信箱：一樣會永久留在公開歷史裡（共用慣例 v8 §2.5「自查的範圍」）
rc, meta_raw = git('log', '--format=%an%n%ae%n%cn%n%ce%n%B%x00', f'{base}..HEAD')
if rc != 0:
    print('SELF-CHECK FAILED: 取不到 commit 訊息與作者欄')
    sys.exit(1)
# 第二道（2026-09-25，統籌者查四家時發現本 App 缺）：git 成功卻回傳空的、筆數跟 commit 數對不上、或作者／提交者欄是空的，
# 一樣要停——這一道擋的是姓名與信箱不進 GitHub，取到空的就會變成「0 行、0 命中」默默放行，沒有人會知道。
records = [r.lstrip('\n') for r in meta_raw.split('\x00')]
records = [r for r in records if r.strip()]
# 作者兩欄與提交者兩欄分開判斷（2026-09-25 補充十一）：只有作者是一般信箱（--author、rebase 別人的 commit）是最常見的外洩形態，
# 兩半要各自有情境與突變，不能讓一半的檢查被另一半順便補上。
fields = [(r.split('\n') + ['', '', '', ''])[:4] for r in records]
blank_a = [f for f in fields if not (f[0].strip() and f[1].strip())]
blank_c = [f for f in fields if not (f[2].strip() and f[3].strip())]
if len(records) != len(commits) or blank_a or blank_c:
    print(f'SELF-CHECK FAILED: commit 訊息與作者欄取到 {len(records)} 筆、要推的 commit 有 {len(commits)} 個'
          f'（作者欄是空的：{len(blank_a)} 筆、提交者欄是空的：{len(blank_c)} 筆）——沒拿到該掃的東西，零命中不可信')
    sys.exit(1)
meta = []
for r in records:
    an, ae, cn, ce = (r.split('\n') + ['', '', '', ''])[:4]
    meta += [an, ae]   # 作者名、作者信箱
    meta += [cn, ce]   # 提交者名、提交者信箱
    meta += [l for l in r.split('\n')[4:] if l.strip()]   # commit 訊息

user = os.environ.get('USERNAME') or os.environ.get('USER') or ''
if not user:
    print('SELF-CHECK FAILED: 取不到本機使用者名稱（USERNAME／USER 都是空的），這一類沒辦法查')
    sys.exit(1)

U = 'U' + 'sers'   # 拆開寫：這支檔本身不能出現「斜線＋Users＋斜線」
checks = {
    'secret': re.compile(r'(gh' r'p_|gh' r'o_|github' r'_pat_|sk-an' r't-|sk-[A-Za-z0-9]{20,}|AK' r'IA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)'),
    'email': re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'),
    'user': re.compile(re.escape(user)),
    # 第三個分支的前半段原本不是原始字串（'/|[\\/]'），字元類裡只剩斜線、沒有反斜線：不帶磁碟代號的「反斜線 Users 反斜線」
    # 抓不到（2026-09-25 逐分支對照組抓到的；帶磁碟代號的會被第一個分支順便抓到，所以一直沒人發現）
    'path': re.compile(r'(?<![A-Za-z])[A-Za-z]:[\\/]|/[a-z]/' + U + r'/|[\\/]' + U + r'[\\/]', re.I),
}


def email_ok(m):
    return m.endswith('@' + 'users.noreply.github.com') or m == 'noreply' + '@' + 'anthropic.com'


# 對照組：當場組出來的合成樣本，樣式的每一個分支各一個，全部都要命中（2026-09-25 補充十一：原本每一類只有一個樣本，
# 金鑰那一類七個分支只打到一個，拿掉其他分支對照組照樣全過）。反例：該放行的（noreply 信箱）不能命中。
BS = chr(92)
controls = {
    'secret': ['token ' + 'gh' + 'p_' + 'A' * 36, 'gh' + 'o_' + 'B' * 36, 'github' + '_pat_' + 'C' * 22,
               'sk-an' + 't-' + 'D' * 20, 'sk-' + 'E' * 24, 'AK' + 'IA' + 'F' * 16, '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    'email': ['x' + 'yz' + '@' + 'example' + '.org'],
    'user': ['home ' + user + ' x'],
    'path': ['E' + ':' + BS + 'foo', 'E' + ':' + '/foo', '/c/' + U + '/x', BS + U + BS + 'x', '/' + U + '/x'],
}
negatives = {
    'email': ['x' + '@' + 'users.noreply.github.com', 'noreply' + '@' + 'anthropic.com'],
}


def hit(k, rx, line):
    return any(not email_ok(m) for m in rx.findall(line)) if k == 'email' else bool(rx.search(line))


# ---- 真實檔對照組（2026-10-02，Dispatch）：上面的對照組是直接餵字串給樣式，證明樣式對，不證明「從真實的 diff 抽得到」。
# 這次要推的新增行裡出現的每一類（副檔名），各挑一支這次真的有新增行、HEAD 裡還在的檔，拿它 HEAD 的原始位元組
# （換行、BOM 照原樣）在中間插入每一類各一個合成樣本，用 git diff 產生真的 diff，走同一套抽法（extract_added）與同一個樣式：
# 抽出來的必須恰好是那幾行、每一類恰好命中自己那一行。git 自己的 numstat 也要算出同樣的行數。
def real_file_probe(text):
    import tempfile
    per_path, in_hunk, cur = {}, False, None
    for line in text.split('\n'):
        if line.startswith('diff --git '):
            in_hunk, cur = False, line.rsplit(' b/', 1)[-1]
        elif line.startswith('@@'):
            in_hunk = True
        elif in_hunk and line.startswith('+'):
            per_path[cur] = per_path.get(cur, 0) + 1
    samples = [(k, controls[k][0]) for k in checks]
    used, bad = {}, []
    for cat in sorted({category(p) for p in per_path}):
        src = None
        for p in per_path:
            if category(p) == cat and subprocess.run(['git', 'cat-file', '-e', f'HEAD:{p}'], capture_output=True).returncode == 0:
                src = p
                break
        if src is None:   # 這次動到的那幾支在 HEAD 都被刪了：改拿 HEAD 裡同一類的別支（照樣是那一類的真實檔）
            ls = subprocess.run(['git', '-c', 'core.quotepath=false', 'ls-files'] + (['--', f'*{cat}'] if cat.startswith('.') else []),
                                capture_output=True)
            same = [p for p in ls.stdout.decode('utf-8', 'replace').splitlines() if category(p) == cat] if ls.returncode == 0 else []
            src = same[0] if same else None
        if src is None:
            bad.append(f'{cat}：這次有新增行的檔在 HEAD 都不在了、HEAD 裡也沒有同一類的檔，沒有真實檔可做對照組')
            continue
        blob = subprocess.run(['git', 'show', f'HEAD:{src}'], capture_output=True)
        if blob.returncode != 0:
            bad.append(f'{cat}：取不到 HEAD:{src}')
            continue
        raw = blob.stdout
        eol = b'\r\n' if b'\r\n' in raw else b'\n'
        rows = raw.split(b'\n')
        mid = len(rows) // 2
        ins = [s.encode('utf-8') + (b'\r' if eol == b'\r\n' else b'') for _k, s in samples]
        new = b'\n'.join(rows[:mid] + ins + rows[mid:])
        with tempfile.TemporaryDirectory() as td:
            a, b = os.path.join(td, 'a' + cat), os.path.join(td, 'b' + cat)
            open(a, 'wb').write(raw)
            open(b, 'wb').write(new)
            d = subprocess.run(['git', '-c', 'core.quotepath=false', 'diff', '--no-index', '-U0', '--no-color', a, b], capture_output=True)
            ns = subprocess.run(['git', 'diff', '--no-index', '--numstat', a, b], capture_output=True)
        if d.returncode != 1 or ns.returncode != 1:
            bad.append(f'{cat}（{src}）：git diff 回傳 {d.returncode}／{ns.returncode}，應該是 1（有差異）')
            continue
        got = [l.rstrip('\r') for l in extract_added(d.stdout.decode('utf-8', 'replace'))]
        n_git = sum(int(x.split('\t')[0]) for x in ns.stdout.decode('utf-8', 'replace').splitlines() if x.split('\t')[0].isdigit())
        if got != [s for _k, s in samples] or n_git != len(samples):
            same_n = '行數對、內容不對' if len(got) == len(samples) else '行數不對'
            bad.append(f'{cat}（{src}）：抽出 {len(got)} 行、numstat 算 {n_git} 行，應該恰好是插入的 {len(samples)} 行、內容一字不差（{same_n}）')
            continue
        for k, rx in checks.items():
            who = [samples[i][0] for i, line in enumerate(got) if hit(k, rx, line)]   # 掃的是抽出來的行，不是樣本字串
            if who != [k]:
                bad.append(f'{cat}（{src}）：{k} 在插入的樣本裡命中 {who}，應該恰好是自己那一行')
        used[cat] = src
    return used, bad


failed = []
for k, rx in checks.items():
    missed = [i for i, c in enumerate(controls[k], 1) if not hit(k, rx, c)]
    wrong = [i for i, c in enumerate(negatives.get(k, []), 1) if hit(k, rx, c)]
    chit = not missed and not wrong
    def scan(lines):
        out = []
        for line in lines:
            if k == 'email':
                if any(not email_ok(m) for m in rx.findall(line)):
                    out.append(line)
            elif rx.search(line):
                out.append(line)
        return out
    hits = scan(added)
    mhits = scan(meta)
    print(f'{k}: control_hit={chit} added_hits={len(hits)} meta_hits={len(mhits)}')
    if missed:
        failed.append(f'{k} 對照組沒命中：第 {missed} 個樣本（檢查器壞了，零命中不可信）')
    if wrong:
        failed.append(f'{k} 反例被命中：第 {wrong} 個（該放行的也擋，檢查器壞了）')
    if hits:
        failed.append(f'{k} 命中 {len(hits)} 行（新增行）')
    if mhits:
        failed.append(f'{k} 命中 {len(mhits)} 行（commit 訊息或作者欄）')
    for h in (hits + mhits)[:5]:
        print('   ', '(使用者名稱，不印)' if k == 'user' else h[:160])
probe_used, probe_bad = real_file_probe(patch)
if not probe_used and not probe_bad:
    print('真實檔對照組：沒有新增行，不必做')
else:
    print('真實檔對照組：' + ('、'.join(f'{c} 用 {p}' for c, p in probe_used.items()) or '沒有一類抓到')
          + ('：全部抓到' if not probe_bad else f'：{len(probe_bad)} 處不符'))
for m in probe_bad:
    print('   ', m)
if probe_bad:
    failed.append(f'真實檔對照組 {len(probe_bad)} 處不符（檢查器壞了，零命中不可信）')
print(f'commits: {len(commits)}  added lines: {len(added)}  meta lines: {len(meta)}')
if failed:
    print('SELF-CHECK FAILED: ' + '；'.join(failed))
    sys.exit(1)
print('SELF-CHECK OK')
