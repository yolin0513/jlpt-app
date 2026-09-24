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


def data_digest(d):
    """data/ 底下（不含 src）每一個檔的內容雜湊——用來確認建置失敗時一個檔都沒被寫。"""
    h = hashlib.sha1()
    base = os.path.join(d, 'data')
    for dirpath, dirnames, files in sorted(os.walk(base)):
        dirnames[:] = sorted(x for x in dirnames if x != 'src')
        for f in sorted(files):
            p = os.path.join(dirpath, f)
            h.update(os.path.relpath(p, base).replace('\\', '/').encode())
            h.update(open(p, 'rb').read())
    return h.hexdigest()


def run(d, script):
    r = subprocess.run([sys.executable, f'scripts/{script}'], cwd=d, capture_output=True)
    return r.returncode, (r.stdout + r.stderr).decode('utf-8', 'replace')


def names(out, *needles):
    """擋下的理由有沒有點名那一組：每個 needle 都要出現在輸出裡。"""
    return all(n in out for n in needles)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', help='用這個 commit 的 build_data.py 與 check_data.py')
    args = ap.parse_args()

    # §5.11 第二層：比對函式自己的對照組
    assert names('缺檔：data/vocab/n5.json', 'vocab/n5.json'), '比對函式抓不到已知的句子'
    assert not names('缺檔：data/vocab/n4.json', 'vocab/n5.json'), '比對函式把 n4 當成 n5'
    print('比對函式的對照組：2/2 符合')

    tmp = tempfile.mkdtemp()
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

    rmtree(tmp)
    print(f'共 {len(SETS)} 組 × 4 種情境＋基準；' + ('全部符合' if not bad else '有不符合'))
    return bad


if __name__ == '__main__':
    sys.exit(main())
