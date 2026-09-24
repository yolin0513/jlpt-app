#!/usr/bin/env bash
# 推送閘門（共用慣例 §2.5）：推送一律用這支，不要直接下 git push。
#   bash scripts/pushsafe.sh
# 三關，每關失敗都讓後面停下，各自的回傳值：
#   1  沒有驗法登記或閘門改過沒重跑驗法、閘門腳本有已知的壞寫法（lint_gate.py）、自查失敗（有命中、對照組沒命中、取不到使用者名稱、沒有要推的 commit），或取不到遠端的最新狀態——沒有推
#   2  推送失敗
#   3  推送回報成功，但遠端 main 不等於本機 HEAD
#   4  這次要推的 commit 動到題庫建置或它的驗法，卻沒有對得上的 F8 驗法登記（沒重跑 test_datacheck.py）——沒有推
#   0  推上去了，而且遠端＝本機
# 會決定成敗的指令一律不接管線（管線的回傳值是最後一個指令的，會吞掉失敗）；輸出導到檔案再印。
# 改過這支或 selfcheck_public.py，就重跑 scripts/test_pushsafe.sh（分別製造每一關的失敗）。
set -u
set -o pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
LOG="$(mktemp)"
HELPER='!"$HOME/AppData/Local/Temp/gh-cli/bin/gh.exe" auth git-credential'   # gh 的位置見 STATUS §8
export GIT_TERMINAL_PROMPT=0 GH_CONFIG_DIR="$HOME/.config/gh"

# 000) 改過閘門就要重跑驗法——機器擋（共用慣例 v9 §5.15，J7，照 MealMate 的登記制）：
#      test_pushsafe.sh 全部符合時，把下面四支「已 commit 版本」的雜湊寫進 .git/pushsafe-verified；
#      這裡比對 HEAD 的版本，沒有登記檔或任何一支對不上就停。驗法沒全過、或跑的是突變，它會刪掉登記。
REG="$(git rev-parse --git-path pushsafe-verified)"
if [ ! -f "$REG" ]; then
  echo "PUSHSAFE: 沒有驗法登記（沒跑過 bash scripts/test_pushsafe.sh，或上次沒全過），沒有推送"; rm -f "$LOG"; exit 1
fi
stale=""
for f in scripts/pushsafe.sh scripts/selfcheck_public.py scripts/test_pushsafe.sh scripts/lint_gate.py scripts/lib/verified_reg.py; do
  now="$(git rev-parse "HEAD:$f" 2>/dev/null)"
  reg="$(awk -v f="$f" '$1 == f { print $2 }' "$REG")"
  if [ -z "$now" ] || [ "$now" != "$reg" ]; then stale="$stale $f"; fi
done
if [ -n "$stale" ]; then
  echo "PUSHSAFE: 這幾支改過、還沒重跑驗法（登記的雜湊對不上）：$stale；先跑 bash scripts/test_pushsafe.sh，沒有推送"; rm -f "$LOG"; exit 1
fi

# 00) 閘門、自查、驗法本身有沒有已知的壞寫法（共用慣例 v9 §5.16；檢查器壞了也停）
python scripts/lint_gate.py > "$LOG" 2>&1
rc=$?
cat "$LOG"
if [ $rc -ne 0 ]; then echo "PUSHSAFE: 閘門腳本有已知的壞寫法或檢查器壞了（rc=$rc），沒有推送"; rm -f "$LOG"; exit 1; fi

# 0) 先拿遠端的最新狀態，自查才算得出「所有還沒推的 commit」
timeout 90 git -c credential.helper="$HELPER" fetch -q origin main > "$LOG" 2>&1
rc=$?
if [ $rc -ne 0 ]; then cat "$LOG"; echo "PUSHSAFE: 取不到遠端的最新狀態（rc=$rc），沒有推送"; rm -f "$LOG"; exit 1; fi

# 0.5) 題庫建置改過就要重跑它的驗法（F9，四家統一）：test_datacheck.py 全部符合時，把下面四支（題庫建置三支＋登記的共用判斷）「已 commit 版本」
#      的雜湊登記進 .logs/datacheck-verified（不進版控）。只在「這次要推的 commit 動到這四支」時才看登記——
#      範圍照遠端的實際狀態算（上一步剛 fetch）。閘門本身那幾支不在這裡，照 000) 一律要先驗（新 clone 也一樣）。
DGUARD="scripts/build_data.py scripts/check_data.py scripts/test_datacheck.py scripts/lib/verified_reg.py"
touched="$(git log --pretty=tformat: --name-only origin/main..HEAD -- $DGUARD)"
rc=$?
if [ $rc -ne 0 ]; then echo "PUSHSAFE: 算不出這次要推的 commit 動到哪些檔（rc=$rc），沒有推送"; rm -f "$LOG"; exit 4; fi
if [ -n "$(printf '%s' "$touched" | tr -d '[:space:]')" ]; then
  DREG=.logs/datacheck-verified
  dstale=""
  for f in $DGUARD; do
    now="$(git rev-parse "HEAD:$f" 2>/dev/null)"
    reg=""
    [ -f "$DREG" ] && reg="$(awk -v f="$f" '$1 == f { print $2 }' "$DREG")"
    if [ -z "$now" ] || [ "$now" != "$reg" ]; then dstale="$dstale $f"; fi
  done
  if [ -n "$dstale" ]; then
    echo "PUSHSAFE: 這次要推的 commit 動到題庫建置或它的驗法，F8 驗法登記對不上（$([ -f "$DREG" ] && echo "改過沒重跑：$dstale" || echo '沒有登記')）；先跑 python scripts/test_datacheck.py，沒有推送"
    rm -f "$LOG"; exit 4
  fi
fi

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
