/* 驗證線上部署（GitHub Pages）並截一張線上首頁圖
 * 執行：node scripts/verify-live.mjs [url]
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

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
