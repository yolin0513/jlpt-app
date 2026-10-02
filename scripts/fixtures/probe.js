// 對照組專用的 JavaScript 樣本（fixture）：由 scripts/test_cli_probes.py 與 scripts/lint_gate.py 的真實檔對照組使用。
// 內容固定、不隨程式變動（2026-10-02：原本拿 js/app.js 當樣本）。不會被載入。
const WORD = /[a-z]+/g;

export function countWords(text) {
  let n = 0;
  for (const line of text.split('\n')) {
    n += (line.match(WORD) || []).length;
  }
  return n;
}
