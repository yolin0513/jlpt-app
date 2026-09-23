#!/usr/bin/env bash
# 推送閘門的驗法（共用慣例 §2.5）：用實際推送的那一支 scripts/pushsafe.sh，分別製造每一關的失敗。
#   bash scripts/test_pushsafe.sh
# 完全不碰 GitHub：在暫存目錄建一個 bare repo 當假遠端，複製本 repo「已 commit 的內容」過去跑。
# 所以改了閘門要先在本機 commit（先不推）再跑這支。全部符合預期回 0，有任何一種不符合回 1。
set -u
SRC="$(git rev-parse --show-toplevel)" || exit 1
T="$(mktemp -d)"
cleanup() { chmod -R u+w "$T" 2>/dev/null; rm -r "$T" 2>/dev/null; }
trap cleanup EXIT

git init -q --bare "$T/remote.git"
git clone -q --no-local "$SRC" "$T/work" || exit 1
cd "$T/work" || exit 1
git remote set-url origin "$T/remote.git"
git push -q origin main || exit 1
git config user.name test
git config user.email "test@users.noreply.github.com"
rhead() { git --git-dir="$T/remote.git" rev-parse --short main; }
bad=0
check() {  # check 名稱 期望rc 實際rc 期望假遠端(same|local) before
  local name="$1" want="$2" got="$3" expect="$4" before="$5" after ok
  after="$(rhead)"
  ok=yes
  [ "$got" = "$want" ] || ok=no
  if [ "$expect" = same ]; then [ "$after" = "$before" ] || ok=no
  else [ "$after" = "$(git rev-parse --short HEAD)" ] || ok=no; fi
  [ "$ok" = yes ] || bad=1
  printf '%-4s %-44s rc=%s(期望 %s)  假遠端 %s→%s  %s\n' "$ok" "$name" "$got" "$want" "$before" "$after" \
    "$([ "$expect" = same ] && echo '應不動' || echo '應＝本機')"
}
run() { bash scripts/pushsafe.sh > "$T/out.txt" 2>&1; echo $?; }

# 1) 要推的檔有命中：commit 一個當場組出來的合成樣本（本機路徑的形狀）
b="$(rhead)"
printf '%s%s\n' 'path E' ':\foo' > hit.txt
git add hit.txt && git commit -q -m "synthetic hit"
rc="$(run)"; check "1 新增行命中自查" 1 "$rc" same "$b"
git reset -q --soft HEAD~1 && git rm -q --cached hit.txt && rm hit.txt

# 2) 自查的對照組弄壞（email 對照組的頂級網域改成一個字母，樣式就抓不到它）
echo "clean $(date +%s)" > clean.txt
git add clean.txt && git commit -q -m "clean commit"
b="$(rhead)"
sed -i "s/+ '\.org'/+ '.o'/" scripts/selfcheck_public.py
if grep -q "+ '\.o'," scripts/selfcheck_public.py; then
  rc="$(run)"; check "2 自查的對照組壞掉" 1 "$rc" same "$b"
else
  echo "no   2 自查的對照組壞掉：沒改到對照組，這一種沒驗到"; bad=1
fi
git checkout -q -- scripts/selfcheck_public.py

# 3) 推送被拒：pre-receive 回傳 1 → 必須停在推送、後面的比對不跑
b="$(rhead)"
printf '#!/bin/sh\nexit 1\n' > "$T/remote.git/hooks/pre-receive"; chmod +x "$T/remote.git/hooks/pre-receive"
rc="$(run)"; check "3 推送被拒（pre-receive）" 2 "$rc" same "$b"
if grep -q '遠端與本機不一致\|推送成功' "$T/out.txt"; then echo "no   3 推送失敗後卻跑了比對那一關"; bad=1; fi
rm "$T/remote.git/hooks/pre-receive"

# 4) 推送回報成功、遠端卻沒更新：post-receive 把 main 退回舊值 → 必須停在比對遠端
b="$(rhead)"
printf '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && git update-ref refs/heads/main "$old"; done\n' > "$T/remote.git/hooks/post-receive"
chmod +x "$T/remote.git/hooks/post-receive"
rc="$(run)"; check "4 推了遠端卻沒更新（post-receive）" 3 "$rc" same "$b"
rm "$T/remote.git/hooks/post-receive"

# 5) 全部正常 → 推上去、假遠端＝本機
b="$(rhead)"
rc="$(run)"; check "5 全部正常" 0 "$rc" local "$b"

# 6) 沒有要推的 commit → 自查擋下
b="$(rhead)"
rc="$(run)"; check "6 沒有要推的 commit" 1 "$rc" same "$b"

[ $bad -eq 0 ] && echo "TEST-PUSHSAFE: 全部符合預期" || echo "TEST-PUSHSAFE: 有不符合預期的情況"
exit $bad
