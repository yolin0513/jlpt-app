/* UI 小工具 */

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastTimer = null;
export function toast(msg, ms = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function spinner() {
  return h('div', { class: 'spinner' });
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function levelPill(level) {
  const lv = String(level).toLowerCase();
  return h('span', { class: `pill ${lv}`, text: String(level).toUpperCase() });
}

export function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 100);
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sample(arr, n) {
  return shuffle(arr).slice(0, n);
}

export function progressBar(value, total, good = false) {
  const p = pct(value, total);
  return h('div', { class: `bar${good ? ' good' : ''}` }, [
    h('i', { style: `width:${p}%` })
  ]);
}

/** 帶假名的日文（簡易：主體 + 括號讀音） */
export function jpWithReading(main, reading) {
  const wrap = h('span', { class: 'jp-reading' });
  wrap.append(h('span', { class: 'jp', text: main }));
  if (reading && reading !== main) {
    wrap.append(h('span', { class: 'muted small', text: `（${reading}）` }));
  }
  return wrap;
}

export function relTime(ts) {
  const diff = Date.now() - ts;
  const d = Math.floor(diff / 86400000);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 7) return `${d} 天前`;
  if (d < 30) return `${Math.floor(d / 7)} 週前`;
  return `${Math.floor(d / 30)} 個月前`;
}
