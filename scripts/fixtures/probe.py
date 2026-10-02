"""對照組專用的 Python 樣本（fixture）：由 scripts/test_cli_probes.py 與 scripts/lint_gate.py 的真實檔對照組使用。

內容固定、不隨程式變動（2026-10-02：原本拿 selfcheck_public.py、check_data.py 當樣本，它們一直在改）。不會被執行。
"""
import re

WORD = re.compile(r'\w+')


def count_words(text):
    """一般的寫法：正確跳脫的 regex、字串、迴圈。"""
    n = 0
    for line in text.split('\n'):
        n += len(WORD.findall(line))
    return n
