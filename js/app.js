/* 進入點：註冊路由、SW、主題、返回鍵、分頁高亮 */
import { route, setNotFound, startRouter, onRouteChange, navigate, parseHash } from './router.js';
import { getSetting, setSetting } from './store.js';
import { h } from './ui.js';

/* 各畫面以動態 import 延遲載入 → 首次載入只抓進入頁的模組，其餘按需載入 */
const lazy = (loader) => (ctx) => loader(ctx).then((m) => m.default(ctx));

/* ---- 路由表 ---- */
route('/home', lazy(() => import('./views/home.js')));
route('/learn', lazy(() => import('./views/learn.js')));
route('/study', lazy((ctx) => (ctx.query.mode === 'quiz' ? import('./views/quiz.js') : import('./views/flashcards.js'))));
route('/review', lazy(() => import('./views/review.js')));
route('/mistakes', lazy(() => import('./views/mistakes.js')));
route('/stats', lazy(() => import('./views/stats.js')));
route('/search', lazy(() => import('./views/search.js')));
route('/favorites', lazy(() => import('./views/favorites.js')));
route('/travel', lazy(() => import('./views/travel.js')));
setNotFound(() => h('div', { class: 'empty', html: '<div class="big">🔍</div><p>找不到頁面</p>' }));

/* ---- 標題 / 返回鍵 / 分頁高亮 ---- */
const TITLES = {
  '/home': 'JLPT 練習',
  '/learn': '選擇練習',
  '/study': '練習中',
  '/review': '複習到期項目',
  '/mistakes': '錯題本',
  '/stats': '學習統計',
  '/search': '搜尋',
  '/favorites': '重點複習',
  '/travel': '生活旅行'
};
const TAB_OF = {
  '/home': 'home', '/learn': 'learn', '/study': 'learn',
  '/review': 'review', '/mistakes': 'mistakes', '/stats': 'stats',
  '/search': null, '/favorites': null, '/travel': 'learn'
};

/** 各畫面的「上一層」— 返回鍵用，永遠不會離開 App */
function parentOf(ctx) {
  if (ctx.path === '/study') {
    return { travel: '/travel', review: '/review', mistakes: '/mistakes', favorites: '/favorites' }[ctx.query.src] || '/learn';
  }
  if (ctx.path === '/favorites') return '/home';
  return '/home';
}

// App 啟動時的 history 長度；用來判斷 history.back() 會不會退出 App
const startHistoryLen = history.length;

onRouteChange((ctx) => {
  document.getElementById('topTitle').textContent = TITLES[ctx.path] || 'JLPT 練習';
  const showBack = ctx.path !== '/home';
  document.getElementById('backBtn').hidden = !showBack;
  const tab = TAB_OF[ctx.path];
  document.querySelectorAll('.tab').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === tab);
  });
});

document.getElementById('backBtn').addEventListener('click', () => {
  const ctx = parseHash();
  if (ctx.path === '/home') return;
  // 有 App 內的瀏覽歷史就用 back（保留使用者的實際路徑），否則跳到上一層
  if (history.length > startHistoryLen) history.back();
  else navigate(parentOf(ctx));
});

document.getElementById('searchBtn').addEventListener('click', () => {
  if (parseHash().path === '/search') {
    if (history.length > startHistoryLen) history.back();
    else navigate('/home');
  } else navigate('/search');
});

/* ---- 主題 ---- */
async function initTheme() {
  let t = await getSetting('theme', null);
  if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(t);
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', t === 'dark' ? '#161b22' : '#1f6feb');
}
document.getElementById('themeBtn').addEventListener('click', async () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await setSetting('theme', next);
});

/* ---- Service Worker ---- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url))
      .then(async (reg) => {
        // 首屏之後，請 SW 在背景把題庫檔快取起來（供離線用），不擋首次載入
        await navigator.serviceWorker.ready;
        const target = reg.active || navigator.serviceWorker.controller;
        setTimeout(() => target && target.postMessage('WARM_DATA'), 1500);
      })
      .catch((e) => console.warn('SW 註冊失敗', e));
  });
}

/* ---- 啟動 ---- */
initTheme();
startRouter();

// 匯出給 inline 需求（除錯）
window.__jlpt = { navigate, parseHash };
