"""從 .logs/ 的閘門突變 log 產生入庫的證據檔（共用慣例 v11.4 §5.7「入庫的證據要能複核」）。

用法：python scripts/mkevidence_mut.py --out docs/evidence/<檔名>.tsv [--summary 摘要檔 …] [--expect scripts/mutation-expect.tsv] log …
回傳值：0＝寫好了；1＝母體檢查不過、清洗的對照組不過、或預期表讀不到（都不寫檔）；2＝用法錯；
        3＝預期清單過期（預期表裡的突變或情境在現在的驗法裡不存在，行首「MKEVIDENCE STALE-EXPECT:」，不寫檔）。
什麼時候跑：每一次跑完閘門突變（單條或整套），把那一次的 log 交給它，產生的證據檔 commit 進 repo。

- 一個 log＝一次 `TEST_PUSHSAFE_MUTATE=<名稱> bash scripts/test_pushsafe.sh` 的完整輸出。逐項：每一個 log 一行。
- 分類只看行首（v11.4 §5.20：不用子字串比對；證據行縮排、不在行首）：
    情境未成立：有行首「ABORT: 」、或沒有行首「MUTATION ACTIVE: 」、或沒有行首「TEST-PUSHSAFE: 」（崩潰、逾時、被殺都長這樣）——
               不算紅、不算過、不算數；
    全部符合：「TEST-PUSHSAFE: 全部符合，但這一輪是突變」——沒有任何一個情境紅（等價突變或測試無力，要人判斷）；
    紅：「TEST-PUSHSAFE: 有不符合預期的情況」——實際紅的情境＝行首「no 」那幾行的編號；其中「擋下理由不對」另列（紅錯地方的線索）。
- 預期讀進版控的預期表（scripts/mutation-expect.tsv）：對全部情境的完整劃分——每條突變一列、每個情境一格「紅／不紅」，
  格數必須等於從 LIST 數出來的情境數（不寫死）；判定分「符合預期／不符預期」，不符的另列「預期不紅卻紅」「預期紅卻沒紅」。
- 證據檔每一格只放結構化的欄位（名稱、分類、情境編號、秒數、log 檔名），不放自由文字；每一格仍過一次清洗（路徑、使用者名稱）。
  清洗配雙向對照組：含路徑的樣本必須被洗掉路徑；分類、預期、實際那幾格洗過之後必須一字不變。對照組不過就不寫檔。
- 母體檢查：證據檔的資料行數＝交進來的 log 數，不等就點名、回 1、不寫檔。
- 耗時：從 --summary 指定的摘要檔讀「<名稱> rc=<數字> 秒=<數字>」那種行（本 App 跑突變時的寫法）；沒有就寫「未記」。耗時數字進版控（§5.7）。
"""
import argparse
import io
import os
import re
import sys


HEADER = ['名稱', '分類', '判定', '預期類別', '預期紅', '實際紅', '預期不紅卻紅', '預期紅卻沒紅', '其中擋下理由也不對', '秒數', 'log']


def classify(text):
    """回傳 (名稱或 None, 分類, 實際紅的情境 list, 擋下理由不對的情境 list)。只看行首。"""
    lines = text.splitlines()
    active = [l for l in lines if l.startswith('MUTATION ACTIVE: ')]
    name = active[0][len('MUTATION ACTIVE: '):].split('（', 1)[0].strip() if len(active) == 1 else None
    abort = any(l.startswith('ABORT: ') for l in lines)
    end = [l for l in lines if l.startswith('TEST-PUSHSAFE: ')]
    reds = sorted({l.split()[1] for l in lines if l.startswith('no ') and len(l.split()) > 1})
    wrong = sorted({l.split()[1] for l in lines if l.startswith('no ') and len(l.split()) > 1 and '擋下理由不對' in l})
    if abort or name is None or len(end) != 1:
        return name, '情境未成立', [], []
    if end[0].startswith('TEST-PUSHSAFE: 全部符合，但這一輪是突變'):
        return name, '全部符合', [], []
    if end[0].startswith('TEST-PUSHSAFE: 有不符合預期的情況'):
        return name, '紅', reds, wrong
    return name, '情境未成立', [], []   # 結尾是別的樣子（例：沒有突變的正常一輪）＝不是這裡要的那一種


USER = os.environ.get('USERNAME') or os.environ.get('USER') or ''
BS = chr(92)
PATH_RE = re.compile(r'(?<![A-Za-z])[A-Za-z]:[' + re.escape(BS) + r'/][^\s\t]*|/[a-z]/[^\s\t]*|[' + re.escape(BS) + r'/][Uu]sers[' + re.escape(BS) + r'/][^\s\t]*')


def clean(cell):
    s = PATH_RE.sub('〔路徑〕', cell)
    if USER:
        s = s.replace(USER, '〔使用者〕')
    return s.replace('\t', ' ').replace('\n', ' ')


def clean_controls():
    """雙向對照組：含路徑／使用者名稱的要被洗掉；分類、預期、實際那幾格必須一字不變。回傳不符的清單。"""
    bad = []
    dirty = ['E' + ':' + BS + 'work' + BS + 'x.log', '/c/' + 'Users/someone/x.log', BS + 'Users' + BS + 'a' + BS + 'b',
             'log at ' + 'E' + ':' + '/tmp/y.log']
    if USER:
        dirty.append('owner ' + USER + ' here')
    for d in dirty:
        c = clean(d)
        if PATH_RE.search(c) or (USER and USER in c) or '〔' not in c:
            bad.append(f'清洗沒洗掉：{d!r} → {c!r}')
    keep = ['情境未成立', '全部符合', '紅', '03,08,17,18', '09,10', 'nofetch', 'oldparse+nocheck', '未登記', '254', '未記',
            'mut5-2026-10-02-a90f4c3.nofetch.log']
    for k in keep:
        if clean(k) != k:
            bad.append(f'清洗洗掉了不該洗的：{k!r} → {clean(k)!r}')
    return bad


# ---- 預期清單過期的前置檢查（Dispatch 2026-10-02：四家各踩一次；過期的樣子是「不如預期」或「多紅了別組」，
#      很容易被讀成程式有問題、去修一個沒壞的東西）。預期表裡的每一項都要在「現在的」驗法裡存在：
#      突變名稱要在 test_pushsafe.sh 的 case 分支裡、預期紅的情境要在 LIST 裡。不存在就報「預期清單過期」，獨立訊息、回 3。
def current_population(tps_text):
    """回傳 (突變名稱集合, 情境集合, 問題清單)。突變名稱以 case 區塊實際的分支為準，並跟檔頭列的清單互相核對。"""
    probs = []
    block = re.search(r'^case "\$MUTATE" in\n(.*?)^esac', tps_text, re.M | re.S)
    names = set()
    if block:
        for m in re.finditer(r'^  ([a-z0-9+|]+)\)', block.group(1), re.M):
            names.update(x for x in m.group(1).split('|') if x)
    head = re.search(r'# 突變：([a-z0-9+ ]+)$', tps_text, re.M)
    listed = set(head.group(1).split()) if head else set()
    lst = re.search(r'^LIST="([^"]*)"\s*$', tps_text, re.M)
    scen = {x[1:] for x in lst.group(1).split()} if lst else set()   # s03 → 03（log 裡印的是 03）
    if not names:
        probs.append('讀不到 case 區塊的突變分支')
    if not scen:
        probs.append('讀不到 LIST')
    if names and listed and names != listed:
        probs.append(f'檔頭列的突變與 case 分支不一致：只在檔頭 {sorted(listed - names)}、只在分支 {sorted(names - listed)}')
    return names, scen, probs


RED, NOT_RED = '紅', '不紅'


def read_expect(path, scen, names):
    """讀預期表（對全部情境的完整劃分，Dispatch 2026-10-02）：
    第一行是表頭：名稱<TAB>類別<TAB>s01<TAB>…<TAB>sNN<TAB>依據；之後每條突變一列，每一個情境一格「紅」或「不紅」。
    回傳 (expect, 過期的問題, 格式的問題)。expect＝{名稱: (類別, 預期紅的情境 list, 依據)}。
    過期（回 3）：表頭的情境欄≠現在的 LIST（後來加的情境沒有欄＝每一條都沒表態）、列裡有已經不存在的突變、有突變沒有列。
    格式（回 1）：某一列的格數不等於情境數、某一格不是「紅／不紅」、同一條突變兩列。"""
    lines = [l for l in open(path, encoding='utf-8').read().splitlines() if l.strip() and not l.startswith('#')]
    if not lines:
        return {}, [], ['預期表是空的']
    head = lines[0].split('\t')
    cols = [c for c in head[2:-1]]
    stale, fmt, expect = [], [], {}
    if head[:2] != ['名稱', '類別'] or head[-1] != '依據':
        fmt.append(f'表頭不對：{head[:2]}…{head[-1:]}')
        return {}, stale, fmt
    want = ['s' + x for x in sorted(scen)]
    if cols != want:
        stale.append(f'表頭的情境欄跟現在的 LIST 不一樣：少了 {sorted(set(want) - set(cols))}、多了 {sorted(set(cols) - set(want))}'
                     f'（後來加的情境每一條突變都要回去表態）')
    for i, line in enumerate(lines[1:], 2):
        f = line.split('\t')
        name = f[0]
        cells = f[2:-1] if len(f) >= 3 else []
        if len(f) != len(head):
            fmt.append(f'第 {i} 行 {name}：{len(f)} 欄，表頭是 {len(head)} 欄（每一條都要對 {len(cols)} 個情境各表態一格）')
            continue
        badc = [cols[j] for j, c in enumerate(cells) if c not in (RED, NOT_RED)]
        if badc:
            fmt.append(f'第 {i} 行 {name}：這幾格不是「紅／不紅」：{badc}')
            continue
        if name in expect:
            fmt.append(f'第 {i} 行 {name}：同一條突變出現兩列')
            continue
        if name not in names:
            stale.append(f'{name}：驗法裡已經沒有這條突變')
        expect[name] = (f[1], [cols[j][1:] for j, c in enumerate(cells) if c == RED], f[-1])
    missing = sorted(names - set(expect))
    if missing and not fmt:
        stale.append(f'這幾條突變在驗法裡、預期表沒有列：{missing}')
    return expect, stale, fmt


def read_seconds(paths):
    """{(摘要檔的前綴, 名稱): 秒數}。前綴＝摘要檔名去掉「.summary」；一份 log 只對應同一個前綴的摘要
    （2026-10-02 試跑抓到：只用名稱對應時，後一次的摘要把前一次的蓋掉，8 秒的空跑被寫成 248 秒）。"""
    out = {}
    for p in paths or []:
        prefix = os.path.basename(p)
        prefix = prefix[:-len('.summary')] if prefix.endswith('.summary') else prefix
        for line in open(p, encoding='utf-8').read().splitlines():
            m = re.match(r'^(\S+) rc=\d+ 秒=(\d+)$', line)
            if m:
                out[(prefix, m.group(1))] = m.group(2)
    return out


def log_prefix(base, name):
    """log 檔名「<前綴>.<名稱>.log」的前綴；對不上就回 None。"""
    tail = '.' + name + '.log'
    return base[:-len(tail)] if base.endswith(tail) else None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--summary', action='append', help='跑突變時寫的摘要檔（「名稱 rc=… 秒=…」），可給多個')
    ap.add_argument('--expect', help='預期表；沒給就全部「未登記」')
    ap.add_argument('--verifier', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'test_pushsafe.sh'),
                    help='用來核對預期表沒過期的驗法（預設 repo 裡的 test_pushsafe.sh）')
    ap.add_argument('logs', nargs='+')
    a = ap.parse_args(argv)
    bad = clean_controls()
    if bad:
        for b in bad:
            print('  ', b)
        print('MKEVIDENCE FAILED: 清洗的對照組不過，不寫檔')
        return 1
    expect = {}
    if a.expect:
        try:
            names, scen, probs = current_population(open(a.verifier, encoding='utf-8').read())
        except OSError as e:
            print(f'MKEVIDENCE FAILED: 讀不到驗法 {a.verifier}（{e}），沒辦法核對預期表有沒有過期，不寫檔')
            return 1
        if probs:
            print('MKEVIDENCE FAILED: 驗法的母體讀不清楚：' + '；'.join(probs) + '（不寫檔）')
            return 1
        try:
            expect, stale, fmt = read_expect(a.expect, scen, names)
        except OSError as e:
            print(f'MKEVIDENCE FAILED: 預期表讀不到（{e}），不寫檔')
            return 1
        if fmt:
            for x in fmt:
                print('      ' + x)
            print(f'MKEVIDENCE FAILED: 預期表格式不對 {len(fmt)} 處（不寫檔）')
            return 1
        if stale:
            for x in stale:
                print('      ' + x)   # 證據行：6 格縮排，不在行首
            print(f'MKEVIDENCE STALE-EXPECT: 預期清單過期 {len(stale)} 處——先更新預期表，這不是「不如預期」（不寫檔）')
            return 3
    secs = read_seconds(a.summary)
    rows = []
    for lp in a.logs:
        try:
            text = open(lp, encoding='utf-8', errors='replace').read()
        except OSError as e:
            print(f'  讀不到 log：{os.path.basename(lp)}（{type(e).__name__}）——這一條沒有行，下面的母體檢查會擋')
            continue
        name, cls, reds, wrong = classify(text)
        base = os.path.basename(lp)
        if name is None:   # 沒有 MUTATION ACTIVE：名稱從檔名推（本 App 的檔名是 …<名稱>.log）
            name = base.rsplit('.', 2)[-2] if base.count('.') >= 2 else base
        ecls, ered_l, _basis = expect.get(name, ('未登記', None, ''))
        if ered_l is None or cls == '情境未成立':
            verdict, over, under = ('—' if cls == '情境未成立' else '未登記'), '-', '-'
        else:
            over = ','.join(x for x in reds if x not in ered_l) or '-'
            under = ','.join(x for x in ered_l if x not in reds) or '-'
            verdict = '符合預期' if over == '-' and under == '-' else '不符預期'
        ered = '未登記' if ered_l is None else (','.join(ered_l) or '-')
        sec = secs.get((log_prefix(base, name), name), '未記')
        row = [name, cls, verdict, ecls, ered, ','.join(reds) or '-', over, under, ','.join(wrong) or '-', sec, base]
        rows.append([clean(c) for c in row])
    if len(rows) != len(a.logs):
        print(f'MKEVIDENCE FAILED: 證據 {len(rows)} 行、交進來的 log {len(a.logs)} 個，不等，不寫檔')
        return 1
    body = '\t'.join(HEADER) + '\n' + ''.join('\t'.join(r) + '\n' for r in rows)
    if body.count('\n') - 1 != len(a.logs):
        print('MKEVIDENCE FAILED: 寫出去的資料行數跟 log 數不等，不寫檔')
        return 1
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    open(a.out, 'w', encoding='utf-8', newline='\n').write(body)
    n = {}
    for r in rows:
        n[r[1]] = n.get(r[1], 0) + 1
    print(f'MKEVIDENCE OK: {len(rows)} 條（' + '、'.join(f'{k} {v}' for k, v in sorted(n.items())) + f'）→ {a.out}')
    return 0


if __name__ == '__main__':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')   # 只在直接執行時重包（被 import 時重包會關掉對方的輸出）
    sys.exit(main())
