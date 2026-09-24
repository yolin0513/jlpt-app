/* 單獨跑共用判定的自我檢查（三支 puppeteer 測試開跑前也會跑同一組）。
 *   node scripts/test_harness.mjs [harness 檔的路徑]   ← 給突變驗證用：可以指到改壞的那一份
 * 回傳值：0＝六個探針都符合；1＝有探針不符合。 */
import path from 'node:path';
import { runProbes } from './lib/harness.mjs';

const target = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const results = runProbes(target);
for (const r of results) {
  console.log(`${r.good ? 'yes' : 'no '}  ${r.label.padEnd(12)} 回傳 ${r.rc}（期望 ${r.wantRc}）`);
}
const bad = results.filter((r) => !r.good).length;
console.log(bad ? `有 ${bad} 個探針不符合` : '全部符合');
process.exit(bad ? 1 : 0);
