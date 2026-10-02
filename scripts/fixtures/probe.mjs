// 對照組專用的 ES module 樣本（fixture）：由 scripts/test_cli_probes.py 與 scripts/lint_gate.py 的真實檔對照組使用。
// 內容固定、不隨程式變動（2026-10-02：原本拿 scripts/audit.mjs 當樣本）。不會被執行。
const DIGITS = /^[0-9]+$/;

export function isNumber(s) {
  return DIGITS.test(String(s).trim());
}
