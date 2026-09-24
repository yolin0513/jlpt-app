"""掃推送閘門、公開前自查、閘門驗法有沒有已知的壞寫法（共用慣例 v9 §5.16）。

用法：python scripts/lint_gate.py
回傳值：0＝通過；1＝有沒登記的命中、登記的例外沒命中（例外過期）、對照組沒命中或反例被誤抓（檢查器壞了）、
        登記的檔讀不到或是空的（故障時停下，§5.13）。
什麼時候跑：scripts/pushsafe.sh 的第一步——每次推送都跑（§5.15）；改過這支或被掃的檔也可以單獨跑。

- 母體用登記制（§5.2）：只掃 TARGETS 列的檔，不是「掃 scripts/ 全部、扣掉例外」。
- 每一種壞寫法都有對照組（§5.3）：當場組出來的合成樣本，加上這兩天真的出過事的原文；任何一條沒命中就停。
  另有反例（合法寫法，不該被抓），兩個方向都驗。
- 初篩型的兩種（斷言「不存在」、grep／sed 樣式含反斜線）命中之後逐條判斷；判斷過的寫成 EXCEPTIONS，附理由。
  登記的例外若這次沒命中，也算失敗——例外清單不能默默過期。
"""
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TARGETS = [
    'scripts/pushsafe.sh',
    'scripts/selfcheck_public.py',
    'scripts/test_pushsafe.sh',
]

# 跳脫類的兩種（backslash、overescape）掃 repo 裡「所有」腳本（2026-09-24，統籌者補充說明（四））：
# heredoc 把 \\ 變成 \ 的那種寫的當下攔不到；真正會空轉的是語法正確、但 regex 被多跳脫了一次——只有掃描抓得到，
# 所以掃描的母體要大到「新寫的腳本下一次跑就會被掃到」。登記制：這裡列的才掃；專案裡有腳本沒列進來（孤兒）就擋。
ESCAPE_RULES = ('backslash', 'overescape')
ESCAPE_TARGETS = [
    'js/app.js', 'js/backup.js', 'js/data.js', 'js/db.js', 'js/itemview.js', 'js/kana.js', 'js/keys.js',
    'js/pos.js', 'js/qtypes.js', 'js/router.js', 'js/session.js', 'js/speech.js', 'js/srs.js', 'js/store.js',
    'js/ui.js', 'js/weak.js',
    'js/views/exam.js', 'js/views/favorites.js', 'js/views/flashcards.js', 'js/views/home.js', 'js/views/learn.js',
    'js/views/listening.js', 'js/views/mistakes.js', 'js/views/quiz.js', 'js/views/review.js',
    'js/views/search.js', 'js/views/stats.js', 'js/views/travel.js', 'js/views/weak.js',
    'scripts/audit.mjs', 'scripts/build_data.py', 'scripts/check_data.py', 'scripts/filter_grammar_draft.mjs',
    'scripts/filter_vocab_draft.mjs', 'scripts/lib/harness.mjs', 'scripts/lint_gate.py', 'scripts/make_icons.py',
    'scripts/pushsafe.sh', 'scripts/regress.mjs', 'scripts/screenshots.mjs', 'scripts/selfcheck_public.py',
    'scripts/serve.py', 'scripts/test_datacheck.py', 'scripts/test_filters.py', 'scripts/test_harness.mjs',
    'scripts/test_pushsafe.sh', 'scripts/verify-full.mjs', 'scripts/verify-live.mjs', 'sw.js',
]

P3 = '+' * 3   # 拆開寫，這支檔的說明文字不必出現連續三個加號也能講清楚

# ---- 六種壞寫法：每種一個函式，輸入 (檔名, 整份內容的行)，回傳命中的 (行號, 原文) ----
# 「執行」自查或 git 的那幾種動作；只是檔名出現在路徑裡（例如 git show HEAD:scripts/selfcheck_public.py）不算
KEY_CMD = re.compile(r'(\bpython3?\s+\S*selfcheck_public\.py|\bgit\b[^|#\n]*?\s(push|fetch|ls-remote|diff|log)\b)')


def is_comment(line):
    return line.lstrip().startswith('#')


def r_pipe(name, lines):
    """自查、推送、取遠端狀態、取 diff 的那一行後面接管線（只看 shell 檔；|| 不是管線）。"""
    if not name.endswith('.sh'):
        return []
    out = []
    for i, line in enumerate(lines, 1):
        if is_comment(line):
            continue
        m = KEY_CMD.search(line)
        if m and '|' in line[m.end():].replace('||', ''):
            out.append((i, line))
    return out


def r_swallow(name, lines):
    """自查或閘門裡的 || true（或 || :）、空的 catch／except: pass。"""
    out = []
    for i, line in enumerate(lines, 1):
        if is_comment(line):
            continue
        s = line.strip()
        if re.search(r'\|\|\s*(true|:)\s*($|;|\))', s):
            out.append((i, line))
        elif re.search(r'\bcatch\s*(\([^)]*\))?\s*\{\s*\}', s):
            out.append((i, line))
        elif re.match(r'except\b[^:]*:\s*(pass)?\s*$', s):
            nxt = lines[i].strip() if i < len(lines) else ''
            if s.endswith('pass') or nxt == 'pass':
                out.append((i, line))
    return out


PLUS_HDR = re.compile(r"startswith\(\s*['\"]" + re.escape(P3) + r"['\"]|==\s*['\"]" + re.escape(P3) + r"['\"]|['\"]\^(\\\+|\+){3}")


def r_plushdr(name, lines):
    """用「以三個加號開頭」判斷 diff 檔頭。"""
    return [(i, l) for i, l in enumerate(lines, 1) if not is_comment(l) and PLUS_HDR.search(l)]


def r_formatonly(name, lines):
    """同一支腳本用 --format= 取新增行（log -p／diff），卻沒有另外取 commit 訊息與作者欄（%B、%ae）。"""
    text = '\n'.join(l for l in lines if not is_comment(l))
    if '--format=' not in text or not re.search(r"['\"]-p['\"]|\s-p\s|\bdiff\b", text):
        return []
    if '%B' in text and '%ae' in text:
        return []
    return [(i, l) for i, l in enumerate(lines, 1) if '--format=' in l and not is_comment(l)]


ABSENT = re.compile(r'grep\s+-q\w*\b[^|;]*&&\s*(die|exit|return\s+1)|!\s*grep\b|\[\s*!\s*-[ef]\s|os\.path\.exists\([^)]*\)\s*==\s*False|not\s+os\.path\.exists')


def r_absent(name, lines):
    """（初篩）斷言「不存在」的地方：命中的逐條看前面有沒有先確認它原本在。"""
    return [(i, l) for i, l in enumerate(lines, 1) if not is_comment(l) and ABSENT.search(l)]


def r_backslash(name, lines):
    """（初篩）grep／sed 的樣式含反斜線、寫在 shell 指令列上：命中的逐條確認同一次執行裡跑過對照組。"""
    if not name.endswith('.sh'):
        return []
    return [(i, l) for i, l in enumerate(lines, 1)
            if not is_comment(l) and re.search(r'\b(grep|sed)\b', l) and '\\' in l.split('grep', 1)[-1].split('sed', 1)[-1]]


BS = chr(92)   # 反斜線；樣式與樣本都用它組出來，這支檔自己的原始碼才不會出現多跳脫的字面、被自己掃到
_CLS = '[dswbDSWB]'
OVER2 = re.compile(re.escape(BS * 2) + _CLS)   # 原始字串／regex 字面裡兩個反斜線＋d：比對的是「反斜線＋d」，不是數字
OVER4 = re.compile(re.escape(BS * 4) + _CLS)   # 一般字串裡四個反斜線＋d：執行時是兩個反斜線＋d，同上
JS_RE_LIT = re.compile(r'(?:^|[=(,:!&|?{};\[]|\breturn\b)\s*/((?:' + re.escape(BS) + r'.|\[(?:' + re.escape(BS)
                       + r'.|[^\]' + re.escape(BS) + r'])*\]|[^/' + re.escape(BS) + r'\[\n])+)/[dgimsuyv]*')


def r_overescape(name, lines):
    """regex 多跳脫了一次（語法正確、但永遠不命中）：原始字串或 regex 字面裡「兩個反斜線＋d/s/w/b」、
    一般字串裡「四個反斜線＋d/s/w/b」、shell 的 grep／sed 那一行裡「兩個反斜線＋d/s/w/b」。
    Python 用 tokenize 找字串；JS 找 regex 字面是用樣式近似（對照組守著）。說明文字不寫出反斜線，免得被自己掃到。"""
    import tokenize
    text = '\n'.join(lines)
    out = []
    if name.endswith('.py'):
        try:
            toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
        except (tokenize.TokenError, SyntaxError) as e:
            return [(0, f'（解析不了，檢查器沒辦法掃：{e}）')]
        for t in toks:
            if t.type != tokenize.STRING:
                continue
            prefix = re.match(r'[rRbBuUfF]*', t.string).group(0).lower()
            body = t.string[len(prefix):]
            if (OVER2 if 'r' in prefix else OVER4).search(body):
                out.append((t.start[0], lines[t.start[0] - 1]))
    elif name.endswith('.sh'):
        out = [(i, l) for i, l in enumerate(lines, 1)
               if not is_comment(l) and re.search(r'\b(grep|sed)\b', l) and OVER2.search(l)]
    else:
        for i, l in enumerate(lines, 1):
            if l.lstrip().startswith(('//', '*')):
                continue
            if OVER4.search(l) or any(OVER2.search(m.group(1)) for m in JS_RE_LIT.finditer(l)):
                out.append((i, l))
    return out


RULES = {
    'overescape': r_overescape,
    'pipe': r_pipe,
    'swallow': r_swallow,
    'plushdr': r_plushdr,
    'formatonly': r_formatonly,
    'absent': r_absent,
    'backslash': r_backslash,
}

# ---- 對照組：每一種至少一段當場組出來的壞寫法＋這兩天真的出過事的原文；反例不能被抓 ----
BAR = '|'
CONTROLS = {
    'pipe': [
        ('x.sh', 'python scripts/selfcheck_public.py > "$LOG" 2>&1 ' + BAR + ' tail -1'),                       # 合成：自查接管線
        ('x.sh', 'git fetch -q origin main ' + BAR + ' cat'),                                                    # 合成：取遠端接管線
        ('x.sh', 'python "$SELF/u7.py" && GIT_TERMINAL_PROMPT=0 timeout 90 git -c credential.helper=x push origin main 2>&1 ' + BAR + ' tail -1'),  # 2026-09-23 本 App 真實的舊推送行（節錄）
    ],
    'swallow': [
        ('x.sh', 'python scripts/selfcheck_public.py ' + BAR * 2 + ' true'),                                     # 合成
        ('x.py', 'try:\n    x = 1\nexcept Exception:\n    pass'),                                              # 合成
        ('x.mjs', 'try { a() } catch (e) {}'),                                                                 # 合成
    ],
    'plushdr': [
        ('x.py', "added = [l[1:] for l in diff.split('\\n') if l.startswith('+') and not l.startswith('" + P3 + "')]"),  # 2026-09-24 以前本 App 真實的抽法
        ('x.sh', "grep -v '^" + P3 + "' diff.txt"),                                                            # 合成
    ],
    'formatonly': [
        ('x.py', "rc, patch = git('log', '--format=', '-p', '-U0', '--no-color', f'{base}..HEAD')"),          # 2026-09-23 v7 那版本 App 真實的自查（沒取 %B、%ae）
    ],
    'absent': [
        ('x.sh', 'grep -q "舊的登記" reg.txt && die "登記還在"'),                                                # 合成
        ('x.sh', '[ ! -e reg.txt ] && echo 已刪除'),                                                            # 合成
    ],
    'backslash': [
        ('x.sh', "grep -q '\\.org' out.txt"),                                                                  # 合成
        ('x.sh', "sed -i \"s/+ '\\.org'/+ '.o'/\" scripts/selfcheck_public.py"),                                # 本 App 驗法裡真實的一行
    ],
    'overescape': [   # 全部當場組出來（每一種語言、每一個分支各一條）
        ('x.py', "PAT = re.compile(r'" + BS * 2 + "d+')"),                   # Python 原始字串多跳脫
        ('x.py', "PAT = re.compile('" + BS * 4 + "s+')"),                    # Python 一般字串多跳脫
        ('x.mjs', 'const RE = /^' + BS * 2 + 'w+$/;'),                       # JS regex 字面多跳脫
        ('x.mjs', "const RE = new RegExp('" + BS * 4 + "d');"),              # JS 字串多跳脫
        ('x.sh', "grep -E '" + BS * 2 + "s+' out.txt"),                      # shell 樣式多跳脫
    ],
}
NEGATIVES = [   # 合法寫法：任何一種都不該抓
    ('x.sh', 'git push -q origin main && git fetch -q origin main ' + BAR * 2 + ' die "推送失敗"'),
    ('x.sh', '# 會決定成敗的指令一律不接管線，例如不要寫 git push ' + BAR + ' tail -1'),
    ('x.py', "        if line.startswith('diff --git '):"),
    ('x.py', "rc, meta_raw = git('log', '--format=%an%n%ae%n%cn%n%ce%n%B%x00', f'{base}..HEAD')\nrc, patch = git('log', '--format=', '-p')"),
    ('x.sh', 'grep -E "SELF-CHECK FAILED" out.txt'),
    ('x.sh', 'git show HEAD:scripts/selfcheck_public.py ' + BAR + ' grep -q foo ' + BAR * 2 + ' die "x"'),   # 2026-09-24 第一版誤抓過：檔名在路徑裡不等於在跑自查
    ('x.py', "A = re.compile(r'" + BS + "d+')\nB = '" + BS * 2 + "d'\nC = r'[/" + BS * 2 + "]'"),   # 正確的跳脫；比對字面反斜線的 [/\\]
    ('x.mjs', 'const A = /' + BS + 'd+/; const B = new RegExp("' + BS * 2 + 'd");'),                  # 正確的跳脫
]

# ---- 登記的例外：(檔, 規則, 那一行裡的一段固定字串, 理由)。每一條都必須在這次掃描裡命中 ----
EXCEPTIONS = [
    # 2026-09-24 J5 之後重新盤過：舊的 7 條（nofetch／nocheck 的恆真斷言、三行 grep／sed 樣式含反斜線、舊寫法的突變）
    # 已經隨程式改掉而不再命中、刪除。下面每一條都是這一版實際命中之後才補登的（例外不預寫）。
    ('scripts/pushsafe.sh', 'absent', 'if [ ! -f "$REG" ]',
     '「登記檔不存在就停」：方向是故障時停下，不是斷言「某東西不見了」；驗法情境 15 守著（刪掉登記 → 停、理由對）'),
    ('scripts/test_pushsafe.sh', 'absent', 'grep -qF -- "$s" "$f" && return 1',
     'reason_ok 的「不該出現」分支；驗法開頭有對照組（sample1 帶了不該出現的句子，必須被擋），同一次執行裡先驗過'),
    ('scripts/test_pushsafe.sh', 'plushdr', "pyedit $SC 'added = extract_added(patch)' \"added = [l[1:]",
     '驗法 oldparse 突變：故意把舊抽法寫進暫存複本的自查，這一行就是那段壞寫法的樣本'),
    ('scripts/test_pushsafe.sh', 'absent', "mutate $PS 'if [ ! -f \"$REG\" ]; then'",
     '驗法 noregistry 突變的錨點字串（確認改壞之前那段在），不是斷言'),
    ('scripts/test_pushsafe.sh', 'absent', "pyedit $PS 'if [ ! -f \"$REG\" ]; then' 'if [ ! -f \"$REG\" ] && false; then'",
     '驗法 noregistry 突變的改檔指令（錨點字串），不是斷言'),
    ('scripts/test_pushsafe.sh', 'absent', "confirm_mutated $PS 'if [ ! -f \"$REG\" ]; then'",
     '驗法 noregistry 突變的確認（改壞之後那段不在），前面 mutate 已先確認它原本在'),
]


# ---- 孤兒檢查（J9，共用慣例 v9 F4）：專案裡寫了推送指令、卻沒登記進 TARGETS 的腳本，一律報出來 ----
PUSH_CMD = re.compile(r'\bgit\b[^\n#]*\spush\b')
SCRIPT_EXT = ('.sh', '.py', '.mjs', '.js', '.cjs')
# 登記的「不是目標」：每一條都要寫理由，而且這次必須真的含推送指令（沒命中也算失敗，免得清單默默過期）
ORPHAN_EXEMPT = {
    'scripts/lint_gate.py': '掃描器本身：對照組樣本字串裡有推送指令，不是真的在推',
}


def push_scripts(files):
    """files：[(路徑, 內容)]。回傳內容裡有推送指令（不算註解行）的路徑。"""
    out = set()
    for name, text in files:
        if not name.endswith(SCRIPT_EXT):
            continue
        if any(PUSH_CMD.search(l) for l in text.split('\n') if not is_comment(l)):
            out.add(name)
    return out


def orphan_check():
    import subprocess
    r1 = subprocess.run(['git', '-c', 'core.quotepath=false', 'ls-files'], cwd=ROOT, capture_output=True)
    r2 = subprocess.run(['git', '-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'], cwd=ROOT, capture_output=True)
    if r1.returncode != 0 or r2.returncode != 0:
        return None, '取不到檔案清單（git ls-files 失敗）'
    names = [n for n in (r1.stdout + r2.stdout).decode('utf-8').split('\n') if n.strip()]
    if not names:
        return None, '檔案清單是空的'
    files = []
    for n in names:
        if n.endswith(SCRIPT_EXT):
            try:
                files.append((n, open(os.path.join(ROOT, n), encoding='utf-8').read()))
            except OSError:
                pass   # 追蹤中但這次被刪掉的檔：沒有內容就沒有推送指令
    found = push_scripts(files)
    orphans = sorted(found - set(TARGETS) - set(ORPHAN_EXEMPT))
    stale = sorted(set(ORPHAN_EXEMPT) - found)
    return (orphans, stale, len(files), [n for n, _t in files]), None


def escape_orphans(script_names):
    """專案裡的腳本（追蹤中＋沒被 gitignore 的新檔）沒登記進 ESCAPE_TARGETS 的。"""
    return sorted(n for n in script_names if n.endswith(SCRIPT_EXT) and n not in ESCAPE_TARGETS)


def run_rule(rule, name, text):
    return RULES[rule](name, text.split('\n'))


def main():
    bad = []
    # 1) 對照組：每一條都要被對應的規則抓到
    for rule, samples in CONTROLS.items():
        for name, text in samples:
            if not run_rule(rule, name, text):
                bad.append(f'對照組沒命中：{rule} 抓不到 {text[:60]!r}（檢查器壞了）')
    # 2) 反例：任何規則都不能抓
    for name, text in NEGATIVES:
        for rule in RULES:
            if run_rule(rule, name, text):
                bad.append(f'反例被誤抓：{rule} 抓了 {text[:60]!r}（檢查器壞了）')
    # 孤兒檢查的對照組：當場組出來的兩份假腳本，一份有推送指令（必須抓到）、一份只在註解提到（不能抓）
    fake = [('scripts/x_new.sh', 'echo hi\ngit -c a=b push origin main\n'),
            ('scripts/y_note.sh', '# 不要直接 git push，一律用閘門\necho hi\n'),
            ('docs/z.md', 'git push origin main')]
    got = push_scripts(fake)
    if got != {'scripts/x_new.sh'}:
        bad.append(f'孤兒檢查的對照組不對：抓到 {sorted(got)}，應該只有 scripts/x_new.sh（檢查器壞了）')
    # 跳脫掃描的孤兒檢查對照組：一支沒登記的新腳本必須被報出來；登記過的、不是腳本的不能報
    eo = escape_orphans(['scripts/new_tool.py', 'js/views/new_view.js', ESCAPE_TARGETS[0], 'docs/a.md'])
    if eo != ['js/views/new_view.js', 'scripts/new_tool.py']:
        bad.append(f'孤兒檢查的對照組不對：跳脫掃描抓到 {eo}，應該是兩支沒登記的新腳本（檢查器壞了）')
    n_controls = sum(len(v) for v in CONTROLS.values())
    print(f'對照組 {n_controls} 條、反例 {len(NEGATIVES)} 條：{"全部符合" if not bad else "有問題"}')
    if bad:
        for b in bad:
            print('  ', b)
        print('LINT-GATE FAILED: 檢查器本身的對照組不過，這次的掃描結果不可信')
        return 1

    # 2) 掃登記的檔
    used = set()
    unexpected = []
    total_lines = 0
    scan = list(TARGETS) + [f for f in ESCAPE_TARGETS if f not in TARGETS]
    for f in scan:
        rules = RULES if f in TARGETS else {k: RULES[k] for k in ESCAPE_RULES}   # 閘門三支掃全部；其他腳本掃跳脫類
        path = os.path.join(ROOT, f)
        try:
            text = open(path, encoding='utf-8').read()
        except OSError as e:
            print(f'LINT-GATE FAILED: 讀不到登記的檔 {f}（{e}）')
            return 1
        lines = text.split('\n')
        if not text.strip():
            print(f'LINT-GATE FAILED: 登記的檔 {f} 是空的')
            return 1
        total_lines += len(lines)
        for rule, fn in rules.items():
            for i, line in fn(f, lines):
                ex = [k for k, e in enumerate(EXCEPTIONS) if e[0] == f and e[1] == rule and e[2] in line]
                if ex:
                    used.update(ex)
                else:
                    unexpected.append((f, i, rule, line.strip()))
    if set(scan) != set(TARGETS) | set(ESCAPE_TARGETS) or not set(TARGETS) <= set(ESCAPE_TARGETS):
        print(f'LINT-GATE FAILED: 實際掃到的檔（{len(set(scan))} 支）不等於登記的（閘門 {len(TARGETS)}＋跳脫 {len(ESCAPE_TARGETS)}），'
              f'或閘門有檔沒登記進跳脫掃描（檢查器壞了）')
        return 1
    print(f'掃了 {len(scan)} 支檔（閘門 {len(TARGETS)} 支掃全部規則、其餘 {len(scan) - len(TARGETS)} 支掃跳脫類）、共 {total_lines} 行；'
          f'登記的例外命中 {len(used)}／{len(EXCEPTIONS)} 條')
    stale = [e for k, e in enumerate(EXCEPTIONS) if k not in used]
    res, err = orphan_check()
    if err:
        print(f'LINT-GATE FAILED: 孤兒檢查{err}（檢查器壞了）')
        return 1
    orphans, orphan_stale, n_scripts, script_names = res
    eorph = escape_orphans(script_names)
    print(f'孤兒檢查：看了 {n_scripts} 支腳本，有推送指令卻沒登記的 {len(orphans)} 支、沒登記進跳脫掃描的 {len(eorph)} 支')
    for o in orphans:
        unexpected.append((o, 0, 'orphan', '有推送指令，卻沒登記進 TARGETS（也沒登記成「不是目標」）'))
    for o in eorph:
        unexpected.append((o, 0, 'escape-orphan', '新腳本沒登記進 ESCAPE_TARGETS（跳脫類的掃描掃不到它）'))
    stale = stale + [(o, 'orphan', '登記成「不是目標」但這次沒有推送指令', '') for o in orphan_stale]
    for f, i, rule, line in unexpected:
        print(f'  命中（沒登記）：{f}:{i} [{rule}] {line[:140]}')
    for e in stale:
        print(f'  登記的例外沒命中（過期了？）：{e[0]} [{e[1]}] {e[2]!r}')
    if unexpected or stale:
        print('LINT-GATE FAILED: ' + '；'.join(
            ([f'{len(unexpected)} 處已知的壞寫法'] if unexpected else []) + ([f'{len(stale)} 條例外過期'] if stale else [])))
        return 1
    print('LINT-GATE OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
