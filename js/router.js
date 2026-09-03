/* 極簡 hash 路由 */
const routes = [];
let notFound = null;
let current = null;

export function route(pattern, handler) {
  // pattern 例：'/home'、'/study'
  routes.push({ pattern, handler });
}
export function setNotFound(fn) { notFound = fn; }

export function parseHash() {
  let hash = location.hash.slice(1) || '/home';
  const [path, qs] = hash.split('?');
  const query = {};
  if (qs) {
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=');
      query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return { path: path || '/home', query, hash };
}

export function navigate(path, query) {
  let h = path;
  if (query && Object.keys(query).length) {
    h += '?' + Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }
  if (('#' + h) === location.hash) { dispatch(); }
  else location.hash = h;
}

export function currentRoute() { return current; }

let onChange = () => {};
export function onRouteChange(fn) { onChange = fn; }

let dispatchGen = 0;

async function dispatch() {
  const gen = ++dispatchGen;
  const ctx = parseHash();
  current = ctx;
  onChange(ctx); // 先更新標題/分頁，畫面內容稍後才 await 完成
  const match = routes.find((r) => r.pattern === ctx.path);
  const view = document.getElementById('view');
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    let node;
    if (match) node = await match.handler(ctx);
    else if (notFound) node = await notFound(ctx);
    if (gen !== dispatchGen) return; // 期間又切了頁，捨棄這次結果
    if (node) {
      view.replaceChildren(node);
      view.firstElementChild?.classList.add('fade-in');
    }
  } catch (err) {
    if (gen !== dispatchGen) return;
    console.error(err);
    view.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty',
      innerHTML: `<div class="big">⚠️</div><p>載入發生錯誤</p><p class="small muted">${err.message}</p>`
    }));
  }
}

export function startRouter() {
  window.addEventListener('hashchange', dispatch);
  dispatch();
}
