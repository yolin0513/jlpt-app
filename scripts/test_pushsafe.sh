#!/usr/bin/env bash
# 推送閘門的驗法（共用慣例 §2.5、§5.11）：用實際推送的那一支 scripts/pushsafe.sh，分別製造每一關的失敗，
# 而且每一種都比對「是哪一關、哪一類擋的」，不是只比回傳值。
#   bash scripts/test_pushsafe.sh                                   # 正常：全部符合預期回 0，否則回 1
#   TEST_PUSHSAFE_MUTATE=nofetch bash scripts/test_pushsafe.sh      # 突變：閘門拿掉「取遠端實際狀態」那一步
# 完全不碰 GitHub：在暫存目錄建一個 bare repo 當假遠端，複製本 repo「已 commit 的內容」過去跑。
# 所以改了閘門要先在本機 commit（先不推）再跑這支。
set -u
SRC="$(git rev-parse --show-toplevel)" || exit 1
T="$(mktemp -d)"
cleanup() { chmod -R u+w "$T" 2>/dev/null; rm -r "$T" 2>/dev/null; }
trap cleanup EXIT
die() { echo "ABORT: $*（造情境失敗，不帶著沒造成的情境往下驗）"; exit 2; }
MUTATE="${TEST_PUSHSAFE_MUTATE:-}"

# ---- 比對「是誰擋的」：輸出裡必須有 must 的每一句、不能有 -- 後面的任何一句（都用固定字串比） ----
reason_ok() {  # reason_ok 檔案 must... [-- mustnot...]
  local f="$1"; shift
  local mode=must s
  for s in "$@"; do
    if [ "$s" = "--" ]; then mode=not; continue; fi
    if [ $mode = must ]; then grep -qF -- "$s" "$f" || return 1
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
echo "比對函式的對照組：3/3 符合"

# ---- 假遠端與工作複本 ----
git init -q --bare "$T/remote.git" || die "建假遠端"
git clone -q --no-local "$SRC" "$T/work" || die "複製"
cd "$T/work" || die "進工作複本"
git remote set-url origin "$T/remote.git" || die "設遠端"
git config user.name test
git config user.email "test@users.noreply.github.com"
if [ "$MUTATE" = nofetch ]; then
  # 在複本裡把閘門的 fetch 那一段拿掉並 commit；再確認實際會被執行的就是這一份（§5.11 第三層）
  python - scripts/pushsafe.sh <<'PY' || die "改壞閘門"
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8', newline='').read()
a = s.index('# 0) 先拿遠端的最新狀態')
b = s.index('# 1) 自查')
open(p, 'w', encoding='utf-8', newline='').write(s[:a] + s[b:])
PY
  git commit -q -am "MUTATION: pushsafe 拿掉 fetch" || die "commit 改壞的閘門"
  git show HEAD:scripts/pushsafe.sh | grep -q 'fetch -q origin main' && die "HEAD 裡的閘門還有 fetch，突變沒生效"
  git diff --quiet HEAD -- scripts/pushsafe.sh || die "工作區的閘門跟 HEAD 不同，跑到的不是改壞的那一版"
  echo "MUTATION ACTIVE: nofetch（HEAD 與工作區的 scripts/pushsafe.sh 都沒有 fetch；blob $(git rev-parse --short HEAD:scripts/pushsafe.sh)）"
fi
git push -q origin main || die "初始推送到假遠端"

rhead() { git --git-dir="$T/remote.git" rev-parse --short main; }
bad=0
check() {  # check 名稱 期望rc 實際rc 期望假遠端(same|local) before must... [-- mustnot...]
  local name="$1" want="$2" got="$3" expect="$4" before="$5"; shift 5
  local after ok why=""
  after="$(rhead)"; ok=yes
  [ "$got" = "$want" ] || { ok=no; why="回傳值"; }
  if [ "$expect" = same ]; then [ "$after" = "$before" ] || { ok=no; why="$why 假遠端被動到"; }
  else [ "$after" = "$(git rev-parse --short HEAD)" ] || { ok=no; why="$why 假遠端≠本機"; }; fi
  reason_ok "$T/out.txt" "$@" || { ok=no; why="$why 擋下理由不對"; }
  [ "$ok" = yes ] || bad=1
  printf '%-4s %-40s rc=%s(期望 %s)  假遠端 %s→%s  %s\n' "$ok" "$name" "$got" "$want" "$before" "$after" "${why:+（$why）}"
  printf '       比對：%s\n' "$*"
}
run() { bash scripts/pushsafe.sh > "$T/out.txt" 2>&1; echo $?; }
hitfile() { printf '%s%s\n' 'path E' ':\foo' > "$1"; }   # 當場組出來的合成樣本（本機路徑的形狀）

# 1) 要推的檔有命中
b="$(rhead)"
hitfile hit.txt
git add hit.txt && git commit -q -m "synthetic hit" || die "造命中的 commit"
rc="$(run)"; check "1 新增行命中自查" 1 "$rc" same "$b" 'PUSHSAFE: 自查失敗' 'path 命中' -- '沒有要推的 commit' '取不到遠端'
git reset -q --soft HEAD~1 && git rm -q --cached hit.txt && rm hit.txt || die "撤掉命中的 commit"

# 2) 自查的對照組弄壞（email 對照組的頂級網域改成一個字母，樣式就抓不到它）
echo "clean $(date +%s)" > clean.txt
git add clean.txt && git commit -q -m "clean commit" || die "造乾淨的 commit"
b="$(rhead)"
sed -i "s/+ '\.org'/+ '.o'/" scripts/selfcheck_public.py
grep -q "+ '\.o'," scripts/selfcheck_public.py || die "沒改到自查的 email 對照組"
rc="$(run)"; check "2 自查的對照組壞掉" 1 "$rc" same "$b" 'PUSHSAFE: 自查失敗' 'email 對照組沒命中' -- '取不到遠端'
git checkout -q -- scripts/selfcheck_public.py

# 3) 抓不到遠端（遠端網址不存在）→ 停在取遠端那一步，自查根本不跑
b="$(rhead)"
git remote set-url origin "$T/nope.git" || die "改遠端網址"
rc="$(run)"; check "3 抓不到遠端" 1 "$rc" same "$b" 'PUSHSAFE: 取不到遠端的最新狀態' -- 'SELF-CHECK' '推送失敗'
git remote set-url origin "$T/remote.git" || die "改回遠端網址"

# 4) 推送被拒：pre-receive 回傳 1 → 停在推送、後面的比對不跑
b="$(rhead)"
printf '#!/bin/sh\nexit 1\n' > "$T/remote.git/hooks/pre-receive" && chmod +x "$T/remote.git/hooks/pre-receive" || die "放 pre-receive"
rc="$(run)"; check "4 推送被拒（pre-receive）" 2 "$rc" same "$b" 'SELF-CHECK OK' 'PUSHSAFE: 推送失敗' -- '遠端與本機不一致' '推送成功'
rm "$T/remote.git/hooks/pre-receive"

# 5) 推送回報成功、遠端卻沒更新：post-receive 把 main 退回舊值 → 停在比對遠端
b="$(rhead)"
printf '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && git update-ref refs/heads/main "$old"; done\n' > "$T/remote.git/hooks/post-receive" \
  && chmod +x "$T/remote.git/hooks/post-receive" || die "放 post-receive"
rc="$(run)"; check "5 推了遠端卻沒更新（post-receive）" 3 "$rc" same "$b" 'SELF-CHECK OK' 'PUSHSAFE: 遠端與本機不一致' -- '推送成功'
rm "$T/remote.git/hooks/post-receive"

# 6) 全部正常 → 推上去、假遠端＝本機
b="$(rhead)"
rc="$(run)"; check "6 全部正常" 0 "$rc" local "$b" 'SELF-CHECK OK' 'PUSHSAFE: 推送成功'

# 7) 沒有要推的 commit → 自查擋下
b="$(rhead)"
rc="$(run)"; check "7 沒有要推的 commit" 1 "$rc" same "$b" 'PUSHSAFE: 自查失敗' '沒有要推的 commit' -- 'path 命中'

# 8) 本機以為已經推上去、遠端其實沒有（v8）：帶命中的 commit 繞過閘門推上假遠端、抓回來，再把假遠端倒退
BASE="$(git --git-dir="$T/remote.git" rev-parse main)"
hitfile hit8.txt
git add hit8.txt && git commit -q -m "synthetic hit 8" || die "造命中的 commit（情境 8）"
HIT8="$(git rev-parse HEAD)"
git push -q origin main && git fetch -q origin main || die "把命中的 commit 推上假遠端再抓回來"
git --git-dir="$T/remote.git" update-ref refs/heads/main "$BASE" || die "倒退假遠端"
[ "$(git --git-dir="$T/remote.git" rev-parse main)" = "$BASE" ] || die "假遠端沒退回 BASE"
[ "$(git rev-parse origin/main)" = "$HIT8" ] || die "本機的追蹤分支沒指著命中的 commit（前提沒造成）"
echo "clean8 $(date +%s)" > clean8.txt
git add clean8.txt && git commit -q -m "clean commit 8" || die "疊乾淨的 commit（情境 8）"
rc="$(run)"; check "8 本機以為已推、遠端被倒退" 1 "$rc" same "$(git rev-parse --short "$BASE")" 'PUSHSAFE: 自查失敗' 'path 命中' -- '推送成功' '沒有要推的 commit'
if git --git-dir="$T/remote.git" merge-base --is-ancestor "$HIT8" main 2>/dev/null; then
  echo "       帶命中的 commit 到了假遠端：是"
else
  echo "       帶命中的 commit 到了假遠端：否"
fi

[ -n "$MUTATE" ] && echo "（這一輪是突變 $MUTATE：預期至少有一種報不符）"
[ $bad -eq 0 ] && echo "TEST-PUSHSAFE: 全部符合預期" || echo "TEST-PUSHSAFE: 有不符合預期的情況"
exit $bad
