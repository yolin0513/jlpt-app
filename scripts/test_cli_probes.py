"""三支統計類檢查的「暫存 clone ＋命令列入口」對照組（共用慣例 v11.2 §5.20；Dispatch 2026-10-02）。

用法：python scripts/test_cli_probes.py
回傳值：0＝全部符合；1＝有不符（某一道該紅沒紅、該綠沒綠、或樣本沒寫進去）；2＝造情境失敗（clone、commit 之類），沒驗到。
什麼時候跑：每次發版至少一次；改過 lint_gate.py／selfcheck_public.py／check_data.py 或這支也要跑。
耗時與負載：單一程序、依序跑，一次只開一個子程序（實測見 docs/STATUS.md）。

各支檢查裡「常設的程式內對照組」每次推送都跑，但那是在程式裡把樣本接到真實內容上，沒有走讀檔與命令列入口。
這支補那一段：把 repo 複製到暫存目錄（工作區裡這三支若有還沒 commit 的改動，一起帶過去，測的就是要 commit 的版本），
在複本裡把已知違規寫進真實檔，**先讀回確認那一行真的含違規字串**，再從命令列跑整支檢查，
比對它點名的是不是那一筆、是不是那一條規則；每一種先跑一次原樣（該綠的要綠）。
最後在複本裡套三個已知的突變，這支自己的對照組必須報不符——證明它真的會擋，不是恆真。
全程不寫工作區；結束時比對工作區的狀態與開始時相同、暫存目錄已刪。
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECKERS = ['scripts/lint_gate.py', 'scripts/selfcheck_public.py', 'scripts/check_data.py']
BS = chr(92)
CYR = chr(0x434)   # 西里爾字母，不是假名
ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}   # 入口拒絕 GIT_ 變數，複本裡也不能帶
ID = ['-c', 'user.name=probe', '-c', 'user.email=probe@users.noreply.github.com']


class SetupError(Exception):
    pass


def sh(args, cwd, check=True):
    r = subprocess.run(args, cwd=cwd, capture_output=True, env=ENV)
    if check and r.returncode != 0:
        raise SetupError(f'{args[:4]} 失敗：{r.stderr.decode("utf-8", "replace")[:200]}')
    return r.returncode, r.stdout.decode('utf-8', 'replace') + r.stderr.decode('utf-8', 'replace')


def rmtree(td):
    """Windows 上 git 的物件檔是唯讀，直接 rmtree 會刪不掉（2026-10-02 第一次實跑留下兩個暫存目錄）：去掉唯讀再刪。"""
    import stat

    def onerr(func, path, _exc):
        os.chmod(path, stat.S_IWRITE)
        func(path)
    shutil.rmtree(td, onerror=onerr)


def workspace_state():
    _rc, st = sh(['git', '-c', 'core.quotepath=false', 'status', '--porcelain'], ROOT)
    h = {}
    for line in st.splitlines():
        p = line[3:]
        fp = os.path.join(ROOT, p)
        h[p] = hashlib.sha256(open(fp, 'rb').read()).hexdigest() if os.path.isfile(fp) else None
    _rc, head = sh(['git', 'rev-parse', 'HEAD'], ROOT)
    return head.strip(), st, h


results = []


def record(ok, label, detail=''):
    results.append(ok)
    print(f'[{"符合" if ok else "不符"}] {label}' + (f'：{detail}' if detail else ''))


def append_line(path, line):
    raw = open(path, 'rb').read()
    eol = b'\r\n' if b'\r\n' in raw else b'\n'
    if raw and not raw.endswith(b'\n'):
        raw += eol
    open(path, 'wb').write(raw + line.encode('utf-8') + eol)
    back = open(path, 'rb').read().decode('utf-8').split('\n')
    last = back[-2].rstrip('\r')
    if last != line:
        raise SetupError(f'讀回的最後一行不是樣本：{last[:60]!r}')
    return len(back) - 1   # 樣本那一行的行號


def restore(W, rel):
    sh(['git', 'checkout', '-q', '--', rel], W)


# ---------- lint ----------
LINT_SAMPLES = {
    '.py': "PROBE = re.compile(r'" + BS * 2 + "d+')",
    '.sh': "grep -E '" + BS * 2 + "s+' probe.txt",
    '.js': 'const PROBE = /^' + BS * 2 + 'w+$/;',
    '.mjs': 'const PROBE = /^' + BS * 2 + 'w+$/;',
}


def lint_targets(W):
    """用 ast 讀 lint 的登記清單（不 import：它一載入就會重包 sys.stdout）。"""
    import ast
    import types
    tree = ast.parse(open(os.path.join(W, 'scripts/lint_gate.py'), encoding='utf-8').read())
    got = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and getattr(node.targets[0], 'id', '') in ('TARGETS', 'ESCAPE_TARGETS'):
            got[node.targets[0].id] = ast.literal_eval(node.value)
    if set(got) != {'TARGETS', 'ESCAPE_TARGETS'} or not got['TARGETS'] or not got['ESCAPE_TARGETS']:
        raise SetupError('讀不到 lint 的 TARGETS／ESCAPE_TARGETS')
    return types.SimpleNamespace(**got)


def probe_lint(W, tag=''):
    m = lint_targets(W)
    scan = list(m.TARGETS) + [f for f in m.ESCAPE_TARGETS if f not in m.TARGETS]
    out_ok = []
    rc, out = sh([sys.executable, 'scripts/lint_gate.py'], W, check=False)
    base_ok = rc == 0 and 'LINT-GATE OK' in out
    if not tag:
        record(base_ok, 'lint 原樣（該綠）', f'rc={rc}')
    for cat, sample in LINT_SAMPLES.items():
        f = next(x for x in scan if os.path.splitext(x)[1] == cat)
        if (BS * 2) not in sample:
            raise SetupError(f'lint {cat} 樣本裡沒有兩個反斜線')
        n = append_line(os.path.join(W, f), sample)
        rc, out = sh([sys.executable, 'scripts/lint_gate.py'], W, check=False)
        restore(W, f)
        hits = sorted(l.strip() for l in out.splitlines() if '命中（沒登記）' in l)
        want = [f'{f}:{n} [overescape]'] + ([f'{f}:{n} [backslash]'] if cat == '.sh' and f in m.TARGETS else [])
        got = sorted(h.split('命中（沒登記）：', 1)[1].rsplit(']', 1)[0] + ']' for h in hits)
        ok = rc == 1 and got == sorted(want)
        out_ok.append(ok)
        if not tag:
            record(ok, f'lint {cat}：{f} 第 {n} 行接已知違規', f'rc={rc}，點名 {got}')
    return all(out_ok) and base_ok


# ---------- 自查 ----------
def sc_samples():
    user = os.environ.get('USERNAME') or os.environ.get('USER') or ''
    if not user:
        raise SetupError('取不到使用者名稱')
    U = 'U' + 'sers'
    return {
        'secret': 'token ' + 'gh' + 'p_' + 'A' * 36,
        'email': 'x' + 'yz' + '@' + 'example' + '.org',
        'user': 'home ' + user + ' x',
        'path': 'E' + ':' + BS + 'foo' + BS + U,
    }


SC_FILES = ['docs/STATUS.md', 'scripts/check_data.py', 'js/app.js', 'data/src/vocab.n5.txt']


def probe_selfcheck(W, base, tag=''):
    oks = []
    # 原樣：一個乾淨的 commit 要放行
    append_line(os.path.join(W, 'docs/STATUS.md'), '對照用的乾淨一行')
    sh(['git', *ID, 'commit', '-qam', 'clean line'], W)
    rc, out = sh([sys.executable, 'scripts/selfcheck_public.py', base], W, check=False)
    sh(['git', 'reset', '-q', '--hard', base], W)
    ok = rc == 0 and 'SELF-CHECK OK' in out
    oks.append(ok)
    if not tag:
        record(ok, '自查 原樣（乾淨的 commit，該綠）', f'rc={rc}')
    samples = sc_samples()
    for f in SC_FILES:
        for k, s in samples.items():
            append_line(os.path.join(W, f), s)
            sh(['git', *ID, 'commit', '-qam', 'probe'], W)
            _r, shown = sh(['git', 'show', 'HEAD', '--', f], W)
            if s not in shown:
                raise SetupError(f'commit 裡找不到樣本（{f} {k}）')
            rc, out = sh([sys.executable, 'scripts/selfcheck_public.py', base], W, check=False)
            sh(['git', 'reset', '-q', '--hard', base], W)
            lines = {l.split(':')[0]: l for l in out.splitlines() if 'control_hit=' in l}
            want_hit = all(('added_hits=1' in lines.get(kk, '')) == (kk == k) for kk in samples)
            ok = rc == 1 and want_hit and f'{k} 命中 1 行（新增行）' in out
            oks.append(ok)
            if not tag:
                record(ok, f'自查 {f}（{os.path.splitext(f)[1]}）加一行 {k} 樣本', f'rc={rc}，' +
                       '、'.join(f'{kk}={lines.get(kk, "?").split("added_hits=")[-1].split()[0]}' for kk in samples))
    # commit 訊息帶 email
    append_line(os.path.join(W, 'docs/STATUS.md'), '訊息對照用')
    sh(['git', *ID, 'commit', '-qam', 'msg ' + samples['email']], W)
    rc, out = sh([sys.executable, 'scripts/selfcheck_public.py', base], W, check=False)
    sh(['git', 'reset', '-q', '--hard', base], W)
    ok = rc == 1 and 'email 命中 1 行（commit 訊息或作者欄）' in out and 'email 命中 1 行（新增行）' not in out
    oks.append(ok)
    if not tag:
        record(ok, '自查 commit 訊息帶 email 樣本', f'rc={rc}')
    return all(oks)


# ---------- 題庫檢查 ----------
DATA_CASES = [   # (檔, 改哪一欄, 怎麼改, 預期的問題字樣)
    ('data/vocab/n5.json', 'kana', lambda v: v + CYR, '假名欄含非假名字元'),
    ('data/grammar/n5.json', 'meaning', lambda v: '', '缺中文意思'),
    ('data/travel/kanji.json', 'reading', lambda v: v + CYR, '讀音含非假名'),
    ('data/travel/phrases.json', 'kana', lambda v: v + CYR, '假名含非假名字元'),
]


def probe_data(W, tag=''):
    oks = []
    rc, out = sh([sys.executable, 'scripts/check_data.py'], W, check=False)
    ok = rc == 0 and '全部檢查通過' in out
    oks.append(ok)
    if not tag:
        record(ok, '題庫檢查 原樣（該綠）', f'rc={rc}')
    for f, field, fn, want in DATA_CASES:
        p = os.path.join(W, f)
        d = json.load(open(p, encoding='utf-8'))
        it = d['items'][0]
        it[field] = fn(it.get(field, ''))
        json.dump(d, open(p, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
        back = json.load(open(p, encoding='utf-8'))['items'][0]
        if back[field] != it[field] or back[field] == json.load(io.StringIO(sh(['git', 'show', f'HEAD:{f}'], W)[1]))['items'][0].get(field):
            raise SetupError(f'讀回的 {f} {field} 沒有改到')
        rc, out = sh([sys.executable, 'scripts/check_data.py'], W, check=False)
        restore(W, f)
        probs = [l.strip()[2:] for l in out.splitlines() if l.startswith('  - ') and '警告' not in l]
        probs = [x for x in probs if not x.startswith('跨級別重複')]
        ok = rc == 1 and len(probs) == 1 and it['id'] in probs[0] and want in probs[0]
        oks.append(ok)
        if not tag:
            record(ok, f'題庫檢查 {f} 第一筆 {it["id"]} 的 {field} 改壞', f'rc={rc}，問題 {probs}')
    return all(oks)


# ---------- 這支自己的對照組：在複本裡套已知的突變，對應那一道必須報不符 ----------
MUTATIONS = [
    ('scripts/lint_gate.py', "    else:\n        for i, l in enumerate(lines, 1):\n            if l.lstrip().startswith(('//', '*')):",
     "    elif name.endswith('.mjs'):\n        for i, l in enumerate(lines, 1):\n            if l.lstrip().startswith(('//', '*')):", 'lint'),
    # 自查選「掃描結果被丟掉」：內建的合成對照組與程式內真實檔對照組都直接呼叫 hit()，照樣全過——只有從命令列入口才分得出
    ('scripts/selfcheck_public.py', '    hits = scan(added)', '    hits = []', 'selfcheck'),
    ('scripts/check_data.py', '        if kana and not KANA_RE.match(kana):', '        if False:', 'data'),
]


def main():
    t0 = time.time()
    before = workspace_state()
    td = tempfile.mkdtemp(prefix='jlpt-cliprobe-')
    W = os.path.join(td, 'w')
    try:
        sh(['git', 'clone', '-q', '--no-local', ROOT, W], td)
        carried = []
        for f in CHECKERS + ['scripts/lib/gitenv.py', 'scripts/test_cli_probes.py']:
            a, b = os.path.join(ROOT, f), os.path.join(W, f)
            if not os.path.exists(b) or open(a, 'rb').read() != open(b, 'rb').read():
                shutil.copy(a, b)
                carried.append(f)
        if carried:
            sh(['git', 'add', '-A'], W)
            sh(['git', *ID, 'commit', '-qm', 'carry working-tree checkers'], W)
        print(f'複本：暫存目錄（HEAD {before[0][:7]}；帶過去的工作區改動：{carried or "無"}）')
        _r, base = sh(['git', 'rev-parse', 'HEAD'], W)
        base = base.strip()
        probe_lint(W)
        probe_selfcheck(W, base)
        probe_data(W)
        for f, a, b, which in MUTATIONS:
            p = os.path.join(W, f)
            s = open(p, encoding='utf-8', newline='').read()
            if s.count(a) != 1:
                raise SetupError(f'突變錨點不是恰好一處：{f}')
            open(p, 'w', encoding='utf-8', newline='').write(s.replace(a, b, 1))
            if open(p, encoding='utf-8', newline='').read().count(b) < 1:
                raise SetupError(f'突變沒寫進去：{f}')
            if which == 'selfcheck':
                sh(['git', *ID, 'commit', '-qam', 'mutate'], W)   # 自查掃 commit，突變本身要在基準裡，不然會被當新增行掃
                _r, mb = sh(['git', 'rev-parse', 'HEAD'], W)
                passed = {'lint': probe_lint, 'selfcheck': lambda w, tag: probe_selfcheck(w, mb.strip(), tag),
                          'data': probe_data}[which](W, 'mut')
                sh(['git', 'reset', '-q', '--hard', base], W)
            else:
                passed = {'lint': probe_lint, 'data': probe_data}[which](W, 'mut')
                restore(W, f)
            record(not passed, f'這支自己的對照組：複本裡套 {which} 的已知突變，必須報不符', '報了不符' if not passed else '照樣全符合（這支沒有擋）')
    except SetupError as e:
        print(f'CLI-PROBES ABORT: 造情境失敗：{e}（沒驗到，不是通過）')
        return 2
    finally:
        rmtree(td)
    after = workspace_state()
    record(before == after, '工作區與開始時相同（HEAD、狀態、每一個有改動的檔的雜湊）',
           f'HEAD {after[0][:7]}，狀態 {after[1].strip() or "乾淨"}')
    record(not os.path.exists(td), '暫存目錄已刪')
    print(f'共 {len(results)} 項，耗時 {time.time() - t0:.1f} 秒')
    if all(results):
        print('CLI-PROBES OK')
        return 0
    print(f'CLI-PROBES FAILED: {results.count(False)} 項不符')
    return 1


if __name__ == '__main__':
    sys.exit(main())
