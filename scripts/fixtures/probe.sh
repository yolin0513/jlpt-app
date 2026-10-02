#!/usr/bin/env bash
# 對照組專用的 shell 樣本（fixture）：由 scripts/test_cli_probes.py 與 scripts/lint_gate.py 的真實檔對照組使用。
# 內容固定、不隨程式變動（2026-10-02：原本拿 pushsafe.sh 當樣本）。不會被執行。
set -u
count=0
for f in a b c; do
  count=$((count + 1))
  echo "item $f"
done
echo "total $count"
