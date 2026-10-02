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


# ---- 讀輸出只認行首（MealMate 2026-10-02：「那一行有出現某個字」會把印出來的命中內容、或通過那一行的說明誤當成判定） ----
def has_line(out, exact):
    return exact in out.splitlines()


def fail_items(out, prefix):
    """以 prefix 開頭的判定行，冒號後面用「；」拆成一項一項（逐項全等比對，不找子字串）。"""
    items = []
    for l in out.splitlines():
        if l.startswith(prefix):
            items += [x.strip() for x in l[len(prefix):].split('；')]
    return items


def sc_counts(out):
    """自查每一類那一行（例：「secret: control_hit=True added_hits=0 meta_hits=0」）解析成 {類別: {欄位: 值}}。"""
    got = {}
    for l in out.splitlines():
        head, _sep, rest = l.partition(': ')
        if head in ('secret', 'email', 'user', 'path') and rest.startswith('control_hit='):
            got[head] = dict(x.split('=', 1) for x in rest.split())
    return got


def lint_hits(out):
    return sorted(l.split('命中（沒登記）：', 1)[1].rsplit(']', 1)[0] + ']'
                  for l in out.splitlines() if l.startswith('  命中（沒登記）：'))


def data_problems(out):
    """題庫檢查的問題清單：只認「發現 N 個問題：」那一行之後、以「  - 」開頭的行（警告也用「  - 」，在它前面）。"""
    lines = out.splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith('發現 ') and l.endswith('個問題：')), None)
    if start is None:
        return []
    out_ = []
    for l in lines[start + 1:]:
        if not l.startswith('  - '):
            break
        out_.append(l[4:])
    return out_


def parser_controls():
    """擷取函式自己的對照組（§5.11 第二層）：命中內容（縮排四格）與通過那一行的說明裡帶著那幾個字，不能被算進去。"""
    s1 = '\n'.join(['secret: control_hit=True added_hits=0 meta_hits=0',
                    '    secret 命中 1 行（新增行）', '    SELF-CHECK FAILED: secret 命中 1 行（新增行）', 'SELF-CHECK OK'])
    s2 = '\n'.join(['secret: control_hit=True added_hits=1 meta_hits=0', 'SELF-CHECK FAILED: secret 命中 1 行（新增行）；email 命中 1 行（commit 訊息或作者欄）'])
    s3 = '\n'.join(['  命中（沒登記）：js/app.js:9 [overescape] x', '    命中（沒登記）：js/x.js:1 [pipe] y', 'LINT-GATE FAILED: 1 處'])
    s4 = '\n'.join(['⚠ 1 個警告（不影響結果碼）：', '  - 跨級別重複單字 x', '', '發現 1 個問題：', '  - N5/n5-v-0001: 假名欄含非假名字元', '✓ 全部檢查通過 不在這裡'])
    checks = [
        (fail_items(s1, 'SELF-CHECK FAILED: ') == [] and has_line(s1, 'SELF-CHECK OK'), '自查：縮排的命中內容不算判定'),
        (fail_items(s2, 'SELF-CHECK FAILED: ') == ['secret 命中 1 行（新增行）', 'email 命中 1 行（commit 訊息或作者欄）'], '自查：判定行逐項拆開'),
        (sc_counts(s2)['secret']['added_hits'] == '1' and 'email' not in sc_counts(s2), '自查：每一類那一行解析得到'),
        (lint_hits(s3) == ['js/app.js:9 [overescape]'], 'lint：只認兩格縮排的命中行'),
        (data_problems(s4) == ['N5/n5-v-0001: 假名欄含非假名字元'] and not has_line(s4, '✓ 全部檢查通過'), '題庫：只認「發現…個問題」之後的行，警告不算'),
    ]
    for ok, label in checks:
        record(ok, f'擷取函式的對照組：{label}')
    return all(ok for ok, _l in checks)


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
    base_ok = rc == 0 and has_line(out, 'LINT-GATE OK')
    if not tag:
        record(base_ok, 'lint 原樣（該綠）', f'rc={rc}')
    for cat, sample in LINT_SAMPLES.items():
        f = next(x for x in scan if os.path.splitext(x)[1] == cat)
        if (BS * 2) not in sample:
            raise SetupError(f'lint {cat} 樣本裡沒有兩個反斜線')
        n = append_line(os.path.join(W, f), sample)
        rc, out = sh([sys.executable, 'scripts/lint_gate.py'], W, check=False)
        restore(W, f)
        want = [f'{f}:{n} [overescape]'] + ([f'{f}:{n} [backslash]'] if cat == '.sh' and f in m.TARGETS else [])
        got = lint_hits(out)
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
    ok = rc == 0 and has_line(out, 'SELF-CHECK OK')
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
            cnt = sc_counts(out)
            want_hit = set(cnt) == set(samples) and all((cnt[kk].get('added_hits') == '1') == (kk == k)
                                                        and cnt[kk].get('added_hits') in ('0', '1') for kk in samples)
            ok = rc == 1 and want_hit and fail_items(out, 'SELF-CHECK FAILED: ') == [f'{k} 命中 1 行（新增行）']
            oks.append(ok)
            if not tag:
                record(ok, f'自查 {f}（{os.path.splitext(f)[1]}）加一行 {k} 樣本', f'rc={rc}，' +
                       '、'.join(f'{kk}={cnt.get(kk, {}).get("added_hits", "?")}' for kk in samples))
    # commit 訊息帶 email
    append_line(os.path.join(W, 'docs/STATUS.md'), '訊息對照用')
    sh(['git', *ID, 'commit', '-qam', 'msg ' + samples['email']], W)
    rc, out = sh([sys.executable, 'scripts/selfcheck_public.py', base], W, check=False)
    sh(['git', 'reset', '-q', '--hard', base], W)
    ok = rc == 1 and fail_items(out, 'SELF-CHECK FAILED: ') == ['email 命中 1 行（commit 訊息或作者欄）']
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
    ok = rc == 0 and any(l.startswith('✓ 全部檢查通過') for l in out.splitlines())
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
        probs = data_problems(out)
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
        # 複本裡跑的必須是工作區這一版（MealMate 2026-10-02：clone 拿到的是已 commit 的版本，對照組一直在測原版）：
        # 逐支讀出來比，工作區檔案、複本檔案、複本 HEAD 三者位元組相同才往下
        for f in CHECKERS + ['scripts/lib/gitenv.py', 'scripts/test_cli_probes.py']:
            mine = open(os.path.join(ROOT, f), 'rb').read()
            r = subprocess.run(['git', 'show', f'HEAD:{f}'], cwd=W, capture_output=True, env=ENV)
            if open(os.path.join(W, f), 'rb').read() != mine or r.returncode != 0 or r.stdout != mine:
                raise SetupError(f'複本裡的 {f} 不是工作區這一版')
        record(True, f'複本裡的 {len(CHECKERS) + 2} 支檢查程式與工作區位元組相同（檔案與複本 HEAD 都比過）')
        parser_controls()
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
                _r, shown = sh(['git', 'show', f'HEAD:{f}'], W)
                if b not in shown or a in shown:
                    raise SetupError(f'複本 HEAD 裡的 {f} 不是改壞的版本')
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
