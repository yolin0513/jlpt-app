#!/usr/bin/env bash
# 推送閘門（共用慣例 §2.5）：推送一律用這支，不要直接下 git push。
#   bash scripts/pushsafe.sh
# 三關，每關失敗都讓後面停下，各自的回傳值：
#   1  沒有驗法登記或閘門改過沒重跑驗法、閘門腳本有已知的壞寫法（lint_gate.py）、自查失敗（有命中、對照組沒命中、取不到使用者名稱、沒有要推的 commit），或取不到遠端的最新狀態——沒有推
#   2  推送失敗
#   3  推送回報成功，但遠端 main 不等於開跑時鎖定的那個 commit
#   5  推上去的是鎖定的那個 commit，但推送期間本機 main 多了 commit（那些沒有被推、也沒有被自查）
#   1  （也包括）環境裡設了 git 自己認得的 GIT_ 變數（白名單以外）
#   1  （也包括）共用慣例副本跟主檔不一致或讀不到主檔（convcheck.py，2026-10-08）
#   4  這次要推的 commit 動到題庫建置或它的驗法，卻沒有對得上的 F8 驗法登記（沒重跑 test_datacheck.py）——沒有推
#   0  推上去了，而且遠端＝鎖定的 commit＝本機 main
# 會決定成敗的指令一律不接管線（管線的回傳值是最後一個指令的，會吞掉失敗）；輸出導到檔案再印。
# 改過這支或 selfcheck_public.py，就重跑 scripts/test_pushsafe.sh（分別製造每一關的失敗）。
set -u
set -o pipefail

# 0000) git 自己認得的環境變數（2026-09-25）：GIT_DIR、GIT_WORK_TREE、GIT_INDEX_FILE、GIT_OBJECT_DIRECTORY、GIT_COMMON_DIR、
#       GIT_CEILING_DIRECTORIES、GIT_CONFIG_COUNT／KEY／VALUE……不需要任何程式定義，只要剛好設在環境裡，整個閘門就會
#       對著別的 repo、別的設定跑完全套檢查然後說通過——程式碼裡什麼都看不到。所以在第一個 git 指令之前擋：
#       GIT_ 開頭的一律擋（不逐一列舉，git 以後新增的也擋得到），只放行不影響「看哪個 repo、哪些物件、哪份設定、推去哪」的
#       白名單。【已知限制】git 也讀 HOME／XDG_CONFIG_HOME 底下的設定檔與系統設定（例如 url.<x>.insteadOf 可以改寫推送目標），
#       那些不是 GIT_ 變數、這裡不擋；見證據檔。
badenv=""
for v in $(compgen -e); do
  case "$v" in
    GIT_EDITOR|GIT_PAGER|GIT_TERMINAL_PROMPT) ;;
    GIT_*) badenv="$badenv $v" ;;
  esac
done
if [ -n "$badenv" ]; then
  echo "PUSHSAFE: 環境裡設了 git 自己認得的變數：$badenv——可能讓閘門對著別的 repo 或設定跑完再說通過；先 unset 再推，沒有推送"; exit 1
fi

cd "$(git rev-parse --show-toplevel)" || exit 1

# 00000) 鎖定這一次要推的 commit（2026-10-03，Dispatch 轉 StockDiary／MealMate 的發現）：
#        原本每一關各自取當下的 HEAD、推送推「推送那一刻」的 main、推完拿推送之後才取的 HEAD 比——
#        自查之後、推送之前多出一個 commit，它會被一起推上去，而且核對時兩邊相等、照樣印「推送成功」。
#        現在開跑時記下 main 的 commit 編號（HEAD 必須就在 main 上），之後的登記比對、F9、自查、推送、推完核對都只看它。
PIN="$(git rev-parse --verify -q refs/heads/main)"
if [ -z "$PIN" ]; then echo "PUSHSAFE: 讀不到本機的 main，沒有推送"; exit 1; fi
CUR="$(git symbolic-ref -q HEAD)"
if [ "$CUR" != refs/heads/main ]; then
  echo "PUSHSAFE: HEAD 不在 main 上（${CUR:-detached}）——推的是 main、驗的會是別的東西，沒有推送"; exit 1
fi
echo "PUSHSAFE: 這一次鎖定 main＝${PIN:0:7}（之後每一關都只看這個 commit）"
LOG="$(mktemp)"
HELPER='!"$HOME/AppData/Local/Temp/gh-cli/bin/gh.exe" auth git-credential'   # gh 的位置見 STATUS §8
export GIT_TERMINAL_PROMPT=0 GH_CONFIG_DIR="$HOME/.config/gh"

# 0000) 共用慣例副本跟主檔一致（2026-10-08，Dispatch：過期的副本跟現行的讀起來一樣，沒有任何東西會說；本 App 的副本停在 v9 兩週）：
#       讀不到主檔、副本與主檔是同一個實體檔、版本行不同、版本同全文不同，都停（判定在 scripts/convcheck.py）。
#       換一台沒有統籌工作區的機器會停在這裡——刻意的，不要改成靜默跳過。
#       比的是工作區的副本（Session 讀的就是它），不是 $PIN 裡的；副本改了沒 commit 時兩者會不同，這是已知限制。
python scripts/convcheck.py > "$LOG" 2>&1
crc=$?
cat "$LOG"
if [ $crc -ne 0 ]; then echo "PUSHSAFE: 共用慣例副本檢查沒過（$(tail -1 "$LOG")），沒有推送"; rm -f "$LOG"; exit 1; fi

# 000) 改過閘門就要重跑驗法——機器擋（共用慣例 v9 §5.15，J7，照 MealMate 的登記制）：
#      test_pushsafe.sh 全部符合時，把下面四支「已 commit 版本」的雜湊寫進 .git/pushsafe-verified；
#      這裡比對鎖定的那個 commit（$PIN），沒有登記檔或任何一支對不上就停。驗法沒全過、或跑的是突變，它會刪掉登記。
REG="$(git rev-parse --git-path pushsafe-verified)"
if [ ! -f "$REG" ]; then
  echo "PUSHSAFE: 沒有驗法登記（沒跑過 bash scripts/test_pushsafe.sh，或上次沒全過），沒有推送"; rm -f "$LOG"; exit 1
fi
stale=""
for f in scripts/pushsafe.sh scripts/selfcheck_public.py scripts/test_pushsafe.sh scripts/lint_gate.py scripts/lib/verified_reg.py scripts/test_verified_reg.py scripts/test_selfcheck_meta.py scripts/lib/gitenv.py scripts/convcheck.py; do
  now="$(git rev-parse "$PIN:$f" 2>/dev/null)"
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
touched="$(git log --pretty=tformat: --name-only "origin/main..$PIN" -- $DGUARD)"
rc=$?
if [ $rc -ne 0 ]; then echo "PUSHSAFE: 算不出這次要推的 commit 動到哪些檔（rc=$rc），沒有推送"; rm -f "$LOG"; exit 4; fi
if [ -n "$(printf '%s' "$touched" | tr -d '[:space:]')" ]; then
  DREG=.logs/datacheck-verified
  dstale=""
  for f in $DGUARD; do
    now="$(git rev-parse "$PIN:$f" 2>/dev/null)"
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
python scripts/selfcheck_public.py origin/main "$PIN" > "$LOG" 2>&1
rc=$?
cat "$LOG"
if [ $rc -ne 0 ]; then echo "PUSHSAFE: 自查失敗（rc=$rc），沒有推送"; rm -f "$LOG"; exit 1; fi

# 2) 推送
timeout 90 git -c credential.helper="$HELPER" push origin "$PIN:refs/heads/main" > "$LOG" 2>&1
rc=$?
cat "$LOG"
if [ $rc -ne 0 ]; then echo "PUSHSAFE: 推送失敗（rc=$rc）"; rm -f "$LOG"; exit 2; fi

# 3) 推送後：遠端 main 必須等於鎖定的那個 commit（不是推送之後才取的 HEAD）
timeout 90 git -c credential.helper="$HELPER" ls-remote origin refs/heads/main > "$LOG" 2>&1
rc=$?
remote="$(cut -f1 "$LOG")"
rm -f "$LOG"
if [ $rc -ne 0 ] || [ -z "$remote" ] || [ "$remote" != "$PIN" ]; then
  echo "PUSHSAFE: 遠端與鎖定的 commit 不一致（ls-remote rc=$rc remote=${remote:0:7} 鎖定=${PIN:0:7}）"; exit 3
fi
# 推完本機 main 已經不是鎖定的那個：過程中多了 commit——它們沒有被推、也沒有被自查，另外報（回 5）
nowmain="$(git rev-parse --verify -q refs/heads/main)"
if [ "$nowmain" != "$PIN" ]; then
  echo "PUSHSAFE: 推上去的是鎖定的 ${PIN:0:7}（遠端＝${remote:0:7}），但推送期間本機 main 多了 commit（現在 ${nowmain:0:7}）——那些沒有被推、也沒有被自查；要推就再跑一次閘門"; exit 5
fi
echo "PUSHSAFE: 推送成功，遠端＝鎖定的 commit＝本機 main＝${PIN:0:7}"
exit 0
