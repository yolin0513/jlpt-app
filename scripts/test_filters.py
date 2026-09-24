"""題庫草稿過濾器的雜訊測試（2026-09-24，Dispatch 交辦修 v9 盤點第 3 件）。

用法：python scripts/test_filters.py            # 用工作區的兩支過濾器
      python scripts/test_filters.py --ref HEAD # 用某個 commit 的版本（證明修正前會紅）
回傳值：0＝全部符合；1＝有不符合；2＝造情境失敗而中止。
什麼時候跑：改過 scripts/filter_vocab_draft.mjs 或 scripts/filter_grammar_draft.mjs 就跑（幾秒；在暫存複本裡）。

母體是「每一欄都跑一遍」：兩支過濾器的 7 個欄位，各塞一次西里爾字母、一次韓文（生成草稿常見的雜訊），
都必須被剔除，而且剔除理由要講到雜訊（不是被別的規則順便擋掉）。
v9 盤點時發現：文法那支的雜訊檢查只套在句型、讀音、接續、例句、例句假名五欄，中文意思與例句中譯混進雜訊會被保留。
另有對照：乾淨的一行要保留；文法的中文意思用 A、B 當代稱（英文字母）也要保留——中文欄只擋西里爾字母與韓文。
"""
import argparse
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CYR = 'тест'   # 西里爾字母，當場組出來
HAN = '테스트'         # 韓文，當場組出來
FILTERS = {
    'filter_vocab_draft.mjs': ('試験字 | しけんじ | 測試用字 | 名詞 | 試験字を書く。 | しけんじをかく。 | 寫測試字。',
                               ['漢字', '假名', '中文釋義', '詞性', '例句', '例句假名', '例句中譯']),
    'filter_grammar_draft.mjs': ('～てみるてすと | てみるてすと | 測試用句型 | 動詞て形＋みる | 書いてみるてすと。 | かいてみるてすと。 | 試著寫寫看。',
                                 ['句型', '讀音', '中文意思', '接續', '例句', '例句假名', '例句中譯']),
}
NOISE_WORDS = ('西里爾', '韓文')


def rmtree(p):
    if os.path.exists(p):
        shutil.rmtree(p, onexc=lambda f, x, e: (os.chmod(x, stat.S_IWRITE), f(x)))


def rejected_for_noise(out):
    """剔除了，而且理由講到雜訊：輸出有「x … → …西里爾…／韓文…」、而且保留 0 行。"""
    return '保留 0' in out and any(('→' in l and any(w in l for w in NOISE_WORDS)) for l in out.splitlines() if l.strip().startswith('x '))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref')
    args = ap.parse_args()

    # 比對函式的對照組（兩個方向）
    assert rejected_for_noise('  x 字 → 含西里爾字母或韓文（生成雜訊）\n草稿共 1 行，保留 0，剔除 1'), '該判剔除的沒判到'
    assert not rejected_for_noise('  x 字 → 欄位數 6（應為 7）\n草稿共 1 行，保留 0，剔除 1'), '被別的規則擋掉也算成雜訊'
    assert not rejected_for_noise('草稿共 1 行，保留 1，剔除 0'), '保留了也算成剔除'
    print('比對函式的對照組：3/3 符合')

    tmp = tempfile.mkdtemp()
    os.makedirs(os.path.join(tmp, 'scripts'))
    shutil.copytree(os.path.join(ROOT, 'data'), os.path.join(tmp, 'data'))
    for f in FILTERS:
        if args.ref:
            r = subprocess.run(['git', 'show', f'{args.ref}:scripts/{f}'], cwd=ROOT, capture_output=True)
            if r.returncode != 0:
                print(f'ABORT：取不到 {args.ref}:scripts/{f}'); return 2
            open(os.path.join(tmp, 'scripts', f), 'wb').write(r.stdout)
        else:
            shutil.copy(os.path.join(ROOT, 'scripts', f), os.path.join(tmp, 'scripts', f))
    print(f'被測的版本：{"commit " + args.ref if args.ref else "工作區"}')

    bad = 0
    n = 0

    def run(f, line):
        nonlocal n
        n += 1
        draft = os.path.join(tmp, f'd{n}.txt')
        open(draft, 'w', encoding='utf-8').write(line + '\n')
        r = subprocess.run(['node', f'scripts/{f}', draft], cwd=tmp, capture_output=True)
        return r.returncode, (r.stdout + r.stderr).decode('utf-8', 'replace')

    def report(ok, name, detail=''):
        nonlocal bad
        if not ok:
            bad = 1
        print(f'{"yes" if ok else "no ":4s} {name:44s} {detail}')

    for f, (clean, labels) in FILTERS.items():
        rc, out = run(f, clean)
        report(rc == 0 and '保留 1' in out, f'{f}：乾淨的一行要保留', f'rc={rc}')
        if not (rc == 0 and '保留 1' in out):
            print('ABORT：乾淨的一行就過不了，後面的情境沒有意義'); return 2
        fields = [x.strip() for x in clean.split('|')]
        for i, label in enumerate(labels):
            for noise, nname in ((CYR, '西里爾'), (HAN, '韓文')):
                c = list(fields)
                c[i] = noise + c[i]          # 放在欄位開頭，不動句末標點
                rc, out = run(f, ' | '.join(c))
                report(rejected_for_noise(out), f'{f}：{label}欄混入{nname}')

    # 文法的中文意思用 A、B 當代稱：要保留（中文欄只擋西里爾字母與韓文）
    f = 'filter_grammar_draft.mjs'
    fields = [x.strip() for x in FILTERS[f][0].split('|')]
    fields[2] = 'A 比 B 更測試'
    rc, out = run(f, ' | '.join(fields))
    report('保留 1' in out, f'{f}：中文意思用 A、B 代稱要保留', f'rc={rc}')

    rmtree(tmp)
    print('全部符合' if not bad else '有不符合')
    return bad


if __name__ == '__main__':
    sys.exit(main())
