/* 進入點：註冊路由、SW、主題、返回鍵、分頁高亮 */
import { route, setNotFound, startRouter, onRouteChange, navigate, parseHash } from './router.js';
import { getSetting, setSetting } from './store.js';
import { h } from './ui.js';

import homeView from './views/home.js';
import learnView from './views/learn.js';
import flashcardsView from './views/flashcards.js';
import quizView from './views/quiz.js';
import reviewView from './views/review.js';
import mistakesView from './views/mistakes.js';
import statsView from './views/stats.js';
import searchView from './views/search.js';
import favoritesView from './views/favorites.js';
import travelView from './views/travel.js';

/* ---- 路由表 ---- */
route('/home', homeView);
route('/learn', learnView);
route('/study', (ctx) => (ctx.query.mode === 'quiz' ? quizView(ctx) : flashcardsView(ctx)));
route('/review', reviewView);
route('/mistakes', mistakesView);
route('/stats', statsView);
route('/search', searchView);
route('/favorites', favoritesView);
route('/travel', travelView);
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
  if (history.length > 1) history.back();
  else navigate('/home');
});

document.getElementById('searchBtn').addEventListener('click', () => {
  if (parseHash().path === '/search') { if (history.length > 1) history.back(); else navigate('/home'); }
  else navigate('/search');
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
      .catch((e) => console.warn('SW 註冊失敗', e));
  });
}

/* ---- 啟動 ---- */
initTheme();
startRouter();

// 匯出給 inline 需求（除錯）
window.__jlpt = { navigate, parseHash };
