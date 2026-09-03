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

async function dispatch() {
  const ctx = parseHash();
  current = ctx;
  const match = routes.find((r) => r.pattern === ctx.path);
  const view = document.getElementById('view');
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    let node;
    if (match) node = await match.handler(ctx);
    else if (notFound) node = await notFound(ctx);
    if (node) {
      view.replaceChildren(node);
      view.firstElementChild?.classList.add('fade-in');
    }
  } catch (err) {
    console.error(err);
    view.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty',
      innerHTML: `<div class="big">⚠️</div><p>載入發生錯誤</p><p class="small muted">${err.message}</p>`
    }));
  }
  onChange(ctx);
}

export function startRouter() {
  window.addEventListener('hashchange', dispatch);
  dispatch();
}
