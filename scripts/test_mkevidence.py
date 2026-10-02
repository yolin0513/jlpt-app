"""mkevidence_mut.py 的驗法（共用慣例 v11.4 §5.7、§5.20）。全部用合成 log，在暫存目錄裡跑，不寫 repo。

用法：python scripts/test_mkevidence.py
回傳值：0＝全部符合；1＝有不符；2＝造情境失敗。
什麼時候跑：改過 mkevidence_mut.py 或這支就跑；秒級單支檢查。

情境：
  A 五種 log 各一份（ABORT、沒有 MUTATION ACTIVE、沒有結尾、全部符合、紅），分類與實際紅的情境要對；
    另一份紅的 log 裡，縮排的證據行帶著「MUTATION ACTIVE:」「TEST-PUSHSAFE: 全部符合…」「no   05」——不能被當成判定。
  B 母體：交一個讀不到的 log → 回 1、不寫檔（原本的檔不能被覆寫）。
  C 清洗：證據檔裡不能出現路徑或使用者名稱；在暫存副本把 clean() 改成原樣回傳 → 程式自己的清洗對照組要擋下、回 1、不寫檔。
  D 秒數只對應同一次的摘要：兩份摘要寫同一個名稱、秒數不同，各自的 log 要拿到各自的秒數。
"""
import io
import os
import shutil
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get('TEST_MKEVIDENCE_SRC') or os.path.join(ROOT, 'scripts', 'mkevidence_mut.py')   # 驗這支自己會紅時換成突變副本
results = []


def record(ok, label, detail=''):
    results.append(ok)
    print(f'[{"符合" if ok else "不符"}] {label}' + (f'：{detail}' if detail else ''))


def run(script, args):
    r = subprocess.run([sys.executable, script, *args], capture_output=True, timeout=120)
    out = (r.stdout + r.stderr).decode('utf-8', 'replace')
    return r.returncode, out


def rows(path):
    lines = open(path, encoding='utf-8').read().splitlines()
    return [l.split('\t') for l in lines[1:]]


SCEN = ''.join(f'yes  {i:02d} 情境 {i}\n' for i in range(1, 4))
LOGS = {
    'pre-a.mabort.log': 'ABORT: 改壞之後還有那段（造情境失敗）\n',
    'pre-a.mnoactive.log': SCEN + 'TEST-PUSHSAFE: 有不符合預期的情況；沒有登記\n',
    'pre-a.mnoend.log': 'MUTATION ACTIVE: mnoend（已確認…）\n' + SCEN,
    'pre-a.mclean.log': 'MUTATION ACTIVE: mclean（已確認…）\n' + SCEN + 'TEST-PUSHSAFE: 全部符合，但這一輪是突變；沒有登記\n',
    'pre-a.mred.log': ('MUTATION ACTIVE: mred（已確認…）\nyes  01 a\nno   02 b  rc=0(期望 1)  （回傳值 擋下理由不對）\n'
                       'no   03 c  rc=1(期望 1)\n'
                       '       實際：MUTATION ACTIVE: fake\n       實際：TEST-PUSHSAFE: 全部符合，但這一輪是突變\n       no   05 不是情境行\n'
                       'TEST-PUSHSAFE: 有不符合預期的情況；沒有登記\n'),
}
WANT = {   # 名稱 → (分類, 實際紅, 理由也不對)
    'mabort': ('情境未成立', '-', '-'), 'mnoactive': ('情境未成立', '-', '-'), 'mnoend': ('情境未成立', '-', '-'),
    'mclean': ('全部符合', '-', '-'), 'mred': ('紅', '02,03', '02'),
}


def main():
    td = tempfile.mkdtemp(prefix='jlpt-mkev-')
    try:
        # 合成的驗法：情境 3 個（判定行數的母體檢查要從它的 LIST 數）
        ver = os.path.join(td, 'fake_tps.sh')
        open(ver, 'w', encoding='utf-8').write(
            '#   TEST_PUSHSAFE_MUTATE=<突變> bash x   # 突變：mred mclean mnoend mabort mnoactive\n'
            'case "$MUTATE" in\n  "") ;;\n  mred)\n    x ;;\n  mclean|mnoend|mabort|mnoactive)\n    y ;;\nesac\n'
            'LIST="s01 s02 s03"\nN_SCEN=3\n')
        V = ['--verifier', ver]
        paths = []
        for n, t in LOGS.items():
            p = os.path.join(td, n)
            open(p, 'w', encoding='utf-8').write(t)
            paths.append(p)
        summ = os.path.join(td, 'pre-a.summary')
        open(summ, 'w', encoding='utf-8').write('mred rc=1 秒=111\nmclean rc=1 秒=22\n')
        out1 = os.path.join(td, 'ev.tsv')
        rc, out = run(SRC, ['--out', out1, *V, '--summary', summ, *paths])
        # 欄位：0 名稱 1 分類 2 判定 3 預期類別 4 預期紅 5 實際紅 6 預期不紅卻紅 7 預期紅卻沒紅 8 其中擋下理由也不對 9 判定行數 10 秒數 11 log
        got = {r[0]: (r[1], r[5], r[8]) for r in rows(out1)} if rc == 0 and os.path.exists(out1) else {}
        ok = rc == 0 and got == WANT and len(rows(out1)) == len(paths)
        record(ok, 'A 五種 log 的分類、實際紅、證據行不被當成判定', f'rc={rc}；{got}')
        secs = {r[0]: r[10] for r in rows(out1)} if got else {}
        record(secs.get('mred') == '111' and secs.get('mclean') == '22' and secs.get('mabort') == '未記',
               'A 秒數從同一次的摘要讀到、沒有的寫「未記」', f'{secs}')

        # B 母體：多交一個讀不到的 log；原本的檔不能被覆寫（自己放一份基準檔，不依賴 A 的產出——情境之間不互相污染）
        outb = os.path.join(td, 'ev_b.tsv')
        open(outb, 'wb').write(b'baseline\n')
        rc, out = run(SRC, ['--out', outb, *V, *paths, os.path.join(td, 'pre-a.missing.log')])
        fl = [l for l in out.splitlines() if l.startswith('MKEVIDENCE FAILED: ')]
        record(rc == 1 and len(fl) == 1 and '不等' in fl[0] and open(outb, 'rb').read() == b'baseline\n',
               'B 讀不到一個 log → 母體不等、回 1、不寫檔（原檔沒被覆寫）', f'rc={rc}、{fl}')

        # C 清洗：證據檔沒有路徑與使用者名稱（自己產生一份，產生不出來就記不符、不整支中止）；clean() 改成原樣回傳 → 自己的對照組擋下
        outc = os.path.join(td, 'ev_c.tsv')
        rc, out = run(SRC, ['--out', outc, *V, *paths])
        text = open(outc, encoding='utf-8').read() if rc == 0 and os.path.exists(outc) else ''
        if not text:
            record(False, 'C 清洗：產生不出證據檔，沒辦法檢查', f'rc={rc}')
        user = os.environ.get('USERNAME') or os.environ.get('USER') or ''
        record(td not in text and (not user or user not in text) and 'Users' not in text,
               'C 證據檔裡沒有暫存目錄路徑、使用者名稱', f'{len(text)} 字元')
        s = open(SRC, encoding='utf-8').read()
        a = "def clean(cell):\n"
        if s.count(a) != 1:
            raise RuntimeError('clean() 的錨點不是恰好一處')
        mp = os.path.join(td, 'mk_noclean.py')
        open(mp, 'w', encoding='utf-8').write(s.replace(a, a + "    return cell\n"))
        out2 = os.path.join(td, 'ev2.tsv')
        rc, out = run(mp, ['--out', out2, *V, *paths])
        fl = [l for l in out.splitlines() if l.startswith('MKEVIDENCE FAILED: 清洗的對照組不過')]
        record(rc == 1 and len(fl) == 1 and not os.path.exists(out2), 'C 突變「clean 原樣回傳」→ 清洗對照組擋下、回 1、不寫檔',
               f'rc={rc}、{fl}')

        # D 兩份摘要寫同一個名稱、秒數不同
        p1, p2 = os.path.join(td, 'run1.mred.log'), os.path.join(td, 'run2.mred.log')
        shutil.copy(paths[-1], p1)
        shutil.copy(paths[-1], p2)
        s1, s2 = os.path.join(td, 'run1.summary'), os.path.join(td, 'run2.summary')
        open(s1, 'w', encoding='utf-8').write('mred rc=2 秒=8\n')
        open(s2, 'w', encoding='utf-8').write('mred rc=1 秒=250\n')
        out3 = os.path.join(td, 'ev3.tsv')
        rc, out = run(SRC, ['--out', out3, *V, '--summary', s1, '--summary', s2, p1, p2])
        got = [(r[11], r[10]) for r in rows(out3)] if rc == 0 else []
        record(got == [('run1.mred.log', '8'), ('run2.mred.log', '250')], 'D 秒數只對應同一次的摘要（不會被後一份蓋掉）', f'{got}')
        # E 預期表：對全部情境的完整劃分（合成的驗法：case 分支 mred／mclean／mnoend／mabort／mnoactive、LIST s01～s03）
        H = '名稱\t類別\ts01\ts02\ts03\t依據\n'
        def exp(name, body):
            p = os.path.join(td, name)
            open(p, 'w', encoding='utf-8').write(body)
            return p
        ALL = ('mred\tred\t不紅\t紅\t紅\t事前\nmclean\tequivalent\t不紅\t不紅\t不紅\t事前\n'
               'mnoend\tred\t紅\t不紅\t不紅\t事前\nmabort\tred\t紅\t不紅\t不紅\t事前\nmnoactive\tred\t紅\t不紅\t不紅\t事前\n')
        ok_exp = exp('e_ok.tsv', H + ALL)
        out4 = os.path.join(td, 'ev4.tsv')
        rc, out = run(SRC, ['--out', out4, '--expect', ok_exp, '--verifier', ver, *paths])
        r4 = {r[0]: (r[2], r[4]) for r in rows(out4)} if rc == 0 else {}
        record(rc == 0 and r4.get('mred') == ('符合預期', '02,03') and r4.get('mclean') == ('符合預期', '-')
               and r4.get('mabort', ('',))[0] == '—', 'E 完整劃分對得上 → 放行；判定：紅在預期、等價、情境未成立記「—」', f'rc={rc}、{r4}')
        # 通過時也要印量到的數字（不是從「沒有報錯」推出來的 0）：5 條 × 3 個情境＝15 格、驗法 5 條突變、3 個情境
        ck = [l for l in out.splitlines() if l.startswith('MKEVIDENCE EXPECT-CHECK: ')]
        record(len(ck) == 1 and '預期表實際讀到 15 格（應有 5 條突變 × 3 個情境＝15 格）' in ck[0] and '驗法裡有突變 5 條、情境 3 個' in ck[0]
               and '過期 0 處' in ck[0], 'E 通過時印出量到的數字（列數、格數、驗法的突變與情境數、驗法的雜湊）', f'{ck}')
        rc, out = run(SRC, ['--out', os.path.join(td, 'ev_co.tsv'), '--check-only', '--expect', ok_exp, '--verifier', ver])
        ck = [l for l in out.splitlines() if l.startswith('MKEVIDENCE EXPECT-CHECK: ')]
        record(rc == 0 and len(ck) == 1 and '實際讀到 15 格' in ck[0] and not os.path.exists(os.path.join(td, 'ev_co.tsv')),
               'E --check-only：只核對、印量到的數字、不寫證據檔', f'rc={rc}、{ck[:1]}')
        rc, out = run(SRC, ['--out', os.path.join(td, 'ev_ne.tsv'), *V, *paths])
        ck = [l for l in out.splitlines() if l.startswith('MKEVIDENCE EXPECT-CHECK: ')]
        record(rc == 0 and len(ck) == 1 and '沒有查' in ck[0], 'E 沒給預期表時明講「沒有查」', f'{ck}')
        # 不符預期：mred 預期 01、03 紅，實際 02、03 紅 → 預期不紅卻紅＝02、預期紅卻沒紅＝01
        off_exp = exp('e_off.tsv', H + ALL.replace('mred\tred\t不紅\t紅\t紅', 'mred\tred\t紅\t不紅\t紅'))
        out7 = os.path.join(td, 'ev7.tsv')
        rc, out = run(SRC, ['--out', out7, '--expect', off_exp, '--verifier', ver, *paths])
        r7 = {r[0]: (r[2], r[6], r[7]) for r in rows(out7)} if rc == 0 else {}
        record(rc == 0 and r7.get('mred') == ('不符預期', '02', '01'), 'E 不符預期時「預期不紅卻紅」「預期紅卻沒紅」分開寫', f'rc={rc}、{r7.get("mred")}')
        # 過期（回 3）：表頭少了 s03（後來加的情境沒有欄）
        stale1 = exp('e_stale1.tsv', '名稱\t類別\ts01\ts02\t依據\n' + ''.join(
            '\t'.join(l.split('\t')[:4] + l.split('\t')[5:]) + '\n' for l in ALL.splitlines()))
        rc, out = run(SRC, ['--out', os.path.join(td, 'ev5.tsv'), '--expect', stale1, '--verifier', ver, *paths])
        st = [l for l in out.splitlines() if l.startswith('MKEVIDENCE STALE-EXPECT: ')]
        record(rc == 3 and len(st) == 1 and "少了 ['s03']" in out and not os.path.exists(os.path.join(td, 'ev5.tsv')),
               'E 表頭少一個情境 → 預期清單過期、回 3、點名 s03、不寫檔', f'rc={rc}、{st}')
        # 過期（回 3）：驗法裡有、預期表沒列（mnoactive 那一列拿掉）
        stale2 = exp('e_stale2.tsv', H + ''.join(l + '\n' for l in ALL.splitlines() if not l.startswith('mnoactive')))
        rc, out = run(SRC, ['--out', os.path.join(td, 'ev6.tsv'), '--expect', stale2, '--verifier', ver, *paths])
        record(rc == 3 and "['mnoactive']" in out, 'E 驗法裡有、預期表沒列的突變 → 預期清單過期、回 3、點名', f'rc={rc}')
        # 格式（回 1）：某一列少一格；某一格不是紅／不紅
        short = exp('e_short.tsv', H + ALL.replace('mnoend\tred\t紅\t不紅\t不紅', 'mnoend\tred\t紅\t不紅'))
        rc, out = run(SRC, ['--out', os.path.join(td, 'ev8.tsv'), '--expect', short, '--verifier', ver, *paths])
        fl = [l for l in out.splitlines() if l.startswith('MKEVIDENCE FAILED: 預期表格式不對')]
        record(rc == 1 and len(fl) == 1 and 'mnoend' in out, 'E 某一列格數不等於情境數 → 回 1、點名那一列', f'rc={rc}、{fl}')
        badcell = exp('e_bad.tsv', H + ALL.replace('mnoend\tred\t紅\t不紅\t不紅', 'mnoend\tred\t紅\t?\t不紅'))
        rc, out = run(SRC, ['--out', os.path.join(td, 'ev9.tsv'), '--expect', badcell, '--verifier', ver, *paths])
        record(rc == 1 and "['s02']" in out, 'E 某一格不是「紅／不紅」→ 回 1、點名那一格', f'rc={rc}')
        bad_ver = os.path.join(td, 'fake_tps_bad.sh')
        open(bad_ver, 'w', encoding='utf-8').write(open(ver, encoding='utf-8').read().replace('mnoend mabort', 'mabort'))
        rc, out = run(SRC, ['--out', os.path.join(td, 'ev10.tsv'), '--expect', ok_exp, '--verifier', bad_ver, *paths])
        fl = [l for l in out.splitlines() if l.startswith('MKEVIDENCE FAILED: 驗法的母體讀不清楚')]
        record(rc == 1 and len(fl) == 1 and 'mnoend' in fl[0], 'E 驗法的檔頭清單與 case 分支不一致 → 回 1、點名', f'rc={rc}、{fl}')
        # F 判定行數的母體（TripQuest 2026-10-02：兩份空清單互比得到「差異 0」）：對照組兩向在同一支裡
        rc, out = run(SRC, ['--out', os.path.join(td, 'evf1.tsv'), *V, *paths])
        cmp_l = [l for l in out.splitlines() if l.startswith('MKEVIDENCE COMPARE: ')]
        record(rc == 0 and len(cmp_l) == 1 and '實際抽到判定行 6 行、應有 6 行' in cmp_l[0],
               'F 完整的 log：印出實際抽到的判定行數＝應有的（2 份情境成立 × 3 個情境＝6）', f'rc={rc}、{cmp_l}')
        short = os.path.join(td, 'pre-a.mshort.log')
        open(short, 'w', encoding='utf-8').write(LOGS['pre-a.mred.log'].replace('no   03 c  rc=1(期望 1)\n', ''))
        if 'no   03' in open(short, encoding='utf-8').read():
            raise RuntimeError('少一行的樣本沒造成')
        rc, out = run(SRC, ['--out', os.path.join(td, 'evf2.tsv'), *V, short])
        fl = [l for l in out.splitlines() if l.startswith('MKEVIDENCE FAILED: ') and '判定行數不等於情境數' in l]
        record(rc == 1 and len(fl) == 1 and 'pre-a.mshort.log：抽到判定行 2 行、應有 3 行' in out and not os.path.exists(os.path.join(td, 'evf2.tsv')),
               'F 少一行判定行的 log → 擋下、點名那一份、不寫檔', f'rc={rc}、{fl}')
    except (RuntimeError, OSError, IndexError, subprocess.TimeoutExpired) as e:
        print(f'TEST-MKEVIDENCE ABORT: 造情境失敗：{e}（沒驗到，不是通過）')
        return 2
    finally:
        shutil.rmtree(td, ignore_errors=True)
    print('TEST-MKEVIDENCE OK' if all(results) else f'TEST-MKEVIDENCE FAILED: {results.count(False)} 項不符')
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
