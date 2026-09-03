/* 產生 App 主要畫面的手機尺寸截圖到 screenshots/
 *
 * 前置：先啟動開發伺服器  →  python scripts/serve.py 5173
 * 執行：node scripts/screenshots.mjs
 *
 * 用 puppeteer-core 驅動系統上的 Edge（Chromium 核心）。
 */
import { mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });

/* 若設了環境變數 MIRROR_DIR，跑完會把 screenshots/*.png 額外複製一份過去；沒設就跳過。
 * 例：MIRROR_DIR=/some/where node scripts/screenshots.mjs */
const MIRROR_DIR = process.env.MIRROR_DIR || '';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173/index.html';
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* puppeteer 的 page.goto 只改 hash 時不會重新載入 → 先到 about:blank 強制整頁重載 */
async function hardGoto(page, url) {
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle2' });
}

/* 在頁面裡塞一些學習紀錄，讓錯題本 / 統計 / 結果頁有內容 */
async function seed(page) {
  await hardGoto(page, BASE + '#/home');
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });
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

    // 已掌握一批、答錯一批、最愛一批
    const learn = [...n5.slice(0, 40), ...n4.slice(0, 25), ...n3g.slice(0, 12), ...kanji.slice(0, 14)];
    for (const it of learn) {
      for (let i = 0; i < 4; i++) {
        await store.recordAnswer({ item: it, level: it.level, type: it.type, grade: 'good' });
      }
    }
    const wrong = [...n5.slice(40, 52), ...n4.slice(25, 31), ...kanji.slice(14, 22), ...phrases.slice(0, 6)];
    for (const it of wrong) {
      await store.recordAnswer({ item: it, level: it.level, type: it.type, grade: 'again' });
    }
    for (const it of [...n5.slice(0, 5), ...kanji.slice(0, 3), ...phrases.slice(0, 2)]) {
      await store.addFavorite(it);
    }
    // 造幾天的每日紀錄，讓長條圖好看
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
    const prog = await store.allProgress();
    return { ok: true, progress: prog.length, mistakes: (await store.allMistakes()).length };
   } catch (e) {
    return { ok: false, error: String(e && e.stack || e) };
   }
  });
  console.log('  seed:', JSON.stringify(result));
  await sleep(300);
}

async function shot(page, hash, file, opts = {}) {
  await hardGoto(page, BASE + hash);
  await sleep(650);
  if (opts.prep) await opts.prep(page);
  if (opts.fullPage) {
    // 整頁截圖時，固定定位的底部導覽會浮在頁面中間，先藏起來
    await page.addStyleTag({ content: '#tabbar{display:none!important} #view{padding-bottom:24px!important}' });
    await sleep(120);
  }
  const full = path.join(OUT, file);
  await page.screenshot({ path: full, fullPage: !!opts.fullPage });
  console.log('  ✓', full);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: path.join(tmpdir(), 'jlpt-shots-profile-' + Date.now()),
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  console.log('種入示範資料…');
  await seed(page);

  console.log('截圖中…');
  // 先截「顯示種入資料」的頁面，避免後面的測驗互動又增加錯題數
  await shot(page, '#/home', 'home.png', { fullPage: true });
  await shot(page, '#/learn', 'learn.png', { fullPage: true });
  await shot(page, '#/travel', 'travel.png', { fullPage: true });
  await shot(page, '#/mistakes', 'mistakes.png');
  await shot(page, '#/favorites', 'favorites.png', { fullPage: true });
  await shot(page, '#/review', 'review.png');
  await shot(page, '#/stats', 'stats.png', { fullPage: true });
  await shot(page, '#/search?q=手紙', 'search.png', { fullPage: true });

  // 閃卡：翻到背面
  await shot(page, '#/study?type=vocab&level=N5&mode=flash&scope=order', 'flashcard.png', {
    prep: async (p) => { await p.evaluate(() => document.querySelector('.flashcard')?.click()); await sleep(700); },
  });

  // 生活旅行漢字閃卡：翻到背面
  await shot(page, '#/study?mode=flash&src=travel&cat=kanji&scope=order', 'kanji-diff.png', {
    prep: async (p) => { await p.evaluate(() => document.querySelector('.flashcard')?.click()); await sleep(700); },
  });

  // 測驗：作答後的解說畫面（點正解，顯示「答對了」）
  await shot(page, '#/study?type=vocab&level=N4&mode=quiz&scope=order', 'quiz.png', {
    prep: async (p) => {
      await p.evaluate(() => { const o = [...document.querySelectorAll('.opt')]; (o[1] || o[0])?.click(); });
      await sleep(500);
    },
  });

  // 測驗結果頁
  await shot(page, '#/study?type=vocab&level=N4&mode=quiz&scope=order', 'quiz-result.png', {
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

  await shot(page, '#/study?mode=quiz&src=travel&cat=phrases&scope=order', 'travel-quiz.png');

  // 深色模式首頁
  await shot(page, '#/home', 'home-dark.png', {
    fullPage: true,
    prep: async (p) => { await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await sleep(250); },
  });

  await browser.close();
  console.log('完成，輸出於', OUT);

  if (MIRROR_DIR) {
    try {
      mkdirSync(MIRROR_DIR, { recursive: true });
      let n = 0;
      for (const f of readdirSync(OUT)) {
        if (f.endsWith('.png')) { copyFileSync(path.join(OUT, f), path.join(MIRROR_DIR, f)); n++; }
      }
      console.log(`已複製 ${n} 張到`, MIRROR_DIR);
    } catch (e) {
      console.warn('複製到 MIRROR_DIR 失敗（不影響主輸出）:', e.message);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
