/* 回歸測試：走過所有路由與主要互動，檢查不變量。
 * 用法：node scripts/regress.mjs [baseUrl]
 */
import puppeteer from 'puppeteer';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://127.0.0.1:5173/index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); };

const b = await puppeteer.launch({ headless: true, userDataDir: path.join(tmpdir(), 'reg-' + Date.now()), args: ['--no-sandbox', '--disable-gpu'] });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

async function go(hash) { await p.goto('about:blank'); await p.goto(BASE + hash, { waitUntil: 'networkidle2' }); await sleep(500); }

// ---------- 1. 全路由載入 ----------
console.log('\n[1] 全路由 0 錯誤載入');
for (const r of ['#/home', '#/learn', '#/travel', '#/review', '#/mistakes', '#/stats', '#/favorites', '#/search']) {
  errs.length = 0;
  await go(r);
  const hasContent = await p.evaluate(() => document.querySelector('#view').children.length > 0);
  ok(hasContent && errs.length === 0, `${r} 載入 (err: ${errs.join('|') || 'none'})`);
}

// ---------- 2. SRS 排程邊界 ----------
console.log('\n[2] SRS 排程');
await go('#/home');
const srs = await p.evaluate(async () => {
  const { schedule, BOX_INTERVALS_MIN, LEARNED_BOX } = await import('./js/srs.js');
  const out = {};
  let r = null;
  // 連續答對到 box 上限
  for (let i = 0; i < 10; i++) r = schedule(r, 'good', { itemId: 'x', level: 'N5', type: 'vocab' });
  out.maxBox = r.box;
  out.maxBoxIsCap = r.box === BOX_INTERVALS_MIN.length - 1;
  out.dueFinite = Number.isFinite(r.due);
  // again 歸零
  r = schedule(r, 'again', {});
  out.againResetsBox = r.box === 0;
  out.lapsesInc = r.lapses >= 1;
  // hard 從 0 不會變負
  let h = schedule(null, 'hard', { itemId: 'y' });
  out.hardFromZero = h.box === 0;
  // 缺欄位的舊紀錄
  const bad = schedule({ itemId: 'z', box: undefined, reps: undefined }, 'good', { level: 'N5', type: 'vocab' });
  out.badRecOk = Number.isFinite(bad.box) && Number.isFinite(bad.due) && bad.box === 1;
  out.learnedBox = LEARNED_BOX;
  return out;
});
ok(srs.maxBoxIsCap, `box 上限封頂 (=${srs.maxBox})`);
ok(srs.dueFinite, 'due 是有效數字');
ok(srs.againResetsBox && srs.lapsesInc, 'again 歸零 box 並記 lapse');
ok(srs.hardFromZero, 'hard 從 box0 不會變負');
ok(srs.badRecOk, '缺欄位的舊紀錄可安全排程');

// ---------- 3. 測驗完整流程 + 統計正確性 ----------
console.log('\n[3] 測驗流程與統計');
await p.evaluate(async () => { const m = await import('./js/store.js'); await m.resetAll(); const { idb } = await import('./js/db.js'); await idb.clear('meta'); });
await go('#/study?type=vocab&level=N5&mode=quiz&scope=order');
let correct = 0, total = 0;
for (let i = 0; i < 25; i++) {
  const st = await p.evaluate(() => {
    const opts = [...document.querySelectorAll('.opt:not([disabled])')];
    if (!opts.length) return null;
    const correctBtn = document.querySelector('.opt.correct');
    // 交錯：偶數選正解、奇數選第一個
    return { has: true };
  });
  if (!st) break;
  const clickedCorrect = await p.evaluate((i) => {
    const opts = [...document.querySelectorAll('.opt:not([disabled])')];
    const btn = (i % 2 === 0) ? opts[0] : opts[opts.length - 1];
    btn.click();
    return true;
  }, i);
  await sleep(80);
  const wasCorrect = await p.evaluate(() => !!document.querySelector('.quiz-feedback.ok'));
  if (wasCorrect) correct++;
  total++;
  const done = await p.evaluate(() => {
    const nb = document.querySelector('.quiz-next');
    if (nb) { nb.click(); return false; }
    return true;
  });
  await sleep(80);
  if (done || await p.evaluate(() => !!document.querySelector('.result-hero'))) break;
}
const resultShown = await p.evaluate(() => {
  const el = document.querySelector('.result-hero');
  if (!el) return null;
  return el.innerText;
});
ok(!!resultShown, `結果頁顯示 (${(resultShown || '').replace(/\n/g, ' ')})`);
const stats = await p.evaluate(async () => {
  const m = await import('./js/store.js');
  const prog = await m.allProgress();
  const d = await m.dailyFor();
  return {
    progCount: prog.length,
    studied: d.studied, correct: d.correct, wrong: d.wrong,
    correctPlusWrong: d.correct + d.wrong,
    totalCorrectField: prog.reduce((s, r) => s + r.correct, 0),
    totalWrongField: prog.reduce((s, r) => s + r.wrong, 0),
  };
});
ok(stats.studied === stats.correctPlusWrong, `daily: studied(${stats.studied}) == correct+wrong(${stats.correctPlusWrong})`);
ok(stats.progCount === stats.studied, `progress 筆數(${stats.progCount}) == 作答數(${stats.studied})`);
ok(stats.totalCorrectField === stats.correct, `progress.correct 加總(${stats.totalCorrectField}) == daily.correct(${stats.correct})`);

// ---------- 4. 統計頁數字 ----------
console.log('\n[4] 統計頁');
await go('#/stats');
const statsPage = await p.evaluate(() => {
  const txt = document.querySelector('#view').innerText;
  const acc = txt.match(/總正確率\s*\n?\s*(\d+)%/);
  const pair = txt.match(/(\d+)\s*對\s*\/\s*(\d+)\s*錯/);
  return { txt: txt.slice(0, 400), acc: acc && +acc[1], correct: pair && +pair[1], wrong: pair && +pair[2] };
});
if (statsPage.correct != null) {
  const expectedAcc = Math.round(statsPage.correct / (statsPage.correct + statsPage.wrong) * 100);
  ok(statsPage.acc === expectedAcc, `正確率 ${statsPage.acc}% == ${expectedAcc}% (${statsPage.correct}對/${statsPage.wrong}錯)`);
}

// ---------- 5. 錯題本 ----------
console.log('\n[5] 錯題本流程');
await go('#/mistakes');
const mist = await p.evaluate(async () => {
  const m = await import('./js/store.js');
  const open = await m.openMistakes();
  const domCount = document.querySelectorAll('.list-item').length;
  const headerNum = document.querySelector('.big-num')?.textContent;
  return { open: open.length, domCount, headerNum };
});
ok(mist.domCount === mist.open || mist.open === 0, `錯題數 DOM(${mist.domCount}) == store(${mist.open})`);
ok(String(mist.open) === mist.headerNum || mist.open === 0, `錯題本標題數字正確 (${mist.headerNum})`);

// ---------- 6. 收合 toggle ----------
console.log('\n[6] 生活旅行收合 toggle');
await go('#/travel');
const toggle = await p.evaluate(async () => {
  const s = ms => new Promise(r => setTimeout(r, ms));
  const t = [...document.querySelectorAll('.linklike')].find(b => b.textContent.includes('依情境挑選'));
  const list = () => t.parentElement.querySelector('.chips');
  const states = [];
  states.push(list().offsetHeight > 0);
  t.click(); await s(350); states.push(list().offsetHeight > 0);
  t.click(); await s(300); states.push(list().offsetHeight > 0);
  t.click(); await s(300); states.push(list().offsetHeight > 0);
  return states; // [false, true, false, true]
});
ok(JSON.stringify(toggle) === JSON.stringify([false, true, false, true]), `toggle 展開/收合序列 ${JSON.stringify(toggle)}`);

// ---------- 7. 返回鍵不會離開 App ----------
console.log('\n[7] 返回鍵');
await go('#/stats');
const backOk = await p.evaluate(async () => {
  document.getElementById('backBtn').click();
  await new Promise(r => setTimeout(r, 300));
  return location.hash;
});
ok(backOk === '#/home' || backOk === '', `stats 返回 → ${backOk || '#/home'}`);

// ---------- 8. 深色模式 ----------
console.log('\n[8] 深色模式');
await go('#/home');
const dark = await p.evaluate(async () => {
  document.getElementById('themeBtn').click();
  await new Promise(r => setTimeout(r, 200));
  const root = getComputedStyle(document.documentElement);
  const bg = root.getPropertyValue('--bg').trim();
  const text = root.getPropertyValue('--text').trim();
  const theme = document.documentElement.getAttribute('data-theme');
  return { theme, bg, text };
});
ok(dark.theme === 'dark' && dark.bg === '#0d1117', `深色套用 (bg ${dark.bg})`);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
await b.close();
process.exit(fail ? 1 : 0);
