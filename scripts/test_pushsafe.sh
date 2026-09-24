#!/usr/bin/env bash
# 推送閘門的驗法（共用慣例 §2.5、§5.11、§5.15）：用實際推送的那一支 scripts/pushsafe.sh，分別製造每一關的失敗，
# 而且每一種都比對「是哪一關、哪一類擋的」，不是只比回傳值。
#   bash scripts/test_pushsafe.sh                              # 正常：全部符合回 0，並登記四支閘門檔案的雜湊
#   （預設：正常順序跑一輪、反過來再跑一輪，逐個情境比對兩輪結果一樣才算全過——J8 的「換序結果不變」每次都驗）
#   TEST_PUSHSAFE_ORDER=normal|reverse bash scripts/test_pushsafe.sh  # 只跑一個順序（除錯用；不會登記）
#   TEST_PUSHSAFE_MUTATE=<突變> bash scripts/test_pushsafe.sh   # 突變：nofetch nometa oldparse nocheck oldparse+nocheck nolint noregistry nof9 f9always
# 完全不碰 GitHub：在暫存目錄建一個 bare repo 當假遠端，複製本 repo「已 commit 的內容」過去跑。
# 所以改了閘門要先在本機 commit（先不推）再跑這支。
# 登記（J7）：正常跑、全部符合時，把 pushsafe.sh、selfcheck_public.py、test_pushsafe.sh、lint_gate.py 被驗的那一版雜湊
# 寫進 .git/pushsafe-verified；沒全過或跑的是突變，就刪掉登記——pushsafe.sh 第一步會比對，沒有登記或對不上就不推。
# 每個情境都自己準備前提、跑完還原到同一個起點（本機＝假遠端＝BASE、工作區乾淨），所以順序換了結果也不變。
# 改檔與找字串一律用下面寫在檔案裡的 Python（共用慣例 §5.5：樣式不寫在 shell 指令列）。
set -u
SRC="$(git rev-parse --show-toplevel)" || exit 1
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"   # 正在跑的這支（絕對路徑；下面會 cd 進複本）
BAR="$(printf '\174')"   # 管線字元另外組：這支檔本身的文字不能出現「git … 接管線」（lint 會掃這支）；突變也要用，所以放最前面
SRC_REG="$(cd "$SRC" && git rev-parse --path-format=absolute --git-path pushsafe-verified)"
T="$(mktemp -d)"
cleanup() { chmod -R u+w "$T" 2>/dev/null; rm -r "$T" 2>/dev/null; }
trap cleanup EXIT
FILES="scripts/pushsafe.sh scripts/selfcheck_public.py scripts/test_pushsafe.sh scripts/lint_gate.py scripts/lib/verified_reg.py"
die() { echo "ABORT: $*（造情境失敗，不帶著沒造成的情境往下驗）"; rm -f "$SRC_REG"; exit 2; }
MUTATE="${TEST_PUSHSAFE_MUTATE:-}"
ORDER="${TEST_PUSHSAFE_ORDER:-}"
[ -z "$ORDER" ] && { [ -n "$MUTATE" ] && ORDER=normal || ORDER=both; }

# ---- Python 小工具：改檔（錨點必須恰好一處）、查某段文字在不在 ----
pyedit() {  # pyedit 檔案 錨點 取代成
  python - "$@" <<'PY'
import sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8', newline='').read()
if s.count(a) != 1:
    print(f'錨點出現 {s.count(a)} 次（應為 1）：{a[:60]!r}'); sys.exit(1)
open(p, 'w', encoding='utf-8', newline='').write(s.replace(a, b))
PY
}
pycut() {  # pycut 檔案 起點錨點 終點錨點：刪掉 [起點, 終點) 那一段
  python - "$@" <<'PY'
import sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8', newline='').read()
if s.count(a) != 1 or s.count(b) != 1:
    print('錨點不是恰好一處'); sys.exit(1)
i, j = s.index(a), s.index(b)
open(p, 'w', encoding='utf-8', newline='').write(s[:i] + s[j:])
PY
}
has_text() {  # has_text 檔案 文字：在 → 0，不在 → 1
  python - "$@" <<'PY'
import sys
sys.exit(0 if sys.argv[2] in open(sys.argv[1], encoding='utf-8').read() else 1)
PY
}
show_head() {  # show_head 路徑：HEAD 的那一版寫到 $T/show.txt；git show 失敗就中止（不讓空輸入被判成「沒有」）
  git show "HEAD:$1" > "$T/show.txt" 2> "$T/show.err" || die "git show HEAD:$1 失敗（$(head -1 "$T/show.err")）"
  [ -s "$T/show.txt" ] || die "git show HEAD:$1 取到空的"
}

# ---- 比對「是誰擋的」：輸出裡必須有 must 的每一句、不能有 -- 後面的任何一句（都用固定字串比） ----
reason_ok() {  # reason_ok 檔案 must... [-- mustnot...]
  # must 只認「判定訊息」那幾行：PUSHSAFE:／SELF-CHECK／LINT-GATE 開頭，以及 lint 逐條報的「命中（沒登記）」
  # 與對照組失敗（固定縮排＋固定開頭）。自查會把命中的內容原樣印出來（縮排四格），只數「整份輸出有沒有出現」的話，
  # 命中內容裡剛好有那幾個字就會被誤當成擋下理由。mustnot 仍看整份（寧可多報不符）。
  local f="$1"; shift
  local mode=must s msg="$f.msg"
  grep -E '^(PUSHSAFE:|SELF-CHECK |LINT-GATE |  命中（沒登記）：|   對照組沒命中：|   反例被誤抓：|   孤兒檢查的對照組不對：)' "$f" > "$msg"
  for s in "$@"; do
    if [ "$s" = "--" ]; then mode=not; continue; fi
    if [ $mode = must ]; then grep -qF -- "$s" "$msg" || return 1
    else grep -qF -- "$s" "$f" && return 1; fi
  done
  return 0
}
# §5.11 第二層：比對函式自己的對照組——餵已知的輸出，確認該抓的抓得到、不該過的會擋
S1="$T/sample1.txt"; S2="$T/sample2.txt"
printf '%s\n' 'PUSHSAFE: 自查失敗（rc=1），沒有推送' 'SELF-CHECK FAILED: path 命中 1 行' > "$S1"
printf '%s\n' 'PUSHSAFE: 自查失敗（rc=1），沒有推送' 'SELF-CHECK FAILED: origin/main..HEAD 沒有要推的 commit' > "$S2"
reason_ok "$S1" 'path 命中' -- '沒有要推的 commit' || die "比對函式抓不到已知的『path 命中』"
reason_ok "$S2" 'path 命中' && die "比對函式把『沒有要推的 commit』當成『path 命中』"
reason_ok "$S1" 'PUSHSAFE: 自查失敗' -- 'path 命中' && die "比對函式沒擋下不該出現的句子"
S3="$T/sample3.txt"   # 那句話只出現在自查原樣印出的命中內容裡，判定訊息講的是別的理由
printf '%s\n' 'path: control_hit=True added_hits=1 meta_hits=0' '    path 命中 1 行（新增行）' 'SELF-CHECK FAILED: email 對照組沒命中' 'PUSHSAFE: 自查失敗（rc=1），沒有推送' > "$S3"
reason_ok "$S3" 'path 命中 1 行（新增行）' && die "比對函式把命中內容裡的字當成擋下理由"
reason_ok "$S3" 'email 對照組沒命中' || die "比對函式抓不到判定訊息裡的理由"
S4="$T/sample4.txt"   # lint 逐條報的兩種縮排行要認得；同樣的字縮排四格（自查印命中內容的格式）不能認
printf '%s\n' '  命中（沒登記）：scripts/pushsafe.sh:70 [pipe] x' '   對照組沒命中：pipe 抓不到 x' '    反例被誤抓：y' 'LINT-GATE FAILED: 1 處已知的壞寫法' > "$S4"
reason_ok "$S4" '命中（沒登記）' '對照組沒命中' || die "比對函式抓不到 lint 逐條報的理由"
reason_ok "$S4" '反例被誤抓' && die "比對函式把縮排四格的命中內容當成 lint 的理由"
echo "比對函式的對照組：7/7 符合"

# ---- 假遠端與工作複本 ----
git init -q --bare "$T/remote.git" || die "建假遠端"
git clone -q --no-local "$SRC" "$T/work" || die "複製"
cd "$T/work" || die "進工作複本"
# 取新版也要先證明它真的是新版：複本是 HEAD 的內容，正在跑的這支驗法必須跟 HEAD 的一模一樣（改了沒 commit，
# 跑到的閘門就是舊的，新加的情境會對著舊閘門驗）；本機工作區的四支閘門檔也要跟 HEAD 一樣，登記才對得上實際的內容
cmp -s "$SELF" scripts/test_pushsafe.sh || die "正在跑的驗法跟 HEAD 的不一樣（還沒 commit？），跑到的會是舊的閘門"
TESTED_HEAD="$(git rev-parse HEAD)"
# 情境 23 用：只跑到這裡（開頭的檢查）就結束，不跑情境、不登記
if [ "${TEST_PUSHSAFE_STARTUP_ONLY:-}" = 1 ]; then echo "TEST-PUSHSAFE: STARTUP-ONLY OK（開頭的檢查都過了，沒跑情境、不登記）"; exit 0; fi
git -C "$SRC" diff --quiet HEAD -- $FILES || echo "注意：本機工作區的閘門檔跟 HEAD 不一樣，這一輪跑完也不會登記"
git remote set-url origin "$T/remote.git" || die "設遠端"
git config user.name test
git config user.email "test@users.noreply.github.com"
register_clone() {  # 複本自己的登記：讓「登記」那一關放行，才驗得到後面幾關
  : > "$(git rev-parse --git-path pushsafe-verified)"
  for f in $FILES; do printf '%s %s\n' "$f" "$(git rev-parse "HEAD:$f")" >> "$(git rev-parse --git-path pushsafe-verified)"; done
}

# ---- 突變：先確認改壞之前那段文字在，改壞、commit，再確認它不在（§5.11 第三層、J5） ----
mutate() {  # mutate 檔案 改壞之前一定在的文字 ——之後呼叫者自己改檔
  show_head "$1"; has_text "$T/show.txt" "$2" || die "改壞之前 HEAD:$1 裡就沒有「$2」，突變的前提不成立"
}
confirm_mutated() {  # confirm_mutated 檔案 改壞之後不該在的文字
  git commit -q -am "MUTATION: $MUTATE" || die "commit 改壞的版本"
  show_head "$1"; has_text "$T/show.txt" "$2" && die "改壞之後 HEAD:$1 裡還有「$2」，突變沒生效"
  git diff --quiet HEAD -- "$1" || die "工作區的 $1 跟 HEAD 不同，跑到的不是改壞的那一版"
}
PS=scripts/pushsafe.sh; SC=scripts/selfcheck_public.py
case "$MUTATE" in
  "") ;;
  nofetch)
    mutate $PS 'fetch -q origin main'; pycut $PS '# 0) 先拿遠端的最新狀態' '# 1) 自查' || die "改壞閘門"
    confirm_mutated $PS 'fetch -q origin main' ;;
  nometa)
    mutate $SC 'mhits = scan(meta)'; pyedit $SC '    mhits = scan(meta)' '    mhits = []' || die "改壞自查"
    confirm_mutated $SC 'mhits = scan(meta)' ;;
  oldparse|nocheck|oldparse+nocheck)
    [ "$MUTATE" != nocheck ] && { mutate $SC 'added = extract_added(patch)'; pyedit $SC 'added = extract_added(patch)' "added = [l[1:] for l in patch.split('\\n') if l.startswith('+') and not l.startswith('+++')]" || die "改壞抽法"; }
    [ "$MUTATE" != oldparse ] && { mutate $SC 'git 算'; pycut $SC '# ---- 核對行數' '# ---- 核對結束 ----' || die "拿掉核對"; }
    python -m py_compile $SC || die "改壞之後自查連編譯都過不了，紅的理由會不對"
    [ "$MUTATE" != nocheck ] && confirm_mutated $SC 'added = extract_added(patch)'
    [ "$MUTATE" = nocheck ] && confirm_mutated $SC 'git 算'
    [ "$MUTATE" = oldparse+nocheck ] && { show_head $SC; has_text "$T/show.txt" 'git 算' && die "HEAD 裡的核對還在"; } ;;
  nolint)
    mutate $PS 'if [ $rc -ne 0 ]; then echo "PUSHSAFE: 閘門腳本有已知的壞寫法'
    pyedit $PS 'if [ $rc -ne 0 ]; then echo "PUSHSAFE: 閘門腳本有已知的壞寫法' 'if false; then echo "PUSHSAFE: 閘門腳本有已知的壞寫法' || die "改壞閘門"
    confirm_mutated $PS 'if [ $rc -ne 0 ]; then echo "PUSHSAFE: 閘門腳本有已知的壞寫法' ;;
  regclean)   # 登記的共用判斷把「工作區跟 HEAD 不一樣」一律當作沒改動（統籌者 2026-09-24 查出缺口用的突變）
    mutate scripts/lib/verified_reg.py '        if rc == 1:'
    pyedit scripts/lib/verified_reg.py '        if rc == 1:' '        if False:' || die "改壞登記判斷"
    confirm_mutated scripts/lib/verified_reg.py '        if rc == 1:' ;;
  noselfhead)   # 拿掉「正在跑的驗法必須跟 HEAD 一樣」那道。改的是這支自己：錨點在執行時才組（|| 用 BAR 拼），
    # 否則這幾行也含同一段字面、錨點就不是恰好一處
    A="cmp -s \"\$SELF\" scripts/test_pushsafe.sh $BAR$BAR"
    mutate scripts/test_pushsafe.sh "$A"
    pyedit scripts/test_pushsafe.sh "$A" "true $BAR$BAR" || die "改壞驗法"
    confirm_mutated scripts/test_pushsafe.sh "$A" ;;
  nof9)   # F9 那一關看了登記、對不上也放行
    mutate $PS 'if [ -n "$dstale" ]; then'
    pyedit $PS 'if [ -n "$dstale" ]; then' 'if [ -n "$dstale" ] && false; then' || die "改壞閘門"
    confirm_mutated $PS 'if [ -n "$dstale" ]; then' ;;
  f9always)   # F9 那一關不管這次動到什麼都要登記（「只在動到被守的檔時才看」被拿掉）
    mutate $PS "if [ -n \"\$(printf '%s' \"\$touched\""
    pyedit $PS "if [ -n \"\$(printf '%s' \"\$touched\" $BAR tr -d '[:space:]')\" ]; then" 'if true; then' || die "改壞閘門"
    confirm_mutated $PS "if [ -n \"\$(printf '%s' \"\$touched\"" ;;
  noregistry)
    # 字面留著、只讓條件失效：若把整行換掉，lint 登記的例外就對不上、變成「例外過期」，
    # lint 會在第一步把所有情境都擋下——紅了，但不是被「拿掉登記檢查」弄紅的（2026-09-24 第一版就這樣被污染）
    mutate $PS 'if [ ! -f "$REG" ]; then'
    pyedit $PS 'if [ ! -f "$REG" ]; then' 'if [ ! -f "$REG" ] && false; then' || die "改壞閘門"
    pyedit $PS 'if [ -n "$stale" ]; then' 'if [ -n "$stale" ] && false; then' || die "改壞閘門"
    confirm_mutated $PS 'if [ ! -f "$REG" ]; then' ;;
  *) die "不認得的突變 $MUTATE" ;;
esac
[ -n "$MUTATE" ] && echo "MUTATION ACTIVE: $MUTATE（已確認改壞之前那段在、改壞之後不在，HEAD 與工作區一致）"
register_clone
git push -q origin main || die "初始推送到假遠端"
BASE="$(git --git-dir="$T/remote.git" rev-parse main)"
[ -n "$BASE" ] || die "讀不到假遠端的起點（比對「假遠端沒動」時兩邊都是空的會恆真）"

rhead() { git --git-dir="$T/remote.git" rev-parse --short main; }
restore() {  # 還原到起點：假遠端＝本機＝BASE、工作區乾淨、沒有 hook、遠端網址正確、登記對得上
  rm -f "$T/remote.git/hooks/pre-receive" "$T/remote.git/hooks/post-receive"
  git remote set-url origin "$T/remote.git" || die "還原遠端網址"
  git --git-dir="$T/remote.git" update-ref refs/heads/main "$BASE" || die "還原假遠端"
  git fetch -q origin main || die "還原追蹤分支"
  git reset -q --hard "$BASE" && git clean -fdq && rm -rf .logs || die "還原工作區"   # .logs 被 gitignore，clean 不會清
  register_clone
}
at_start() {  # 每個情境開始前確認起點真的一樣（互不污染）
  [ "$(git rev-parse HEAD)" = "$BASE" ] && [ "$(git --git-dir="$T/remote.git" rev-parse main)" = "$BASE" ] \
    && [ -z "$(git status --porcelain)" ] || die "情境開始前起點不對（上一個情境沒還原乾淨）"
}
bad=0
declare -A RESULT   # 情境編號 → yes／no（這一輪的）
check() {  # check 名稱 期望rc 實際rc 期望假遠端(same|local) must... [-- mustnot...]
  local name="$1" want="$2" got="$3" expect="$4"; shift 4
  local after ok why=""
  after="$(rhead)"; ok=yes
  [ -n "$after" ] || die "讀不到假遠端的 HEAD（兩邊都是空的，「假遠端沒動」會恆真）"
  [ "$got" = "$want" ] || { ok=no; why="回傳值"; }
  if [ "$expect" = same ]; then [ "$after" = "$(git rev-parse --short "$BASE")" ] || { ok=no; why="$why 假遠端被動到"; }
  else [ "$after" = "$(git rev-parse --short HEAD)" ] || { ok=no; why="$why 假遠端≠本機"; }; fi
  reason_ok "$T/out.txt" "$@" || { ok=no; why="$why 擋下理由不對"; }
  [ "$ok" = yes ] || bad=1
  RESULT["${name%% *}"]="$ok"
  printf '%-4s %-40s rc=%s(期望 %s)  %s\n' "$ok" "$name" "$got" "$want" "${why:+（$why）}"
  # 不符時印出閘門實際的擋下訊息，才看得出是被什麼擋的（或為什麼沒擋）
  [ "$ok" = yes ] || grep -E 'SELF-CHECK FAILED|PUSHSAFE:|LINT-GATE' "$T/out.txt" | sed 's/^/       實際：/'
}
run() { rm -f "$T/out.txt"; bash scripts/pushsafe.sh > "$T/out.txt" 2>&1; echo $?; }
hitfile() { printf '%s%s\n' 'path E' ':\foo' > "$1"; }   # 當場組出來的合成樣本（本機路徑的形狀）
clean_commit() { echo "clean $1 $(date +%s%N)" > "clean_$1.txt"; git add "clean_$1.txt" && git commit -q -m "clean $1" || die "造乾淨的 commit（$1）"; }

s01() { at_start; hitfile hit.txt; git add hit.txt && git commit -q -m "synthetic hit" || die "造命中的 commit"
  rc="$(run)"; check "01 新增行命中自查" 1 "$rc" same 'PUSHSAFE: 自查失敗' 'path 命中 1 行（新增行）' -- '（commit 訊息或作者欄）' '沒有要推的 commit' '取不到遠端'; restore; }
s02() { at_start; clean_commit 02
  pyedit $SC "'example' + '.org'" "'example' + '.o'" > /dev/null || die "改自查的 email 對照組"
  has_text $SC "'example' + '.o'" || die "沒改到自查的 email 對照組"
  rc="$(run)"; check "02 自查的對照組壞掉" 1 "$rc" same 'PUSHSAFE: 自查失敗' 'email 對照組沒命中' -- '取不到遠端'; restore; }
s03() { at_start; clean_commit 03; git remote set-url origin "$T/nope.git" || die "改遠端網址"
  rc="$(run)"; check "03 抓不到遠端" 1 "$rc" same 'PUSHSAFE: 取不到遠端的最新狀態' -- 'SELF-CHECK' '推送失敗'; restore; }
s04() { at_start; clean_commit 04
  printf '#!/bin/sh\nexit 1\n' > "$T/remote.git/hooks/pre-receive" && chmod +x "$T/remote.git/hooks/pre-receive" || die "放 pre-receive"
  rc="$(run)"; check "04 推送被拒（pre-receive）" 2 "$rc" same 'SELF-CHECK OK' 'PUSHSAFE: 推送失敗' -- '遠端與本機不一致' '推送成功'; restore; }
s05() { at_start; clean_commit 05
  printf '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && git update-ref refs/heads/main "$old"; done\n' > "$T/remote.git/hooks/post-receive" \
    && chmod +x "$T/remote.git/hooks/post-receive" || die "放 post-receive"
  rc="$(run)"; check "05 推了遠端卻沒更新（post-receive）" 3 "$rc" same 'SELF-CHECK OK' 'PUSHSAFE: 遠端與本機不一致' -- '推送成功'; restore; }
s06() { at_start; clean_commit 06
  rc="$(run)"; check "06 全部正常" 0 "$rc" local 'SELF-CHECK OK' 'PUSHSAFE: 推送成功'; restore; }
s07() { at_start
  rc="$(run)"; check "07 沒有要推的 commit" 1 "$rc" same 'PUSHSAFE: 自查失敗' '沒有要推的 commit' -- 'path 命中'; restore; }
s08() { at_start; hitfile hit8.txt; git add hit8.txt && git commit -q -m "synthetic hit 8" || die "造命中的 commit（08）"
  local hit8; hit8="$(git rev-parse HEAD)"
  git push -q origin main && git fetch -q origin main || die "把命中的 commit 推上假遠端再抓回來"
  git --git-dir="$T/remote.git" update-ref refs/heads/main "$BASE" || die "倒退假遠端"
  [ "$(git rev-parse origin/main)" = "$hit8" ] || die "本機的追蹤分支沒指著命中的 commit（前提沒造成）"
  clean_commit 08
  rc="$(run)"; check "08 本機以為已推、遠端被倒退" 1 "$rc" same 'PUSHSAFE: 自查失敗' 'path 命中' -- '推送成功' '沒有要推的 commit'
  git --git-dir="$T/remote.git" merge-base --is-ancestor "$hit8" main 2>/dev/null && echo "       帶命中的 commit 到了假遠端：是"
  restore; }
s09() { at_start; echo "m9 $(date +%s%N)" > m9.txt
  git add m9.txt && git commit -q -m "$(printf '%s%s' 'msg path E' ':\foo')" || die "造訊息帶命中的 commit"
  rc="$(run)"; check "09 命中寫在 commit 訊息裡" 1 "$rc" same 'PUSHSAFE: 自查失敗' 'path 命中 1 行（commit 訊息或作者欄）' -- '（新增行）' '沒有要推的 commit'; restore; }
s10() { at_start; echo "m10 $(date +%s%N)" > m10.txt
  git add m10.txt && git -c user.email="$(printf '%s@%s' 'someone' 'example.org')" commit -q -m "author test" || die "造作者信箱的 commit"
  rc="$(run)"; check "10 作者信箱不是 noreply" 1 "$rc" same 'PUSHSAFE: 自查失敗' 'email 命中' '（commit 訊息或作者欄）' -- '（新增行）' '沒有要推的 commit'; restore; }
s11() { at_start; printf '%s%s%s\n' '++ ' 'path E' ':\foo' > pp.txt
  git add pp.txt && git commit -q -m "pp add" || die "造 ++ 開頭的 commit"
  local pp1; pp1="$(git rev-parse HEAD)"
  git rm -q pp.txt && git commit -q -m "pp del" || die "造刪掉它的 commit"
  rc="$(run)"; check "11 ++ 開頭的命中、加了又刪" 1 "$rc" same 'PUSHSAFE: 自查失敗' 'path 命中 1 行（新增行）' -- '抽取壞了' '沒有要推的 commit'
  git --git-dir="$T/remote.git" merge-base --is-ancestor "$pp1" main 2>/dev/null && echo "       帶命中的 commit（11）到了假遠端：是"
  restore; }
s12() { at_start; git rm -q README.md && git commit -q -m "delete only" || die "造只刪不增的 commit"
  rc="$(run)"; check "12 只刪不增（要放行）" 0 "$rc" local 'SELF-CHECK OK' 'PUSHSAFE: 推送成功' -- '抽取壞了'; restore; }
s13() { at_start
  printf '%s %s cat\n' 'git fetch -q origin main' "$BAR" >> $PS   # 被掃的腳本寫回一行壞寫法（放在 exit 0 之後，不會被執行）
  git commit -q -am "bad line in gate" || die "造壞寫法的 commit"
  register_clone   # 讓登記那一關放行：這一種驗的是 lint，不是登記
  rc="$(run)"; check "13 被掃的腳本寫回壞寫法" 1 "$rc" same 'PUSHSAFE: 閘門腳本有已知的壞寫法' '命中（沒登記）' -- 'SELF-CHECK'; restore; }
s14() { at_start
  pyedit scripts/lint_gate.py "'git fetch -q origin main ' + BAR + ' cat'" "'git fetch -q origin main ' + ' cat'" > /dev/null || die "改 lint 的對照組"
  git commit -q -am "break lint control" || die "造 lint 對照組壞掉的 commit"
  register_clone
  rc="$(run)"; check "14 lint 自己的對照組壞掉" 1 "$rc" same 'PUSHSAFE: 閘門腳本有已知的壞寫法或檢查器壞了' '對照組沒命中' -- 'SELF-CHECK'; restore; }
s15() { at_start; clean_commit 15; rm -f "$(git rev-parse --git-path pushsafe-verified)"
  rc="$(run)"; check "15 沒有驗法登記" 1 "$rc" same '沒有驗法登記' -- 'LINT-GATE' 'SELF-CHECK'; restore; }
s16() { at_start; printf '%s\n' '# 改過一行，沒重跑驗法' >> $PS; git commit -q -am "touch gate" || die "改閘門的 commit"
  rc="$(run)"; check "16 閘門改過、沒重跑驗法" 1 "$rc" same '還沒重跑驗法' 'scripts/pushsafe.sh' -- 'LINT-GATE' 'SELF-CHECK'; restore; }

# F9：這次要推的 commit 動到題庫建置（build_data.py）時才看 .logs/datacheck-verified；沒動到的（例如 06、12）不看、照樣放行
touch_build() { printf '%s\n' "# touch $1" >> scripts/build_data.py && git commit -q -am "touch build $1" || die "改題庫建置的 commit（$1）"; }
f9_register() {  # f9_register [stale]：寫複本自己的 F9 登記（stale＝登記成改之前那一版的雜湊）
  local ref=HEAD; [ "${1:-}" = stale ] && ref=HEAD~1
  mkdir -p .logs && : > .logs/datacheck-verified || die "建 .logs"
  for f in scripts/build_data.py scripts/check_data.py scripts/test_datacheck.py scripts/lib/verified_reg.py; do
    printf '%s %s\n' "$f" "$(git rev-parse "$ref:$f")" >> .logs/datacheck-verified
  done
}
s17() { at_start; touch_build 17
  rc="$(run)"; check "17 動到題庫建置、沒有 F9 登記" 4 "$rc" same 'PUSHSAFE: 這次要推的 commit 動到題庫建置或它的驗法' '沒有登記' -- 'SELF-CHECK' '推送成功'; restore; }
s18() { at_start; touch_build 18; f9_register stale
  rc="$(run)"; check "18 動到題庫建置、F9 登記是舊的" 4 "$rc" same 'PUSHSAFE: 這次要推的 commit 動到題庫建置或它的驗法' '改過沒重跑' 'scripts/build_data.py' -- 'SELF-CHECK' '推送成功'; restore; }
s19() { at_start; touch_build 19; f9_register
  rc="$(run)"; check "19 動到題庫建置、F9 登記對得上（要放行）" 0 "$rc" local 'SELF-CHECK OK' 'PUSHSAFE: 推送成功'; restore; }

s22() { at_start; clean_commit 22
  mkdir -p .logs && printf '%s\n' 'scripts/build_data.py 0000000' > .logs/datacheck-verified || die "放一份對不上的 F9 登記"
  rc="$(run)"; check "22 沒動到題庫建置、F9 登記對不上也不看（要放行）" 0 "$rc" local 'SELF-CHECK OK' 'PUSHSAFE: 推送成功' -- '動到題庫建置'; restore; }

# ---- 20、21、23 驗的不是推送，是驗法自己的「登記」與「開頭檢查」：直接呼叫被測的那一段，比對回傳值、判定訊息與結果 ----
check_plain() {  # check_plain 名稱 條件成立(yes|no) 說明
  local name="$1" ok="$2" why="$3"
  [ "$ok" = yes ] || bad=1
  RESULT["${name%% *}"]="$ok"
  printf '%-4s %-40s %s\n' "$ok" "$name" "${why:+（$why）}"
}
REGHELP=scripts/lib/verified_reg.py   # 複本裡的＝HEAD 那一版（突變時是改壞的那一版）
s20() { at_start; local reg="$T/reg20"; echo old > "$reg"
  printf '%s\n' '# 改了還沒 commit' >> $PS || die "改工作區的閘門檔"
  git diff --quiet HEAD -- $PS && die "工作區的閘門檔沒有改到（前提沒造成）"
  python $REGHELP "$PWD" "$reg" "$(git rev-parse HEAD)" $FILES > "$T/out.txt" 2>&1; local rc=$?
  local ok=yes why=""
  [ $rc -eq 1 ] || { ok=no; why="回傳 $rc（期望 1）"; }
  [ -e "$reg" ] && { ok=no; why="$why 舊登記還在"; }
  grep -qF 'VERIFIED-REG: 工作區跟 HEAD 不一樣' "$T/out.txt" && grep -qF 'scripts/pushsafe.sh' "$T/out.txt" || { ok=no; why="$why 判定訊息沒講明是哪一支有改動"; }
  check_plain "20 閘門檔工作區有改動（不能登記、舊登記要刪）" "$ok" "$why"; restore; }
s21() { at_start; local reg="$T/reg21"; echo old > "$reg"
  python $REGHELP "$PWD" "$reg" "$(git rev-parse HEAD)" $FILES > "$T/out.txt" 2>&1; local rc=$?
  local ok=yes why="" want=""
  for f in $FILES; do want="$want$f $(git rev-parse "HEAD:$f")"$'\n'; done
  [ $rc -eq 0 ] || { ok=no; why="回傳 $rc（期望 0）"; }
  [ -s "$reg" ] && [ "$(cat "$reg")"$'\n' = "$want" ] || { ok=no; why="$why 登記的不是 HEAD 那一版的雜湊"; }
  grep -qF 'VERIFIED-REG: 已登記' "$T/out.txt" || { ok=no; why="$why 沒有「已登記」"; }
  check_plain "21 工作區乾淨（要登記、內容是 HEAD 的雜湊）" "$ok" "$why"; restore; }
s23() { at_start; local ok=yes why="" rc0 rc1
  # 從複本拿（HEAD 那一版；突變時是改壞的那一版），不是拿正在跑的這支——否則突變改的那一份根本沒被執行到
  cp scripts/test_pushsafe.sh "$T/copy0.sh" && cp scripts/test_pushsafe.sh "$T/copy1.sh" && printf '%s\n' '# 改了還沒 commit' >> "$T/copy1.sh" || die "複製驗法"
  TEST_PUSHSAFE_STARTUP_ONLY=1 bash "$T/copy0.sh" > "$T/out0.txt" 2>&1; rc0=$?
  TEST_PUSHSAFE_STARTUP_ONLY=1 bash "$T/copy1.sh" > "$T/out1.txt" 2>&1; rc1=$?
  [ $rc0 -eq 0 ] && grep -qF 'STARTUP-ONLY OK' "$T/out0.txt" || { ok=no; why="原樣的驗法沒過開頭檢查（對照組）"; }
  [ $rc1 -eq 2 ] && grep -qF '正在跑的驗法跟 HEAD 的不一樣' "$T/out1.txt" || { ok=no; why="$why 改過沒 commit 的驗法沒有被擋（回傳 $rc1）"; }
  check_plain "23 正在跑的驗法跟 HEAD 不一樣（要中止）" "$ok" "$why"; restore; }

LIST="s01 s02 s03 s04 s05 s06 s07 s08 s09 s10 s11 s12 s13 s14 s15 s16 s17 s18 s19 s20 s21 s22 s23"
N_SCEN=23
run_list() {  # run_list normal|reverse
  local l="$LIST"; [ "$1" = reverse ] && l="$(printf '%s\n' $LIST | sort -r | tr '\n' ' ')"
  echo "順序：$1（$l）"; RESULT=(); for s in $l; do $s; done
}
if [ "$ORDER" = both ]; then
  run_list normal; declare -A R1; for k in "${!RESULT[@]}"; do R1[$k]="${RESULT[$k]}"; done
  run_list reverse
  # 兩輪都要剛好 N_SCEN 個情境才比（「相同」在兩邊都是空的時候恆真）
  [ "${#R1[@]}" -eq $N_SCEN ] && [ "${#RESULT[@]}" -eq $N_SCEN ] || die "兩輪的情境數不對（${#R1[@]}／${#RESULT[@]}，應各 $N_SCEN）"
  diffk=""; for k in "${!R1[@]}"; do [ "${R1[$k]}" = "${RESULT[$k]:-}" ] || diffk="$diffk $k"; done
  if [ -n "$diffk" ]; then bad=1; echo "兩種順序的結果不一樣：$diffk"; else echo "兩種順序的結果一樣（各 $N_SCEN 個情境）"; fi
else
  run_list "$ORDER"
  [ "${#RESULT[@]}" -eq $N_SCEN ] || die "情境數不對（${#RESULT[@]}，應為 $N_SCEN）"
fi

[ -n "$MUTATE" ] && echo "（這一輪是突變 $MUTATE：預期至少有一種報不符）"
if [ $bad -eq 0 ] && [ -z "$MUTATE" ] && [ "$ORDER" = both ]; then
  # 登記用 HEAD 那一版的共用判斷（複本裡的，情境 20、21 驗過的就是它）：本機 HEAD 還是被驗的那一個、
  # 被守的檔工作區跟 HEAD 一模一樣，才登記 HEAD 那一版的雜湊
  python $REGHELP "$SRC" "$SRC_REG" "$TESTED_HEAD" $FILES; rrc=$?
  if [ $rrc -ne 0 ]; then echo "TEST-PUSHSAFE: 全部符合，但沒有登記（見上一行）"; exit 1; fi
  echo "TEST-PUSHSAFE: 全部符合預期（兩種順序）；已登記被驗的 $(echo $FILES | wc -w) 支檔案雜湊"
elif [ $bad -eq 0 ] && [ -z "$MUTATE" ]; then
  rm -f "$SRC_REG"
  echo "TEST-PUSHSAFE: 全部符合，但只跑了一個順序（$ORDER）；不登記、已刪掉驗法登記"
else
  rm -f "$SRC_REG"
  echo "TEST-PUSHSAFE: $( [ $bad -eq 0 ] && echo '全部符合，但這一輪是突變' || echo '有不符合預期的情況' )；已刪掉驗法登記"
fi
exit $bad
