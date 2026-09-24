"""題庫建置與檢查的「缺檔、空的」情境測試（2026-09-24，Dispatch 交辦修 v9 盤點第 1、2 件）。

用法：python scripts/test_datacheck.py            # 用工作區的 build_data.py、check_data.py
      python scripts/test_datacheck.py --ref HEAD # 用某個 commit 的版本（證明修正前會紅）
回傳值：0＝全部符合；1＝有不符合；2＝造情境失敗而中止。
什麼時候跑：改過 scripts/build_data.py 或 scripts/check_data.py 就跑（約一兩分鐘；全部在暫存複本裡，repo 不動）。

母體是「每一組都跑一遍」：5 級 × 單字／文法 ＋ 3 類旅行，共 13 組——不挑一級當代表。
v9 盤點時發現：清空 N3 的來源檔會停，只是因為剛好有一條去重規則指到 N3；清空 N5（沒有去重規則）就放行了。

每一組四種情境，每一種都比對「擋下的理由點名了那一組」，不是只看回傳值：
  C-missing  刪掉輸出的 JSON                     → check_data 必須回非 0、點名那個檔
  C-empty    輸出清成 0 筆、manifest 也改成 0     → check_data 必須回非 0、點名那個檔
  B-empty    來源檔只留註解                       → build_data 必須回非 0、點名那個來源檔，而且 data/ 底下一個位元組都沒變
  B-missing  來源檔刪掉                           → 同上
另有基準：原樣資料 build 與 check 都必須回 0（正常情況要放行，§5.14）。
另有 J13 的 C-alldup／B-alldup（見下方註解），以及：
  B-writefail  每一個輸出檔（13 組＋搜尋索引＋manifest）各當一次「寫它的時候失敗」（F8）
               → build_data 必須回非 0、錯誤訊息點名那個檔，而且 data/ 一個位元組都沒變、沒留下 .tmp
  B-tmpdir     每一個輸出檔的暫存檔位置先放一個同名資料夾（寫不進去、也不該去刪）→ 同上，而且不能是錯誤堆疊
  B-cleanupfail 寫某個檔失敗、而且已寫好的一個暫存檔刪不掉 → 點名兩者、不能是錯誤堆疊、正式輸出不變

每一格三件事都要成立：回傳值非 0、**錯誤訊息區**（stderr 去掉「  ! 略過…」警告行）點名這個單位、
輸出目錄的雜湊前後相同。被別的規則碰巧擋下的（回非 0 但沒點名這個單位）一律算「沒擋」。
「前後相同」在母體是空的時候恆真，所以雜湊一個檔都沒掃到就中止。
"""
import argparse
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1']
TRAVEL = ['phrases', 'usage', 'kanji']
SETS = [('vocab', lv) for lv in LEVELS] + [('grammar', lv) for lv in LEVELS] + [('travel', c) for c in TRAVEL]


def rmtree(p):
    if os.path.exists(p):
        shutil.rmtree(p, onexc=lambda f, x, e: (os.chmod(x, stat.S_IWRITE), f(x)))


def out_rel(typ, key):
    return f'data/travel/{key}.json' if typ == 'travel' else f'data/{typ}/{key.lower()}.json'


def src_rel(typ, key):
    return f'data/src/travel.{key}.txt' if typ == 'travel' else f'data/src/{typ}.{key.lower()}.txt'


class Abort(Exception):
    pass


def data_digest(d, skip_tmp=False):
    """data/ 底下（不含 src）每一個檔的內容雜湊與檔數——用來確認建置失敗時一個檔都沒被寫、也沒留下暫存檔。
    skip_tmp：不算 .tmp 結尾的檔（只比正式輸出）。
    「前後相同」在母體是空的時候恆真（data/ 不見了，前後都是空的雜湊），所以一個檔都沒掃到就中止。"""
    h = hashlib.sha1()
    n = 0
    base = os.path.join(d, 'data')
    for dirpath, dirnames, files in sorted(os.walk(base)):
        dirnames[:] = sorted(x for x in dirnames if x != 'src')
        for f in sorted(files):
            p = os.path.join(dirpath, f)
            if skip_tmp and f.endswith('.tmp'):
                continue
            h.update(os.path.relpath(p, base).replace('\\', '/').encode())
            h.update(open(p, 'rb').read())
            n += 1
    if n == 0:
        raise Abort(f'data/ 底下一個檔都沒掃到（{base}），「前後相同」會恆真')
    return h.hexdigest(), n


def tmp_files(d):
    """data/ 底下（不含 src）留著的 .tmp 檔（相對 data/ 的路徑）。"""
    base = os.path.join(d, 'data')
    out = []
    for dirpath, dirnames, files in os.walk(base):
        dirnames[:] = [x for x in dirnames if x != 'src']
        out += [os.path.relpath(os.path.join(dirpath, f), base).replace('\\', '/') for f in files if f.endswith('.tmp')]
    return sorted(out)


def err_region(stderr):
    """錯誤訊息的位置：stderr 去掉「  ! 略過…」這類警告行。
    正常輸出（stdout）會列出每一組的檔名，警告行也會出現組名——只數「整份輸出有沒有出現」，
    被別的規則擋下、或根本沒擋，都可能被誤判成「點名了這一組」。"""
    return '\n'.join(l for l in stderr.split('\n') if not l.startswith('  ! '))


def run(d, script, *argv):
    """回傳（回傳值, 錯誤訊息區）。"""
    r = subprocess.run([sys.executable, f'scripts/{script}', *argv], cwd=d, capture_output=True)
    return r.returncode, err_region(r.stderr.decode('utf-8', 'replace'))


def names(out, *needles):
    """擋下的理由有沒有點名那一組：每個 needle 都要出現在錯誤訊息區（run() 回傳的第二個值）。"""
    return all(n in out for n in needles)


# 「寫到一半失敗」的注入器：讓寫某一個輸出檔（或它的 .tmp）時丟 OSError，其他照常。
# 新舊兩版都經過 Path.write_text，所以同一個注入對兩版都有效；錯誤訊息故意不帶檔名，點名只能靠 build_data 自己。
# 真的注入到了才寫 _injected.txt（在 data/ 外面），沒寫就表示情境沒造成。
INJECT = '''import pathlib, runpy, sys
target = sys.argv[1]
lock = sys.argv[2] if len(sys.argv) > 2 else ''
_orig = pathlib.Path.write_text
def _wt(self, *a, **k):
    rel = self.as_posix()
    if rel.endswith('/data/' + target) or rel.endswith('/data/' + target + '.tmp'):
        open('_injected.txt', 'w').write('yes')
        raise OSError(28, 'simulated write failure')
    return _orig(self, *a, **k)
pathlib.Path.write_text = _wt
_ou = pathlib.Path.unlink
def _ul(self, *a, **k):
    if lock and self.as_posix().endswith('/data/' + lock + '.tmp'):
        open('_unlink_blocked.txt', 'w').write('yes')
        raise PermissionError(13, 'simulated locked file')
    return _ou(self, *a, **k)
pathlib.Path.unlink = _ul
sys.argv = ['scripts/build_data.py']
runpy.run_path('scripts/build_data.py', run_name='__main__')
'''
OUTPUTS = [out_rel(t, k).split('data/', 1)[1] for t, k in SETS] + ['search-index.json', 'manifest.json']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', help='用這個 commit 的 build_data.py 與 check_data.py')
    args = ap.parse_args()

    # §5.11 第二層：比對函式自己的對照組
    assert names('缺檔：data/vocab/n5.json', 'vocab/n5.json'), '比對函式抓不到已知的句子'
    assert not names('缺檔：data/vocab/n4.json', 'vocab/n5.json'), '比對函式把 n4 當成 n5'
    sample = '  ! 略過格式不足的行 (vocab N4): x\n建置中止：以下各組沒有任何有效資料——\n  vocab N3（有效 0 筆）'
    assert names(err_region(sample), 'vocab N3'), '錯誤訊息區抓不到錯誤訊息裡的組名'
    assert not names(err_region(sample), 'vocab N4'), '錯誤訊息區把警告行裡的組名當成擋下理由'
    print('比對函式的對照組：4/4 符合')

    tmp = tempfile.mkdtemp()
    os.makedirs(os.path.join(tmp, 'empty', 'data', 'src'))   # 只有 src、沒有任何輸出檔
    try:
        data_digest(os.path.join(tmp, 'empty'))
        print('ABORT：雜湊函式在一個檔都沒有時沒有中止（「前後相同」會恆真）'); return 2
    except Abort:
        print('雜湊函式的對照組：空的 data/ 會中止')
    base = os.path.join(tmp, 'base')
    os.makedirs(os.path.join(base, 'scripts'))
    shutil.copytree(os.path.join(ROOT, 'data'), os.path.join(base, 'data'))
    for s in ('build_data.py', 'check_data.py'):
        if args.ref:
            r = subprocess.run(['git', 'show', f'{args.ref}:scripts/{s}'], cwd=ROOT, capture_output=True)
            if r.returncode != 0:
                print(f'ABORT：取不到 {args.ref}:scripts/{s}')
                return 2
            open(os.path.join(base, 'scripts', s), 'wb').write(r.stdout)
        else:
            shutil.copy(os.path.join(ROOT, 'scripts', s), os.path.join(base, 'scripts', s))
    print(f'被測的版本：{"commit " + args.ref if args.ref else "工作區"}')

    bad = 0

    def report(ok, name, detail):
        nonlocal bad
        if not ok:
            bad = 1
        print(f'{"yes" if ok else "no ":4s} {name:34s} {detail}')

    def fresh():
        w = os.path.join(tmp, 'w')
        rmtree(w)
        shutil.copytree(base, w)
        return w

    # 基準：原樣資料要放行
    w = fresh()
    rc_b, out_b = run(w, 'build_data.py')
    rc_c, out_c = run(w, 'check_data.py')
    report(rc_b == 0 and rc_c == 0, '基準：原樣資料 build＋check', f'build rc={rc_b}、check rc={rc_c}')
    if rc_b != 0 or rc_c != 0:
        print('ABORT：原樣資料就不過，後面的情境沒有意義')
        return 2

    for typ, key in SETS:
        orel, srel = out_rel(typ, key), src_rel(typ, key)
        short = orel.split('data/', 1)[1]           # 例：vocab/n5.json
        sshort = os.path.basename(srel)             # 例：vocab.n5.txt

        # C-missing
        w = fresh(); p = os.path.join(w, orel)
        if not os.path.exists(p):
            print(f'ABORT：{orel} 原本就不存在，造不出「刪掉」'); return 2
        os.remove(p)
        rc, out = run(w, 'check_data.py')
        report(rc != 0 and names(out, short), f'C-missing {short}', f'rc={rc}' + ('' if names(out, short) else '（輸出沒點名這個檔）'))

        # C-empty：輸出清成 0 筆、manifest 也改成 0（前後一致的空）
        w = fresh(); p = os.path.join(w, orel)
        j = json.load(open(p, encoding='utf-8'))
        if not j.get('items'):
            print(f'ABORT：{orel} 原本就是空的'); return 2
        j['items'] = []; j['count'] = 0
        if 'activeCount' in j:
            j['activeCount'] = 0
        json.dump(j, open(p, 'w', encoding='utf-8'), ensure_ascii=False)
        m = os.path.join(w, 'data/manifest.json'); mj = json.load(open(m, encoding='utf-8'))
        hit = 0
        for s in (mj['travel']['sets'] if typ == 'travel' else mj['sets']):
            if (typ == 'travel' and s.get('cat') == key) or (s.get('type') == typ and s.get('level') == key):
                s['count'] = 0; hit += 1
                if 'activeCount' in s:
                    s['activeCount'] = 0
        if hit != 1:
            print(f'ABORT：manifest 裡找不到 {typ} {key} 那一組'); return 2
        json.dump(mj, open(m, 'w', encoding='utf-8'), ensure_ascii=False)
        rc, out = run(w, 'check_data.py')
        report(rc != 0 and names(out, short), f'C-empty   {short}', f'rc={rc}' + ('' if names(out, short) else '（輸出沒點名這個檔）'))

        # B-empty：來源檔只留註解
        w = fresh(); p = os.path.join(w, srel)
        lines = open(p, encoding='utf-8').read().split('\n')
        if not any(l.strip() and not l.startswith('#') for l in lines):
            print(f'ABORT：{srel} 原本就沒有資料列'); return 2
        open(p, 'w', encoding='utf-8').write('\n'.join(l for l in lines if l.startswith('#')) + '\n')
        before = data_digest(w)
        rc, out = run(w, 'build_data.py')
        same = data_digest(w) == before
        report(rc != 0 and names(out, sshort) and same, f'B-empty   {sshort}',
               f'rc={rc}' + ('' if names(out, sshort) else '（輸出沒點名這個來源檔）') + ('' if same else '（data/ 被改動了）'))

        # B-missing：來源檔刪掉
        w = fresh(); p = os.path.join(w, srel)
        os.remove(p)
        before = data_digest(w)
        rc, out = run(w, 'build_data.py')
        same = data_digest(w) == before
        report(rc != 0 and names(out, sshort) and same, f'B-missing {sshort}',
               f'rc={rc}' + ('' if names(out, sshort) else '（輸出沒點名這個來源檔）') + ('' if same else '（data/ 被改動了）'))

    # ---- J13：一組有筆數、但全被標成跨級別重複（有效 0 筆）----
    # C-alldup：JLPT 10 組各一個——每一筆標 dup、dupOf 指到另一組真的存在的 id，json 與 manifest 的 activeCount 都改成 0（前後一致）。
    #   旅行 3 組不適用：旅行的載入不看 dup（js/data.js loadTravel），標了也照樣出題，不存在「全被隱藏」。
    # B-alldup：N4～N1 共 8 組各一個——那一組的來源換成從 N5 複製來的 3 行，dedup.txt 換成只有這 3 條規則。
    #   成對對照 B-alldup-ok：同樣的造法只寫 2 條規則（留 1 筆有效）→ 必須放行。
    #   N5 與旅行不適用：去重只會把「較高級別」標成重複，N5 沒有更低的級別；旅行不走去重。
    for typ, key in [s for s in SETS if s[0] != 'travel']:
        orel = out_rel(typ, key)
        short = orel.split('data/', 1)[1]
        w = fresh(); p = os.path.join(w, orel)
        j = json.load(open(p, encoding='utf-8'))
        other = 'data/vocab/n4.json' if short == 'vocab/n5.json' else 'data/vocab/n5.json'
        keeper = json.load(open(os.path.join(w, other), encoding='utf-8'))['items'][0]['id']
        for it in j['items']:
            it['dup'] = True; it['dupOf'] = keeper
        j['activeCount'] = 0
        json.dump(j, open(p, 'w', encoding='utf-8'), ensure_ascii=False)
        m = os.path.join(w, 'data/manifest.json'); mj = json.load(open(m, encoding='utf-8'))
        for s in mj['sets']:
            if s.get('type') == typ and s.get('level') == key:
                s['activeCount'] = 0
        json.dump(mj, open(m, 'w', encoding='utf-8'), ensure_ascii=False)
        rc, out = run(w, 'check_data.py')
        report(rc != 0 and names(out, short, '有效 0 筆'), f'C-alldup  {short}',
               f'rc={rc}' + ('' if names(out, short, '有效 0 筆') else '（輸出沒點名「這一組有效 0 筆」）'))

    for typ, key in [s for s in SETS if s[0] != 'travel' and s[1] != 'N5']:
        srel = src_rel(typ, key)
        sshort = f'{typ} {key}'
        for keep_one in (False, True):
            w = fresh()
            n5 = open(os.path.join(w, src_rel(typ, 'N5')), encoding='utf-8').read().split('\n')
            rows = [l for l in n5 if l.strip() and not l.startswith('#')][:3]
            if len(rows) != 3:
                print(f'ABORT：N5 {typ} 取不到 3 行'); return 2
            open(os.path.join(w, srel), 'w', encoding='utf-8').write('\n'.join(rows) + '\n')
            rules = []
            for l in rows:
                c = [x.strip() for x in l.split('|')]
                rules.append(f'{key} | v | {c[0]} | {c[1]}' if typ == 'vocab' else f'{key} | g | {c[0]} |')
            if keep_one:
                rules = rules[:2]
            open(os.path.join(w, 'data/src/dedup.txt'), 'w', encoding='utf-8').write('\n'.join(rules) + '\n')
            before = data_digest(w)
            rc, out = run(w, 'build_data.py')
            same = data_digest(w) == before
            if keep_one:
                report(rc == 0, f'B-alldup-ok {sshort}（留 1 筆，要放行）', f'rc={rc}')
            else:
                ok = rc != 0 and names(out, sshort, '有效 0 筆') and same
                report(ok, f'B-alldup  {sshort}',
                       f'rc={rc}' + ('' if names(out, sshort, '有效 0 筆') else '（輸出沒點名「這一組有效 0 筆」）')
                       + ('' if same else '（data/ 被改動了）'))

    # ---- B-writefail：資料沒問題、寫到一半失敗（F8「先寫暫存檔，全部成功才一起換上」）----
    # 母體：每一個輸出檔（13 組＋搜尋索引＋manifest）都當一次「寫它的時候失敗」。
    # 先把每個輸出檔改成過期的內容：只要有任何一個檔被寫成新的，data/ 的雜湊就會變（否則新舊內容一樣、看不出半新半舊）。
    for rel in OUTPUTS:
        w = fresh()
        for r2 in OUTPUTS:
            p2 = os.path.join(w, 'data', r2)
            if not os.path.exists(p2):
                print(f'ABORT：data/{r2} 原本就不存在'); return 2
            open(p2, 'w', encoding='utf-8').write(f'STALE {r2}\n')
        open(os.path.join(w, 'scripts', '_inject.py'), 'w', encoding='utf-8').write(INJECT)
        before = data_digest(w)
        rc, out = run(w, '_inject.py', rel)
        if not os.path.exists(os.path.join(w, '_injected.txt')):
            print(f'ABORT：寫 data/{rel} 的失敗沒有注入到（情境沒造成）'); return 2
        same = data_digest(w) == before
        report(rc != 0 and names(out, rel) and same, f'B-writefail {rel}',
               f'rc={rc}' + ('' if names(out, rel) else '（錯誤訊息沒點名這個檔）') + ('' if same else '（data/ 被改動了：一半新一半舊或留下暫存檔）'))

    # ---- 清理那一步本身失敗（2026-09-24 統籌者驗收時抓到）：清理要逐個失敗不中斷、把清不掉的也報出來，
    # 最後仍要走到「點名是哪個檔」那句，不能變成錯誤堆疊。兩種：
    # B-tmpdir     暫存檔的位置先放一個同名資料夾（裡面有一個檔）→ 那個暫存檔寫不進去，也刪不掉（不是建置建的，不該去刪）
    #              每一格：回非 0、點名那個檔、沒有錯誤堆疊、data/ 雜湊不變（資料夾還在、沒留下別的 .tmp）
    # B-cleanupfail 寫某個檔失敗，而且第一個輸出的暫存檔刪不掉（模擬被鎖住）→ 要點名失敗的檔、也點名清不掉的暫存檔、
    #              沒有錯誤堆疊、正式輸出不變、留下的 .tmp 剛好只有那一個。第一個輸出不適用（它前面沒有已寫好的暫存檔）。
    def stale_all(w):
        for r2 in OUTPUTS:
            p2 = os.path.join(w, 'data', r2)
            if not os.path.exists(p2):
                raise Abort(f'data/{r2} 原本就不存在')
            open(p2, 'w', encoding='utf-8').write(f'STALE {r2}\n')
        open(os.path.join(w, 'scripts', '_inject.py'), 'w', encoding='utf-8').write(INJECT)

    for rel in OUTPUTS:
        w = fresh(); stale_all(w)
        d = os.path.join(w, 'data', rel + '.tmp')
        os.makedirs(d)
        open(os.path.join(d, 'keep.txt'), 'w', encoding='utf-8').write('not ours\n')
        before = data_digest(w)
        rc, out = run(w, 'build_data.py')
        same = data_digest(w) == before
        tb = 'Traceback' in out
        report(rc != 0 and names(out, rel) and not tb and same, f'B-tmpdir {rel}',
               f'rc={rc}' + ('' if names(out, rel) else '（錯誤訊息沒點名這個檔）') + ('（輸出是錯誤堆疊）' if tb else '')
               + ('' if same else f'（data/ 被改動了，留下的 .tmp：{tmp_files(w)}）'))

    first = OUTPUTS[0]
    for rel in OUTPUTS[1:]:
        w = fresh(); stale_all(w)
        before = data_digest(w, skip_tmp=True)
        rc, out = run(w, '_inject.py', rel, first)
        for mark in ('_injected.txt', '_unlink_blocked.txt'):
            if not os.path.exists(os.path.join(w, mark)):
                print(f'ABORT：B-cleanupfail {rel} 的 {mark} 沒有出現（情境沒造成）'); return 2
        same = data_digest(w, skip_tmp=True) == before
        left = tmp_files(w)
        tb = 'Traceback' in out
        ok = rc != 0 and names(out, rel, first + '.tmp') and not tb and same and left == [first + '.tmp']
        report(ok, f'B-cleanupfail {rel}',
               f'rc={rc}' + ('' if names(out, rel) else '（沒點名失敗的檔）') + ('' if names(out, first + '.tmp') else '（沒點名清不掉的暫存檔）')
               + ('（輸出是錯誤堆疊）' if tb else '') + ('' if same else '（正式輸出被改動了）')
               + ('' if left == [first + '.tmp'] else f'（留下的 .tmp：{left}）'))

    rmtree(tmp)
    print(f'共 {len(SETS)} 組 × 4 種情境＋基準＋J13（C-alldup 10 組、B-alldup 8 組＋成對對照 8 組）'
          f'＋寫到一半失敗 {len(OUTPUTS)} 個輸出檔＋暫存檔位置被佔 {len(OUTPUTS)}＋清理失敗 {len(OUTPUTS) - 1}；' + ('全部符合' if not bad else '有不符合'))
    return bad


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Abort as e:
        print(f'ABORT：{e}')
        sys.exit(2)
