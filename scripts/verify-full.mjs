/* 完整線上驗證：各分頁、深色、360px/平板、SW 更新、離線、console
 * 用法：node scripts/verify-full.mjs [baseUrl]
 */
import puppeteer from 'puppeteer';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || 'https://yolin0513.github.io/jlpt-app/').replace(/\/?$/, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); };

const b = await puppeteer.launch({ headless: true, userDataDir: path.join(tmpdir(), 'vf-' + Date.now()), args: ['--no-sandbox', '--disable-gpu'] });

async function newPage(vp) {
  const p = await b.newPage();
  await p.setViewport(vp);
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p._errs = errs;
  return p;
}
async function go(p, hash) { await p.goto('about:blank'); await p.goto(BASE + hash, { waitUntil: 'networkidle2' }); await sleep(600); }

// ============ A. 手機 375px 全流程 ============
console.log('\n[A] 手機 375px 全流程');
const p = await newPage({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await go(p, '#/home');

// SW 版本（等到真正 active）
const sw = await p.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready; // 解析時保證有 active worker
  for (let i = 0; i < 40 && !reg.active; i++) await new Promise(r => setTimeout(r, 100));
  const keys = await caches.keys();
  const man = await fetch(new URL('data/manifest.json', location.href)).then(r => r.json());
  return { scope: reg.scope, state: reg.active?.state, cacheKeys: keys, jlpt: man.totalItems, travel: man.travel?.total };
});
ok(sw.state === 'activated' && (sw.scope.endsWith('/jlpt-app/') || sw.scope.endsWith(':5173/')), `SW ${sw.state} @ ${sw.scope}`);
ok(sw.cacheKeys.some(k => /v1\.\d+\.\d+-shell/.test(k)), `SW shell 快取存在 (${sw.cacheKeys.join(', ')})`);
ok(sw.jlpt === 1628 && sw.travel === 266, `題庫載入 JLPT ${sw.jlpt} + 旅行 ${sw.travel}`);

// 逐頁載入
for (const [hash, marker] of [
  ['#/home', '.tile'], ['#/learn', '.section-title'], ['#/travel', '.card'],
  ['#/review', '#view'], ['#/mistakes', '#view'], ['#/stats', '.stat-grid'],
  ['#/favorites', '#view'], ['#/search?q=床', '.detail-card'],
]) {
  await go(p, hash);
  await p.waitForSelector(marker, { timeout: 8000 }).catch(() => {});
  const has = await p.evaluate((m) => !!document.querySelector(m), marker);
  ok(has, `${hash} 內容渲染`);
}

// 測驗流程（JLPT）
await go(p, '#/study?type=vocab&level=N3&mode=quiz&scope=random');
let q = 0;
for (let i = 0; i < 22; i++) {
  const done = await p.evaluate(() => {
    const o = document.querySelector('.opt:not([disabled])');
    if (o) { o.click(); return false; }
    return true;
  });
  if (done) break;
  await sleep(70);
  await p.evaluate(() => document.querySelector('.quiz-next')?.click());
  await sleep(70);
  q++;
  if (await p.evaluate(() => !!document.querySelector('.result-hero'))) break;
}
ok(await p.evaluate(() => !!document.querySelector('.result-hero')), `JLPT 測驗跑完 (${q} 題) 顯示結果`);

// 閃卡流程（JLPT）
await go(p, '#/study?type=grammar&level=N2&mode=flash&scope=order');
const fc = await p.evaluate(async () => {
  const s = ms => new Promise(r => setTimeout(r, ms));
  document.querySelector('.flashcard').click(); await s(600);
  const back = document.querySelector('.flashcard.flipped');
  const tools = document.querySelector('.card-tools .star-btn');
  document.querySelectorAll('.grade-grid button')[2]?.click(); await s(300);
  return { flipped: !!back, hasStar: !!tools, advanced: document.querySelector('.study-count')?.textContent };
});
ok(fc.flipped && fc.hasStar, `閃卡翻面 + ★/🔊 (現在 ${fc.advanced})`);

// 生活旅行：漢字閃卡
await go(p, '#/study?mode=flash&src=travel&cat=kanji&scope=order');
const kj = await p.evaluate(async () => {
  const s = ms => new Promise(r => setTimeout(r, ms));
  const front = document.querySelector('.flash-main')?.textContent;
  document.querySelector('.flashcard').click(); await s(600);
  const txt = document.querySelector('.flash-face.back')?.innerText || '';
  return { front, hasMean: /日文意思|地板|ゆか/.test(txt) || txt.length > 5, hasMisread: txt.includes('台灣人常誤解') };
});
ok(kj.hasMisread, `漢字差異卡顯示「台灣人常誤解」(正面「${kj.front}」)`);

// 生活旅行：情境測驗
await go(p, '#/study?mode=quiz&src=travel&cat=phrases&scope=order');
const tq = await p.evaluate(() => {
  const pill = document.querySelector('.quiz-q .pill')?.textContent;
  const opts = document.querySelectorAll('.opt').length;
  document.querySelector('.opt')?.click();
  return { pill, opts };
});
await sleep(300);
ok(tq.pill === '旅行' && tq.opts === 4, `旅行測驗 pill=${tq.pill} 選項=${tq.opts}`);
const tqfb = await p.evaluate(() => !!document.querySelector('.quiz-feedback'));
ok(tqfb, '旅行測驗作答後有解說');

// 生活旅行收合 toggle
await go(p, '#/travel');
const tg = await p.evaluate(async () => {
  const s = ms => new Promise(r => setTimeout(r, ms));
  const t = [...document.querySelectorAll('.linklike')].find(x => x.textContent.includes('依情境'));
  const list = () => t.parentElement.querySelector('.chips');
  const seq = [list().offsetHeight > 0];
  for (let i = 0; i < 3; i++) { t.click(); await s(320); seq.push(list().offsetHeight > 0); }
  return seq;
});
ok(JSON.stringify(tg) === JSON.stringify([false, true, false, true]), `收合 toggle ${JSON.stringify(tg)}`);

// 錯題本（此時應有 N3 測驗的錯題）
await go(p, '#/mistakes');
const mb = await p.evaluate(async () => {
  const m = await import('./js/store.js');
  const open = await m.openMistakes();
  return { open: open.length, dom: document.querySelectorAll('.list-item').length, header: document.querySelector('.big-num')?.textContent };
});
ok(mb.open === mb.dom, `錯題本 store(${mb.open}) == DOM(${mb.dom}) header ${mb.header}`);

// 收藏 + 最愛頁
await go(p, '#/search?q=手紙');
await p.evaluate(() => document.querySelector('.detail-card .star-btn')?.click());
await sleep(300);
await go(p, '#/favorites');
const fav = await p.evaluate(() => document.querySelectorAll('.detail-card').length);
ok(fav >= 1, `最愛頁顯示收藏項目 (${fav})`);

// 複習頁（把某筆設為到期）
await p.evaluate(async () => {
  const { idb } = await import('./js/db.js');
  const all = await idb.getAll('progress');
  if (all[0]) { all[0].due = Date.now() - 1000; await idb.put('progress', all[0]); }
});
await go(p, '#/review');
const rv = await p.evaluate(() => document.querySelector('#view').innerText.slice(0, 60));
ok(/待複習|沒有到期/.test(rv), `複習頁渲染 (${rv.replace(/\n/g, ' ')})`);

// 返回鍵不離開 App
await go(p, '#/stats');
await p.evaluate(() => document.getElementById('backBtn').click());
await sleep(300);
ok(await p.evaluate(() => location.hash === '#/home' || location.hash === ''), '返回鍵 → 首頁');

// 深色模式
await p.evaluate(() => document.getElementById('themeBtn').click());
await sleep(200);
const darkNow = await p.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), reload: null }));
await go(p, '#/home'); // reload keeps setting
const darkPersist = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
ok(darkPersist === 'dark', `深色模式切換並記憶 (${darkPersist})`);

ok(p._errs.length === 0, `手機流程 console 錯誤: ${p._errs.join(' | ') || '無'}`);
await p.close();

// ============ B. 離線 ============
console.log('\n[B] 離線可用');
const po = await newPage({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await go(po, '#/home');
await po.evaluate(async () => {
  const man = await fetch(new URL('data/manifest.json', location.href)).then(r => r.json());
  for (const s of man.sets) await fetch(new URL('data/' + s.file, location.href));
  for (const s of man.travel.sets) await fetch(new URL('data/' + s.file, location.href));
  await new Promise(r => setTimeout(r, 600));
});
await po.setOfflineMode(true);
await po.goto('about:blank');
await po.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(1200);
const off = await po.evaluate(async () => {
  const s = ms => new Promise(r => setTimeout(r, ms));
  location.hash = '#/study?type=vocab&level=N1&mode=quiz&scope=random'; await s(1200);
  const quiz = document.querySelectorAll('.opt').length;
  location.hash = '#/study?mode=flash&src=travel&cat=usage&scope=order'; await s(900);
  const card = !!document.querySelector('.flashcard');
  location.hash = '#/stats'; await s(700);
  const stats = !!document.querySelector('.stat-grid');
  return { home: document.querySelector('#topTitle')?.textContent, quiz, card, stats };
});
ok(off.quiz === 4, `離線 N1 測驗 (${off.quiz} 選項)`);
ok(off.card, '離線旅行閃卡');
ok(off.stats, '離線統計頁');
ok(po._errs.length === 0, `離線 console 錯誤: ${po._errs.join(' | ') || '無'}`);
await po.close();

// ============ C. 360px 與平板橫向溢出 ============
console.log('\n[C] 版面（360px / 平板）');
for (const [label, vp] of [
  ['360px', { width: 360, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['平板 834', { width: 834, height: 1112, deviceScaleFactor: 2 }],
]) {
  const pr = await newPage(vp);
  let over = [];
  for (const hash of ['#/home', '#/learn', '#/travel', '#/stats', '#/mistakes', '#/search?q=手紙',
    '#/study?type=grammar&level=N1&mode=quiz&scope=order']) {
    await go(pr, hash);
    const o = await pr.evaluate(() => {
      const de = document.documentElement;
      const diff = de.scrollWidth - de.clientWidth;
      return diff > 1 ? diff : 0;
    });
    if (o) over.push(`${hash} +${o}px`);
  }
  ok(over.length === 0, `${label} 無橫向溢出 ${over.join(', ')}`);
  // 平板：確認內容置中且限寬
  if (label.startsWith('平板')) {
    await go(pr, '#/home');
    const w = await pr.evaluate(() => { const r = document.querySelector('#app').getBoundingClientRect(); return { w: Math.round(r.width), centered: Math.abs(r.left - (innerWidth - r.width) / 2) < 4 }; });
    ok(w.w <= 560 && w.centered, `平板內容限寬 ${w.w}px 且置中`);
  }
  await pr.close();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
await b.close();
process.exit(fail ? 1 : 0);
