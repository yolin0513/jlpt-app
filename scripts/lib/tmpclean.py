"""刪暫存目錄，刪不掉要講（2026-10-08，Dispatch）：`shutil.rmtree(d, ignore_errors=True)` 的意思就是「刪不掉也不告訴你」，
而刪不掉的原因通常是還有程序握著那個目錄——也就是上一輪沒收乾淨。它把一個真實的徵兆吞掉了。

rmtree_strict(d)：先去掉唯讀再刪；刪不掉的不吞掉，每一處印一行「CLEANUP: 刪不掉 …」，回傳留下的問題清單（空清單＝刪乾淨）。
呼叫的人拿到非空清單要判失敗（回非 0），不能只印。驗法：python scripts/test_tmpclean.py
"""
import os
import shutil
import stat
import sys


def rmtree_strict(d):
    errs = []

    def retry(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError as e:
            errs.append(f'{p}（{e.__class__.__name__}：{e.strerror or e}）')

    if os.path.lexists(d):
        if sys.version_info >= (3, 12):
            shutil.rmtree(d, onexc=retry)
        else:
            shutil.rmtree(d, onerror=lambda f, p, ei: retry(f, p, ei[1]))
    for e in errs:
        print(f'CLEANUP: 刪不掉 {e}')
    if os.path.lexists(d):
        return errs or [f'{d}（刪完還在，但沒有收到任何錯誤）']
    return []
