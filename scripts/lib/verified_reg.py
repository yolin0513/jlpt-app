"""驗法登記的共用判斷（J7 的 .git/pushsafe-verified、F9 的 .logs/datacheck-verified 都用這支）。

用法：python scripts/lib/verified_reg.py <repo 根目錄> <登記檔> <驗法全過 yes|no> <被守的檔>[=<實際驗過的那一份>]...
回傳值：0＝已登記（寫的是 HEAD 那一版的雜湊）；1＝沒有登記，舊登記也刪掉；2＝取不到狀態（git 失敗），舊登記刪掉。
登記的條件（全部成立才登記，判斷都在這裡，呼叫端只負責把結果交進來、照判斷執行）：
  1. 驗法全過（呼叫端交 yes）——沒全過、中止、跑的是突變、只跑一個順序，一律交 no，舊登記刪掉；
  2. 被守的檔工作區跟 HEAD 一模一樣（F9 規則：有改動就不登記）；
  3. 有交「實際驗過的那一份」的，它的內容（照 git 的換行設定算）必須等於 HEAD 那一版——
     登記的是 HEAD 的雜湊，驗法實際跑的卻可能是別的版本（例如開始時工作區有改動、跑完前又改回去）。
為什麼要這一道：工作區有改動或驗的不是 HEAD 還照樣登記，就等於「HEAD 那一版從沒被驗過，卻被登記成驗過」
（2026-09-24 統籌者用突變查出：原本沒有常設情境守著）。常設情境在 test_pushsafe.sh 的 20、21、24、25。
"""
import os
import subprocess
import sys


def git(root, *a):
    r = subprocess.run(['git', *a], cwd=root, capture_output=True)
    return r.returncode, r.stdout.decode('utf-8', 'replace').strip()


def drop(reg):
    try:
        os.remove(reg)
    except FileNotFoundError:
        pass


def main(argv, git=git):
    """git：執行 git 的函式（F10 1b 第 2 步：測試時可以換成讓某一個子指令失敗的版本；正式呼叫一律用預設的真 git）。"""
    if len(argv) < 4 or argv[2] not in ('yes', 'no'):
        if len(argv) >= 2:
            drop(argv[1])
        print('VERIFIED-REG: 用法：verified_reg.py <repo 根目錄> <登記檔> <yes|no> <被守的檔>[=<驗過的那一份>]...（沒有登記）')
        return 2
    root, reg, passed, specs = argv[0], argv[1], argv[2], argv[3:]
    if passed != 'yes':
        drop(reg); print('VERIFIED-REG: 驗法沒有全過，沒有登記（舊登記已刪）'); return 1
    dirty, mismatch, lines = [], [], []
    for spec in specs:
        f, _sep, tested = spec.partition('=')
        rc, blob = git(root, 'rev-parse', f'HEAD:{f}')
        if rc != 0 or not blob:
            drop(reg); print(f'VERIFIED-REG: 取不到 HEAD:{f}，沒有登記（舊登記已刪）'); return 2
        rc, _ = git(root, 'diff', '--quiet', 'HEAD', '--', f)
        if rc not in (0, 1):
            drop(reg); print(f'VERIFIED-REG: 比不出 {f} 跟 HEAD 一不一樣（git diff 失敗），沒有登記（舊登記已刪）'); return 2
        if rc == 1:
            dirty.append(f)
        if tested:
            rc, h = git(root, 'hash-object', f'--path={f}', os.path.abspath(tested))
            if rc != 0 or not h:
                drop(reg); print(f'VERIFIED-REG: 算不出驗過的那一份 {f} 的雜湊，沒有登記（舊登記已刪）'); return 2
            if h != blob:
                mismatch.append(f)
        lines.append(f'{f} {blob}\n')
    if dirty:
        drop(reg); print(f'VERIFIED-REG: 工作區跟 HEAD 不一樣（{"、".join(dirty)}），沒有登記（舊登記已刪）——登記的必須是驗過的那一版'); return 1
    if mismatch:
        drop(reg); print(f'VERIFIED-REG: 跑的不是 HEAD 那一版（{"、".join(mismatch)}：驗過的內容跟 HEAD 不同），沒有登記（舊登記已刪）'); return 1
    os.makedirs(os.path.dirname(os.path.abspath(reg)), exist_ok=True)
    with open(reg, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(''.join(lines))
    rc, head = git(root, 'rev-parse', '--short', 'HEAD')
    print(f'VERIFIED-REG: 已登記 {len(specs)} 支已 commit 版本的雜湊（HEAD {head}）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
