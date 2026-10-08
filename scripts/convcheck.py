"""共用慣例副本要跟主檔一致（2026-10-08，Dispatch：副本過期時，過期的規則和現行的規則在閱讀時長得一樣——
都叫「共用慣例」、都讀得通，沒有任何地方會告訴你手上那份過期了；MealMate 10-08 因此違反兩條規則一整天，
本 App 的副本當時還停在 v9，主檔已是 v11.6）。照抄 MealMate 的 scripts/convcheck.mjs，改成 Python。

主檔：統籌工作區的 CONVENTIONS.md（Dispatch 2026-10-08 確認）。路徑用相對於本 repo 根目錄的寫法登記在這裡
（不寫本機絕對路徑：repo 是公開的）。搬家了就改這一行。
換一台沒有統籌工作區的機器，這道檢查會紅（讀不到主檔）——照設計：靜默跳過的版本比對等於沒有版本比對，紅了至少會有人問為什麼。
判定：讀不到主檔＝紅（講明「讀不到主檔」，不當成通過）；副本與主檔是同一個實體檔＝紅（拿自己比自己）；
版本行不同＝紅；版本行相同、全文不同＝紅（主檔改了內容卻沒改版本，或副本被改過）。

用法：python scripts/convcheck.py    回 0 一致；1 不一致或讀不到。驗法：python scripts/test_convcheck.py
"""
import io, os, re, sys

MASTER_REL = '../../Fable_Planner/CONVENTIONS.md'
COPY_REL = 'docs/CONVENTIONS.md'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION_RE = re.compile(r'<!-- CONVENTIONS v[\d.]+ \d{4}-\d{2}-\d{2} -->')


def version_line(text):
    """第一行的版本標記：<!-- CONVENTIONS vX 日期 -->；不是這個樣子就回 None"""
    first = str(text if text is not None else '').lstrip('﻿').split('\n')[0].rstrip('\r')
    return first if VERSION_RE.fullmatch(first) else None


def compare_conv(copy_text, master_text):
    """比對副本與主檔的內容（純函式）：(ok, why)"""
    if master_text is None:
        return False, '讀不到主檔'
    if copy_text is None:
        return False, '讀不到副本'
    cv, mv = version_line(copy_text), version_line(master_text)
    if not mv:
        return False, '主檔第一行不是版本標記'
    if not cv:
        return False, '副本第一行不是版本標記'
    if cv != mv:
        return False, f'版本不同：副本 {cv}、主檔 {mv}——副本過期，照主檔更新（照統籌者的工單）'
    norm = lambda t: t.lstrip('﻿').replace('\r\n', '\n')
    if norm(copy_text) != norm(master_text):
        return False, f'版本相同（{cv}）但全文不同——主檔改了內容卻沒改版本，或副本被改過'
    return True, f'一致（{cv}）'


def conv_check(root=ROOT, master_rel=MASTER_REL, copy_rel=COPY_REL):
    """從 repo 根目錄讀兩份來比：(ok, why)"""
    cp, mp = os.path.join(root, copy_rel), os.path.join(root, master_rel)

    def read(p):
        try:
            with open(p, encoding='utf-8', newline='') as fh:
                return fh.read()
        except OSError:
            return None
    copy_text, master_text = read(cp), read(mp)
    if copy_text is not None and master_text is not None and os.path.samefile(cp, mp):
        return False, '副本與主檔是同一個實體檔——拿自己比自己，比不出任何東西'
    return compare_conv(copy_text, master_text)


if __name__ == '__main__':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    ok, why = conv_check()
    print(f'CONVCHECK {"OK" if ok else "FAILED"}: {why}（副本 {COPY_REL}、主檔 {MASTER_REL}）')
    sys.exit(0 if ok else 1)
