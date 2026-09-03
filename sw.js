/* JLPT 練習 — Service Worker
 * 快取策略：
 *  - App shell（HTML/CSS/JS/manifest/icons）：預先快取，採 stale-while-revalidate
 *  - 題庫 JSON（data/）：cache-first + 背景更新
 *  - 其他請求：network-first，失敗時回退快取
 */
const VERSION = 'jlpt-v1.2.1';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/router.js',
  './js/db.js',
  './js/store.js',
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
  './data/manifest.json',
  './data/vocab/n5.json',
  './data/vocab/n4.json',
  './data/vocab/n3.json',
  './data/vocab/n2.json',
  './data/vocab/n1.json',
  './data/grammar/n5.json',
  './data/grammar/n4.json',
  './data/grammar/n3.json',
  './data/grammar/n2.json',
  './data/grammar/n1.json',
  './data/travel/phrases.json',
  './data/travel/usage.json',
  './data/travel/kanji.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
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

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

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
