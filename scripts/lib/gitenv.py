"""git 自己認得的環境變數（GIT_DIR、GIT_WORK_TREE、GIT_EXEC_PATH……）的入口拒絕——Python 那一層（2026-09-25）。

bash 那一層在 scripts/pushsafe.sh 開頭；這一層給能單獨跑的正式閘門用（selfcheck_public.py、lint_gate.py）：
它們各自會叫 git，單獨跑的時候不經過 pushsafe.sh 的檢查。前綴寫法，不逐一列舉（列舉一定會漏，GIT_EXEC_PATH 就是例子），
只放行不影響「看哪個 repo、哪些物件、哪份設定、推去哪」的白名單。
"""
import os

ALLOW = {'GIT_EDITOR', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT'}


def offending(env=None):
    """環境裡 GIT_ 開頭、又不在白名單的變數名（排序過）。env 預設是目前行程的環境。"""
    env = os.environ if env is None else env
    return sorted(k for k in env if k.upper().startswith('GIT_') and k.upper() not in ALLOW)


def self_check():
    """對照組（該攔的攔、不該攔的不攔）：當場組一份假環境。不對就回傳錯誤說明，對了回傳空字串。"""
    fake = {'GIT_DIR': 'x', 'GIT_EXEC_PATH': 'x', 'GIT_SOMETHING_NEW': 'x',
            'GIT_EDITOR': 'x', 'GIT_PAGER': 'x', 'GIT_TERMINAL_PROMPT': 'x', 'PATH': 'x', 'HOME': 'x', 'MYGIT_X': 'x'}
    got = offending(fake)
    want = ['GIT_DIR', 'GIT_EXEC_PATH', 'GIT_SOMETHING_NEW']
    return '' if got == want else f'GIT_ 變數的判斷對照組不對：抓到 {got}，應該是 {want}'
