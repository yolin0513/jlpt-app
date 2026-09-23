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
rc, patch = git('log', '--format=', '-p', '-U0', '--no-color', f'{base}..HEAD')
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


added = extract_added(patch)
# ---- 核對行數：用獨立來源（numstat）算新增行數，對不上就停——抽取壞了（或換環境抽少了）時，零命中不可信 ----
rc, numstat = git('log', '--format=', '--numstat', f'{base}..HEAD')
if rc != 0:
    print('SELF-CHECK FAILED: 取不到 numstat，沒辦法核對新增行數')
    sys.exit(1)
expected = sum(int(x.split('\t')[0]) for x in numstat.splitlines() if x and x.split('\t')[0].isdigit())
if len(added) != expected:
    print(f'SELF-CHECK FAILED: 新增行抽出 {len(added)} 行、git 算 {expected} 行（抽取壞了，零命中不可信）')
    sys.exit(1)
# ---- 核對結束 ----
# commit 訊息與作者、提交者的名字與信箱：一樣會永久留在公開歷史裡（共用慣例 v8 §2.5「自查的範圍」）
rc, meta_raw = git('log', '--format=%an%n%ae%n%cn%n%ce%n%B%x00', f'{base}..HEAD')
if rc != 0:
    print('SELF-CHECK FAILED: 取不到 commit 訊息與作者欄')
    sys.exit(1)
meta = [l for l in meta_raw.replace('\x00', '\n').split('\n') if l.strip()]

user = os.environ.get('USERNAME') or os.environ.get('USER') or ''
if not user:
    print('SELF-CHECK FAILED: 取不到本機使用者名稱（USERNAME／USER 都是空的），這一類沒辦法查')
    sys.exit(1)

U = 'U' + 'sers'   # 拆開寫：這支檔本身不能出現「斜線＋Users＋斜線」
checks = {
    'secret': re.compile(r'(gh' r'p_|gh' r'o_|github' r'_pat_|sk-an' r't-|sk-[A-Za-z0-9]{20,}|AK' r'IA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)'),
    'email': re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'),
    'user': re.compile(re.escape(user)),
    'path': re.compile(r'(?<![A-Za-z])[A-Za-z]:[\\/]|/[a-z]/' + U + '/|[\\/]' + U + r'[\\/]', re.I),
}


def email_ok(m):
    return m.endswith('@' + 'users.noreply.github.com') or m == 'noreply' + '@' + 'anthropic.com'


# 對照組：當場組出來的合成樣本，每一類一個，必須命中
controls = {
    'secret': 'token ' + 'gh' + 'p_' + 'A' * 36,
    'email': 'x' + 'yz' + '@' + 'example' + '.org',
    'user': 'home ' + user + ' x',
    'path': 'E' + ':' + '\\' + 'foo',
}

failed = []
for k, rx in checks.items():
    c = controls[k]
    chit = any(not email_ok(m) for m in rx.findall(c)) if k == 'email' else bool(rx.search(c))
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
    if not chit:
        failed.append(f'{k} 對照組沒命中（檢查器壞了，零命中不可信）')
    if hits:
        failed.append(f'{k} 命中 {len(hits)} 行（新增行）')
    if mhits:
        failed.append(f'{k} 命中 {len(mhits)} 行（commit 訊息或作者欄）')
    for h in (hits + mhits)[:5]:
        print('   ', '(使用者名稱，不印)' if k == 'user' else h[:160])
print(f'commits: {len(commits)}  added lines: {len(added)}  meta lines: {len(meta)}')
if failed:
    print('SELF-CHECK FAILED: ' + '；'.join(failed))
    sys.exit(1)
print('SELF-CHECK OK')
