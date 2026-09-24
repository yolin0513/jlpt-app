/* 三支 puppeteer 測試（audit、verify-full、regress）共用的判定（2026-09-24，J2／J3，共用慣例 v9 §5.13）。
 *
 * 以前三支各自寫判定：判定函式被改成永遠通過時 168／30／23 全綠、沒有任何東西會發現；一條斷言都沒跑也回 0。
 * 現在：
 *   - 有任何一條失敗 → 回 1
 *   - 一條斷言都沒跑（母體是空的）→ 回 1
 *   - 跑的條數和登記的不同（有段落沒跑到，或新增斷言後沒更新登記數）→ 回 1
 *   - 被測的東西在走到總結之前就崩掉（丟例外、Promise 沒接住、沒走到 finish() 就結束）→ 回 1
 *   訊息一律寫「VERDICT: FAIL — 理由」或「VERDICT: OK」，不會說反。
 * 三支每次開跑前都先跑 selfTestHarness()：開子程序跑五個小探針，確認上面每一條真的會判對；
 * 判定本身壞了就在開跑前停下（它自己的對照組）。單獨跑：node scripts/test_harness.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function createHarness({ name, expected = null, onCrash = null }) {
  let pass = 0;
  let fail = 0;
  let finished = false;
  const issues = [];

  const ok = (c, m, note) => {
    c ? pass++ : fail++;
    if (!c) issues.push(m + (note ? ` — ${note}` : ''));
    console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`);
  };

  function reasons() {
    const r = [];
    const total = pass + fail;
    if (fail > 0) r.push(`${fail} 條斷言失敗`);
    if (total === 0) r.push('一條斷言都沒有跑（母體是空的）');
    else if (expected !== null && total !== expected) {
      r.push(`跑了 ${total} 條，登記的是 ${expected} 條（有段落沒跑到，或新增斷言後沒更新登記數）`);
    }
    return r;
  }

  function printSummary(extra) {
    console.log(`\n===== ${pass} passed, ${fail} failed${extra || ''} =====`);
    if (issues.length) {
      console.log('\n--- 需處理清單 ---');
      issues.forEach((i, n) => console.log(`${n + 1}. ${i}`));
    }
  }

  async function crash(kind, e) {
    if (finished) return;
    finished = true;
    ok(false, `執行中斷（${kind}，後面的項目沒有跑）`, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ｜ ') : e));
    printSummary('（中途中斷）');
    console.log(`VERDICT: FAIL — ${name} 在走到總結之前就中斷了（${kind}）`);
    try { if (onCrash) await onCrash(); } catch { /* 已經在收尾，關不掉就算了 */ }
    process.exit(1);
  }
  process.on('uncaughtException', (e) => crash('未接住的例外', e));
  process.on('unhandledRejection', (e) => crash('沒接住的 Promise', e));
  process.on('exit', () => {
    if (!finished) {
      console.log(`\nVERDICT: FAIL — ${name} 沒有走到總結就結束了（${pass} passed, ${fail} failed）`);
      process.exitCode = 1;
    }
  });

  function finish() {
    finished = true;
    printSummary();
    const r = reasons();
    if (r.length) {
      console.log(`VERDICT: FAIL — ${r.join('；')}`);
      process.exitCode = 1;
      return 1;
    }
    console.log(`VERDICT: OK — ${pass} 條全部通過${expected !== null ? `（登記 ${expected} 條）` : ''}`);
    process.exitCode = 0;
    return 0;
  }

  return { ok, finish, counts: () => ({ pass, fail }) };
}

/* ---- 自我檢查：五個小探針，各開一個子程序跑（不在同一個程序裡模擬，免得互相影響） ---- */
const PROBES = {
  // 名稱: [探針程式, 期望回傳值, 輸出必須有的句子, 輸出不能有的句子]
  '一定失敗的斷言': [`const h = createHarness({ name: 'p', expected: 1 }); h.ok(false, 'x'); h.finish();`, 1, '1 條斷言失敗', 'VERDICT: OK'],
  '母體是空的': [`const h = createHarness({ name: 'p' }); h.finish();`, 1, '母體是空的', 'VERDICT: OK'],
  '走到總結前就崩掉': [`const h = createHarness({ name: 'p', expected: 2 }); h.ok(true, 'a'); throw new Error('boom');`, 1, '中斷了', 'VERDICT: OK'],
  '沒走到總結就結束': [`const h = createHarness({ name: 'p', expected: 2 }); h.ok(true, 'a');`, 1, '沒有走到總結就結束了', 'VERDICT: OK'],
  '條數和登記的不同': [`const h = createHarness({ name: 'p', expected: 3 }); h.ok(true, 'a'); h.ok(true, 'b'); h.finish();`, 1, '登記的是 3 條', 'VERDICT: OK'],
  '正常（要放行）': [`const h = createHarness({ name: 'p', expected: 2 }); h.ok(true, 'a'); h.ok(true, 'b'); h.finish();`, 0, 'VERDICT: OK', 'VERDICT: FAIL'],
};

// 預設驗「這一份 harness 自己」（不是固定檔名）：複本或改名的那一份被驗時，探針載的就是它
export function runProbes(harnessFile = fileURLToPath(import.meta.url)) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-probe-'));
  const results = [];
  try {
    for (const [label, [code, wantRc, must, mustNot]] of Object.entries(PROBES)) {
      const f = path.join(dir, `probe-${results.length}.mjs`);
      writeFileSync(f, `import { createHarness } from ${JSON.stringify(pathToFileURL(harnessFile).href)};\n${code}\n`);
      const r = spawnSync(process.execPath, [f], { encoding: 'utf8' });
      const out = (r.stdout || '') + (r.stderr || '');
      const good = r.status === wantRc && out.includes(must) && !out.includes(mustNot);
      results.push({ label, good, rc: r.status, wantRc, must, mustNot, out });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

export function selfTestHarness() {
  const results = runProbes();
  const bad = results.filter((r) => !r.good);
  if (bad.length) {
    console.log('HARNESS SELF-TEST FAILED：判定本身壞了，這一輪的結果不可信，沒有開跑');
    for (const r of bad) console.log(`  ${r.label}：回傳 ${r.rc}（期望 ${r.wantRc}）；要有「${r.must}」、不能有「${r.mustNot}」`);
    process.exit(1);
  }
  console.log(`判定的自我檢查：${results.length}/${results.length} 個探針符合`);
}
