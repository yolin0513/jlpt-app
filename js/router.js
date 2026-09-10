/* 極簡 hash 路由 */
const routes = [];
let notFound = null;
let current = null;

export function route(pattern, handler) {
  // pattern 例：'/home'、'/study'
  routes.push({ pattern, handler });
}
export function setNotFound(fn) { notFound = fn; }

/** decodeURIComponent 但不會因為畸形編碼（例如單獨一個 %）而拋錯 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseHash() {
  const hash = location.hash.slice(1) || '/home';
  const qi = hash.indexOf('?');
  const path = qi === -1 ? hash : hash.slice(0, qi);
  const qs = qi === -1 ? '' : hash.slice(qi + 1);
  const query = {};
  if (qs) {
    for (const pair of qs.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = eq === -1 ? pair : pair.slice(0, eq);
      const v = eq === -1 ? '' : pair.slice(eq + 1); // 值裡的 '=' 保留
      query[safeDecode(k)] = safeDecode(v);
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
    const box = document.createElement('div');
    box.className = 'empty';
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = '⚠️';
    const p1 = document.createElement('p');
    p1.textContent = '載入發生錯誤';
    const p2 = document.createElement('p');
    p2.className = 'small muted';
    p2.textContent = err && err.message ? err.message : String(err); // textContent，不用 innerHTML
    box.append(big, p1, p2);
    view.replaceChildren(box);
  }
}

export function startRouter() {
  window.addEventListener('hashchange', dispatch);
  dispatch();
}
