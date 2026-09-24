"""驗法登記的共用判斷（J7 的 .git/pushsafe-verified、F9 的 .logs/datacheck-verified 都用這支）。

用法：python scripts/lib/verified_reg.py <repo 根目錄> <登記檔> <被驗的 HEAD> <被守的檔>...
回傳值：0＝已登記（寫的是 HEAD 那一版的雜湊）；1＝沒有登記（本機 HEAD 已經不是被驗的那一個，或被守的檔工作區跟 HEAD
        不一樣），舊登記也刪掉；2＝取不到狀態（git 失敗），舊登記刪掉。
為什麼要這一道：登記的是 HEAD 那一版的雜湊，驗法實際跑的卻可能是工作區那一版——工作區有改動還照樣登記，
就等於「HEAD 那一版從沒被驗過，卻被登記成驗過」，之後推送 HEAD 就會被放行（2026-09-24 統籌者用突變查出：
這一段改成一律當作沒改動，原本的 19 種驗法情境照樣全部符合）。常設情境在 test_pushsafe.sh 的 20、21。
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


def main(argv):
    if len(argv) < 4:
        print('VERIFIED-REG: 用法：verified_reg.py <repo 根目錄> <登記檔> <被驗的 HEAD> <被守的檔>...')
        return 2
    root, reg, tested, files = argv[0], argv[1], argv[2], argv[3:]
    rc, head = git(root, 'rev-parse', 'HEAD')
    if rc != 0 or not head:
        drop(reg); print('VERIFIED-REG: 取不到 HEAD，沒有登記（舊登記已刪）'); return 2
    if head != tested:
        drop(reg); print(f'VERIFIED-REG: 本機 HEAD（{head[:7]}）已經不是被驗的那一個（{tested[:7]}），沒有登記（舊登記已刪）'); return 1
    dirty = []
    for f in files:
        rc, _ = git(root, 'diff', '--quiet', 'HEAD', '--', f)
        if rc not in (0, 1):
            drop(reg); print(f'VERIFIED-REG: 比不出 {f} 跟 HEAD 一不一樣（git diff 失敗），沒有登記（舊登記已刪）'); return 2
        if rc == 1:
            dirty.append(f)
    if dirty:
        drop(reg); print(f'VERIFIED-REG: 工作區跟 HEAD 不一樣（{"、".join(dirty)}），沒有登記（舊登記已刪）——登記的必須是驗過的那一版'); return 1
    lines = []
    for f in files:
        rc, blob = git(root, 'rev-parse', f'HEAD:{f}')
        if rc != 0 or not blob:
            drop(reg); print(f'VERIFIED-REG: 取不到 HEAD:{f}，沒有登記（舊登記已刪）'); return 2
        lines.append(f'{f} {blob}\n')
    os.makedirs(os.path.dirname(os.path.abspath(reg)), exist_ok=True)
    with open(reg, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(''.join(lines))
    print(f'VERIFIED-REG: 已登記 {len(files)} 支已 commit 版本的雜湊（HEAD {head[:7]}）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
