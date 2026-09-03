import { h, spinner, clear } from '../ui.js';
import { loadMany, loadTravelAll, LEVELS } from '../data.js';
import { favoriteIdSet } from '../store.js';
import { detailCard } from '../itemview.js';

let _pool = null; // 快取全題庫（含 vocab + grammar + travel）

async function getPool() {
  if (_pool) return _pool;
  const [v, g, tv] = await Promise.all([
    loadMany('vocab', LEVELS),
    loadMany('grammar', LEVELS),
    loadTravelAll().catch(() => [])
  ]);
  _pool = [...v, ...g, ...tv];
  return _pool;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

function matches(item, q) {
  const n = norm(q);
  if (!n) return false;
  if (item.type === 'vocab') {
    return norm(item.kanji).includes(n) || norm(item.kana).includes(n) ||
      norm(item.romaji).includes(n) || norm(item.meaning).includes(n) ||
      norm(item.example).includes(n) || norm(item.exampleMeaning).includes(n);
  }
  if (item.type === 'travel') {
    if (item.cat === 'kanji') {
      return norm(item.kanji).includes(n) || norm(item.reading).includes(n) ||
        norm(item.jpMeaning).includes(n) || norm(item.zhMisread).includes(n) ||
        norm(item.example).includes(n) || norm(item.exampleMeaning).includes(n);
    }
    return norm(item.jp).includes(n) || norm(item.kana).includes(n) ||
      norm(item.zh).includes(n) || norm(item.scene).includes(n) || norm(item.note).includes(n);
  }
  return norm(item.pattern).includes(n) || norm(item.reading).includes(n) ||
    norm(item.meaning).includes(n) || norm(item.structure).includes(n) ||
    norm(item.explanation).includes(n) || norm(item.exampleMeaning).includes(n);
}

export default async function searchView(ctx) {
  const wrap = h('div');
  wrap.append(spinner());
  const [pool, favSet] = await Promise.all([getPool(), favoriteIdSet()]);
  clear(wrap);

  const state = {
    q: ctx.query.q || '',
    type: 'all',
    level: 'all'
  };

  const input = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '搜尋日文、假名或中文意思…',
    value: state.q,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false'
  });
  input.addEventListener('input', () => { state.q = input.value; debounced(); });

  const chipsWrap = h('div', { class: 'chips' });
  function chip(label, active, on) {
    return h('button', { class: 'chip' + (active ? ' on' : ''), type: 'button', onclick: on }, label);
  }
  function renderChips() {
    clear(chipsWrap);
    chipsWrap.append(
      chip('全部', state.type === 'all', () => { state.type = 'all'; renderChips(); render(); }),
      chip('單字', state.type === 'vocab', () => { state.type = 'vocab'; renderChips(); render(); }),
      chip('文法', state.type === 'grammar', () => { state.type = 'grammar'; renderChips(); render(); }),
      chip('旅行', state.type === 'travel', () => { state.type = 'travel'; renderChips(); render(); }),
      h('span', { class: 'chip-sep' }),
      chip('全級別', state.level === 'all', () => { state.level = 'all'; renderChips(); render(); }),
      ...LEVELS.map((lv) => chip(lv, state.level === lv, () => { state.level = lv; renderChips(); render(); }))
    );
  }

  const results = h('div', { class: 'search-results' });

  function render() {
    clear(results);
    const q = state.q.trim();
    if (!q) {
      results.append(h('div', { class: 'empty' }, [
        h('div', { class: 'big', text: '🔎' }),
        h('p', {}, '輸入關鍵字搜尋'),
        h('p', { class: 'small muted' }, '可搜尋漢字、假名、羅馬字或中文釋義')
      ]));
      return;
    }
    let hits = pool.filter((it) =>
      (state.type === 'all' || it.type === state.type) &&
      (state.level === 'all' || it.level === state.level) &&
      matches(it, q));

    // 排序：完全符合 > 開頭符合 > 其他
    const nq = norm(q);
    hits.sort((a, b) => score(b, nq) - score(a, nq));

    results.append(h('div', { class: 'small muted', style: 'margin:4px 0 8px', text: `找到 ${hits.length} 筆${hits.length > 80 ? '（顯示前 80 筆）' : ''}` }));
    for (const it of hits.slice(0, 80)) {
      results.append(detailCard(it, favSet));
    }
    if (!hits.length) {
      results.append(h('div', { class: 'empty' }, [
        h('div', { class: 'big', text: '🤔' }),
        h('p', {}, '沒有符合的結果')
      ]));
    }
  }

  function score(it, nq) {
    const fields = it.type === 'vocab'
      ? [it.kanji, it.kana, it.romaji, it.meaning]
      : it.type === 'travel'
        ? (it.cat === 'kanji' ? [it.kanji, it.reading, it.jpMeaning] : [it.jp, it.kana, it.zh])
        : [it.pattern, it.reading, it.meaning];
    let s = 0;
    for (const f of fields) {
      const nf = norm(f);
      if (!nf) continue;
      if (nf === nq) s += 100;
      else if (nf.startsWith(nq)) s += 20;
      else if (nf.includes(nq)) s += 5;
    }
    return s;
  }

  let t = null;
  function debounced() {
    clearTimeout(t);
    t = setTimeout(render, 180);
  }

  wrap.append(
    h('div', { class: 'search-bar' }, [input]),
    chipsWrap,
    results
  );
  renderChips();
  render();
  setTimeout(() => input.focus(), 50);
  return wrap;
}
