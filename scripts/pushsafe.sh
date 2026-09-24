#!/usr/bin/env bash
# 推送閘門（共用慣例 §2.5）：推送一律用這支，不要直接下 git push。
#   bash scripts/pushsafe.sh
# 三關，每關失敗都讓後面停下，各自的回傳值：
#   1  閘門腳本有已知的壞寫法（lint_gate.py）、自查失敗（有命中、對照組沒命中、取不到使用者名稱、沒有要推的 commit），或取不到遠端的最新狀態——沒有推
#   2  推送失敗
#   3  推送回報成功，但遠端 main 不等於本機 HEAD
#   0  推上去了，而且遠端＝本機
# 會決定成敗的指令一律不接管線（管線的回傳值是最後一個指令的，會吞掉失敗）；輸出導到檔案再印。
# 改過這支或 selfcheck_public.py，就重跑 scripts/test_pushsafe.sh（分別製造每一關的失敗）。
set -u
set -o pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
LOG="$(mktemp)"
HELPER='!"$HOME/AppData/Local/Temp/gh-cli/bin/gh.exe" auth git-credential'   # gh 的位置見 STATUS §8
export GIT_TERMINAL_PROMPT=0 GH_CONFIG_DIR="$HOME/.config/gh"

# 00) 閘門、自查、驗法本身有沒有已知的壞寫法（共用慣例 v9 §5.16；檢查器壞了也停）
python scripts/lint_gate.py > "$LOG" 2>&1
rc=$?
cat "$LOG"
if [ $rc -ne 0 ]; then echo "PUSHSAFE: 閘門腳本有已知的壞寫法或檢查器壞了（rc=$rc），沒有推送"; rm -f "$LOG"; exit 1; fi

# 0) 先拿遠端的最新狀態，自查才算得出「所有還沒推的 commit」
timeout 90 git -c credential.helper="$HELPER" fetch -q origin main > "$LOG" 2>&1
rc=$?
if [ $rc -ne 0 ]; then cat "$LOG"; echo "PUSHSAFE: 取不到遠端的最新狀態（rc=$rc），沒有推送"; rm -f "$LOG"; exit 1; fi

# 1) 自查
python scripts/selfcheck_public.py origin/main > "$LOG" 2>&1
rc=$?
cat "$LOG"
if [ $rc -ne 0 ]; then echo "PUSHSAFE: 自查失敗（rc=$rc），沒有推送"; rm -f "$LOG"; exit 1; fi

# 2) 推送
timeout 90 git -c credential.helper="$HELPER" push origin main > "$LOG" 2>&1
rc=$?
cat "$LOG"
if [ $rc -ne 0 ]; then echo "PUSHSAFE: 推送失敗（rc=$rc）"; rm -f "$LOG"; exit 2; fi

# 3) 推送後：遠端 main 必須等於本機 HEAD
timeout 90 git -c credential.helper="$HELPER" ls-remote origin refs/heads/main > "$LOG" 2>&1
rc=$?
remote="$(cut -f1 "$LOG")"
localh="$(git rev-parse HEAD)"
rm -f "$LOG"
if [ $rc -ne 0 ] || [ -z "$remote" ] || [ "$remote" != "$localh" ]; then
  echo "PUSHSAFE: 遠端與本機不一致（ls-remote rc=$rc remote=${remote:0:7} local=${localh:0:7}）"; exit 3
fi
echo "PUSHSAFE: 推送成功，遠端＝本機＝${localh:0:7}"
exit 0
