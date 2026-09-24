/* 【已停用 2026-09-24】（SPEC_檢查器修補 J4）
 * 原因：全檔沒有任何判定，只把數值印出來、跑完一律回 0。2026-09-24 實測：刪掉 sw.js 的複本
 * （SW 沒註冊、快取 0 筆、離線是壞的）照樣回 0。它檢查的三件事（SW 註冊、題庫載入、離線可用）
 * verify-full.mjs 都有真的判定，對線上跑：node scripts/verify-full.mjs https://yolin0513.github.io/jlpt-app/
 * 執行本檔一律回 1，避免有人以為它驗過了。下面是原本的程式，留作紀錄，不會執行到。
 *
 * 原說明：驗證線上部署（GitHub Pages）並截一張線上首頁圖
 * 執行：node scripts/verify-live.mjs [url]
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

console.log('VERDICT: FAIL — verify-live.mjs 已停用（2026-09-24，沒有任何判定）；線上驗證改用 node scripts/verify-full.mjs <線上網址>');
process.exit(1);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });
// 若設了環境變數 MIRROR_DIR，額外複製線上首頁圖過去；沒設就跳過。
const MIRROR = process.env.MIRROR_DIR || '';

const URL_BASE = (process.argv[2] || 'https://yolin0513.github.io/jlpt-app/').replace(/\/?$/, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: path.join(tmpdir(), 'jlpt-live-' + Date.now()),
    args: ['--hide-scrollbars', '--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log('1) 首次載入…', URL_BASE);
  await page.goto(URL_BASE, { waitUntil: 'networkidle2' });
  await sleep(1500);

  const info = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    const man = await fetch(new URL('data/manifest.json', location.href)).then((r) => r.json());
    // 走訪所有級別，讓 SW 把題庫快取起來
    for (const s of man.sets) await fetch(new URL('data/' + s.file, location.href));
    for (const s of (man.travel?.sets || [])) await fetch(new URL('data/' + s.file, location.href));
    await new Promise((r) => setTimeout(r, 800));
    let cachedData = 0, cachedShell = 0;
    for (const k of await caches.keys()) {
      const n = (await (await caches.open(k)).keys()).length;
      if (k.includes('data')) cachedData += n; else cachedShell += n;
    }
    return {
      swScope: regs[0]?.scope,
      swActive: regs[0]?.active?.state,
      jlptTotal: man.totalItems,
      travelTotal: man.travel?.total,
      cachedShell, cachedData,
    };
  });
  console.log('   SW:', info.swScope, info.swActive);
  console.log('   題庫: JLPT', info.jlptTotal, '+ 旅行', info.travelTotal);
  console.log('   SW 快取: shell', info.cachedShell, ' data', info.cachedData);

  console.log('2) 離線測試…');
  await page.setOfflineMode(true);
  await page.goto(URL_BASE + '#/home', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(1500);
  const offline = await page.evaluate(async () => {
    // 換到測驗頁，確認題庫從快取讀得到
    location.hash = '#/study?type=vocab&level=N4&mode=quiz&scope=random';
    await new Promise((r) => setTimeout(r, 1200));
    const opts = document.querySelectorAll('.opt').length;
    const prompt = document.querySelector('.quiz-prompt')?.textContent?.trim();
    location.hash = '#/study?mode=flash&src=travel&cat=kanji&scope=order';
    await new Promise((r) => setTimeout(r, 1000));
    const tvCard = !!document.querySelector('.flashcard');
    return { title: document.querySelector('#topTitle')?.textContent, quizOpts: opts, quizPrompt: prompt, travelCard: tvCard };
  });
  console.log('   離線首頁標題:', offline.title);
  console.log('   離線測驗:', offline.quizOpts, '個選項, 題目:', offline.quizPrompt);
  console.log('   離線旅行閃卡:', offline.travelCard ? 'OK' : '失敗');

  console.log('3) 線上首頁截圖…');
  await page.setOfflineMode(false);
  await page.goto('about:blank');
  await page.goto(URL_BASE, { waitUntil: 'networkidle2' });
  await sleep(1200);
  await page.addStyleTag({ content: '#tabbar{display:none!important} #view{padding-bottom:24px!important}' });
  await sleep(150);
  const shot = path.join(OUT, 'live-home.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.log('   ✓', shot);
  if (MIRROR) {
    try { mkdirSync(MIRROR, { recursive: true }); copyFileSync(shot, path.join(MIRROR, 'live-home.png')); console.log('   ✓ 已鏡像到', MIRROR); }
    catch (e) { console.warn('   鏡像失敗:', e.message); }
  }

  console.log('\n=== console/page 錯誤 ===');
  console.log(errors.length ? errors.join('\n') : '（無）');

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
