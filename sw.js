/* JLPT 練習 — Service Worker
 * 快取策略：
 *  - App shell（HTML/CSS/JS/manifest/icons）：install 時預先快取，之後 stale-while-revalidate
 *  - 題庫 JSON（data/）：cache-first + 背景更新；首次載入不預抓，改由頁面在 load 後
 *    傳訊要求 SW 於背景暖機（WARM_DATA），避免拖慢首屏
 *  - 其他請求：network-first，失敗時回退快取
 */
const VERSION = 'jlpt-v1.15.0';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

// App 外殼：小、必要，install 時就抓
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/router.js',
  './js/db.js',
  './js/store.js',
  './js/backup.js',
  './js/pos.js',
  './js/srs.js',
  './js/data.js',
  './js/session.js',
  './js/ui.js',
  './js/speech.js',
  './js/keys.js',
  './js/itemview.js',
  './js/views/home.js',
  './js/views/learn.js',
  './js/views/flashcards.js',
  './js/views/quiz.js',
  './js/views/review.js',
  './js/views/mistakes.js',
  './js/views/stats.js',
  './js/views/search.js',
  './js/views/favorites.js',
  './js/views/travel.js',
  './js/views/listening.js',
  './js/views/exam.js',
  './js/views/weak.js',
  './js/weak.js',
  './js/qtypes.js',
  './data/manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 題庫檔：較大，離線需要但非首屏必要 → 頁面 load 後才背景暖機
const DATA_ASSETS = [
  './data/vocab/n5.json', './data/vocab/n4.json', './data/vocab/n3.json',
  './data/vocab/n2.json', './data/vocab/n1.json',
  './data/grammar/n5.json', './data/grammar/n4.json', './data/grammar/n3.json',
  './data/grammar/n2.json', './data/grammar/n1.json',
  './data/travel/phrases.json', './data/travel/usage.json', './data/travel/kanji.json',
  './data/search-index.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* 題庫快取的內容標記：存 manifest 的 dataVersion。
 * 只要題庫有任何變動，build_data.py 產生的 dataVersion 就會變，
 * 這裡比對後就整批清掉重抓 —— 不必再依賴人工 bump VERSION。 */
const STAMP_URL = './__data_version__';

async function currentStamp(cache) {
  try {
    const res = await cache.match(STAMP_URL);
    return res ? await res.text() : null;
  } catch (e) {
    return null;
  }
}

async function warmData(dataVersion) {
  const cache = await caches.open(DATA_CACHE);
  const stale = dataVersion && (await currentStamp(cache)) !== dataVersion;
  if (stale) {
    // 題庫換版：清掉舊的再抓，避免混用新舊資料
    for (const u of DATA_ASSETS) await cache.delete(u).catch(() => {});
  }
  await Promise.all(DATA_ASSETS.map(async (u) => {
    try {
      if (!stale && (await cache.match(u))) return;
      const res = await fetch(u, { cache: 'no-cache' });
      if (res && res.ok) await cache.put(u, res.clone());
    } catch (e) { /* 下次再試 */ }
  }));
  if (dataVersion) {
    await cache.put(STAMP_URL, new Response(dataVersion, {
      headers: { 'Content-Type': 'text/plain' }
    }));
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg === 'SKIP_WAITING') self.skipWaiting();
  // 舊版送字串 'WARM_DATA'；新版送 { type:'WARM_DATA', dataVersion }
  if (msg === 'WARM_DATA') event.waitUntil(warmData(null));
  else if (msg && msg.type === 'WARM_DATA') event.waitUntil(warmData(msg.dataVersion));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // manifest.json：題庫的索引（很小，但驅動數量、dupIds、dataVersion）
  // → network-first，確保線上時一定拿到最新的，離線才回退快取
  if (url.pathname.endsWith('/data/manifest.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        throw e;
      }
    })());
    return;
  }

  // 題庫資料：cache-first，背景更新
  if (url.pathname.includes('/data/')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = (await cache.match(req)) || (await caches.match(req, { ignoreSearch: true }));
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // App shell：stale-while-revalidate
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
