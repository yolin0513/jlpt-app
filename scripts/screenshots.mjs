/* 產生 App 主要畫面截圖到 screenshots/
 *
 * 前置：先啟動開發伺服器  →  python scripts/serve.py 5173
 *       （或 BASE_URL 指向線上版）
 * 執行：node scripts/screenshots.mjs
 *
 * 會跑三組：
 *   - 預設 390px 淺色（無前綴）
 *   - 360px 淺色（前綴 360-）
 *   - 390px 深色（前綴 dark-）
 * 設 MIRROR_DIR 環境變數會把 screenshots/*.png 額外複製一份過去。
 */
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });
const MIRROR_DIR = process.env.MIRROR_DIR || '';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hardGoto(page, url) {
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle2' });
}

async function seed(page) {
  await hardGoto(page, BASE + '#/home');
  const result = await page.evaluate(async () => {
    try {
      const store = await import('./js/store.js');
      const { idb } = await import('./js/db.js');
      await store.resetAll();
      await idb.clear('meta');
      const { loadSet, loadTravel } = await import('./js/data.js');
      const n5 = await loadSet('vocab', 'N5');
      const n4 = await loadSet('vocab', 'N4');
      const n3g = await loadSet('grammar', 'N3');
      const kanji = await loadTravel('kanji');
      const phrases = await loadTravel('phrases');
      const learn = [...n5.slice(0, 40), ...n4.slice(0, 25), ...n3g.slice(0, 12), ...kanji.slice(0, 14)];
      for (const it of learn) for (let i = 0; i < 4; i++) await store.recordAnswer({ item: it, level: it.level, type: it.type, grade: 'good' });
      const wrong = [...n5.slice(40, 52), ...n4.slice(25, 31), ...kanji.slice(14, 22), ...phrases.slice(0, 6)];
      for (const it of wrong) await store.recordAnswer({ item: it, level: it.level, type: it.type, grade: 'again' });
      for (const it of [...n5.slice(0, 5), ...kanji.slice(0, 3), ...phrases.slice(0, 2)]) await store.addFavorite(it);
      const z = (n) => String(n).padStart(2, '0');
      const today = new Date();
      for (let d = 9; d >= 0; d--) {
        const dt = new Date(today); dt.setDate(today.getDate() - d);
        const key = `${dt.getFullYear()}-${z(dt.getMonth() + 1)}-${z(dt.getDate())}`;
        const studied = [12, 8, 20, 5, 0, 16, 24, 10, 18, 30][9 - d];
        await idb.put('daily', { date: key, studied, correct: Math.round(studied * 0.8), wrong: Math.round(studied * 0.2), cards: Math.round(studied / 2) });
      }
      await store.setSetting('seenGuide', true);
      await store.setDailyGoal(20);
      return { ok: true, progress: (await store.allProgress()).length };
    } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
  });
  console.log('  seed:', JSON.stringify(result));
  await sleep(300);
}

function makeShot(page, prefix, dark) {
  return async (hash, name, opts = {}) => {
    await hardGoto(page, BASE + hash);
    if (dark) await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(650);
    if (opts.prep) await opts.prep(page);
    if (dark) await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    if (opts.fullPage) {
      await page.addStyleTag({ content: '#tabbar{display:none!important} #view{padding-bottom:24px!important}' });
      await sleep(120);
    }
    const file = path.join(OUT, prefix + name);
    await page.screenshot({ path: file, fullPage: !!opts.fullPage });
    console.log('  ✓', file);
  };
}

/* 一組截圖（給定 shot 函式） */
async function shootSet(shot, { full }) {
  await shot('#/home', 'home.png', { fullPage: true });
  await shot('#/learn', 'learn.png', { fullPage: true });
  await shot('#/travel', 'travel.png', { fullPage: true });
  await shot('#/mistakes', 'mistakes.png');
  await shot('#/stats', 'stats.png', { fullPage: true });
  await shot('#/study?type=vocab&level=N5&mode=flash&scope=order', 'flashcard.png', {
    prep: async (p) => { await p.evaluate(() => document.querySelector('.flashcard')?.click()); await sleep(700); },
  });
  await shot('#/study?mode=flash&src=travel&cat=kanji&scope=order', 'kanji-diff.png', {
    prep: async (p) => { await p.evaluate(() => document.querySelector('.flashcard')?.click()); await sleep(700); },
  });
  await shot('#/study?type=vocab&level=N4&mode=quiz&scope=order', 'quiz.png', {
    prep: async (p) => { await p.evaluate(() => { const o = [...document.querySelectorAll('.opt')]; (o[1] || o[0])?.click(); }); await sleep(500); },
  });
  if (full) {
    await shot('#/favorites', 'favorites.png', { fullPage: true });
    await shot('#/review', 'review.png');
    await shot('#/search?q=手紙', 'search.png', { fullPage: true });
    await shot('#/study?mode=quiz&src=travel&cat=phrases&scope=order', 'travel-quiz.png');
    await shot('#/study?type=vocab&level=N4&mode=quiz&scope=order', 'quiz-result.png', {
      fullPage: true,
      prep: async (p) => {
        for (let i = 0; i < 40; i++) {
          await p.evaluate(() => { const o = document.querySelector('.opt:not([disabled])'); if (o) o.click(); });
          await sleep(45);
          await p.evaluate(() => document.querySelector('.quiz-next')?.click());
          await sleep(45);
        }
        await sleep(300);
      },
    });
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: path.join(tmpdir(), 'jlpt-shots-' + Date.now()),
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--no-sandbox', '--disable-gpu'],
  });

  // ---- Pass 1: 390px 淺色（完整）----
  console.log('\n[390px 淺色]');
  let page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await seed(page);
  await shootSet(makeShot(page, '', false), { full: true });
  await page.close();

  // ---- Pass 2: 360px 淺色 ----
  console.log('\n[360px 淺色]');
  page = await browser.newPage();
  await page.setViewport({ width: 360, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await seed(page);
  await shootSet(makeShot(page, '360-', false), { full: false });
  await page.close();

  // ---- Pass 3: 390px 深色 ----
  console.log('\n[390px 深色]');
  page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await seed(page);
  await shootSet(makeShot(page, 'dark-', true), { full: false });
  await page.close();

  await browser.close();
  console.log('\n完成，輸出於', OUT);

  if (MIRROR_DIR) {
    try {
      mkdirSync(MIRROR_DIR, { recursive: true });
      let n = 0;
      for (const f of readdirSync(OUT)) if (f.endsWith('.png')) { copyFileSync(path.join(OUT, f), path.join(MIRROR_DIR, f)); n++; }
      console.log(`已複製 ${n} 張到`, MIRROR_DIR);
    } catch (e) { console.warn('複製到 MIRROR_DIR 失敗:', e.message); }
  }
})().catch((e) => { console.error(e); process.exit(1); });
