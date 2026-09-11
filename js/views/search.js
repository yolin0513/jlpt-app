import { h, spinner, clear } from '../ui.js';
import { loadSearchIndex, findItem, LEVELS } from '../data.js';
import { favoriteIdSet } from '../store.js';
import { detailCard } from '../itemview.js';

/* 搜尋改用不含例句的精簡索引（1 個檔、線路上約 75KB），
 * 比原本載入全部 13 個題庫檔（gzip 約 192KB）快很多；
 * 例句等完整欄位在卡片捲進畫面時才用 findItem() 補上。 */
let _pool = null;

async function getPool() {
  if (!_pool) _pool = await loadSearchIndex();
  return _pool;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

/* 比對欄位＝精簡索引裡有的欄位（不含例句） */
function matches(item, q) {
  const n = norm(q);
  if (!n) return false;
  if (item.type === 'vocab') {
    return norm(item.kanji).includes(n) || norm(item.kana).includes(n) ||
      norm(item.romaji).includes(n) || norm(item.meaning).includes(n);
  }
  if (item.type === 'travel') {
    if (item.cat === 'kanji') {
      return norm(item.kanji).includes(n) || norm(item.reading).includes(n) ||
        norm(item.jpMeaning).includes(n) || norm(item.zhMisread).includes(n);
    }
    return norm(item.jp).includes(n) || norm(item.kana).includes(n) ||
      norm(item.zh).includes(n) || norm(item.scene).includes(n) || norm(item.note).includes(n);
  }
  return norm(item.pattern).includes(n) || norm(item.reading).includes(n) ||
    norm(item.meaning).includes(n) || norm(item.structure).includes(n);
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

  /* 索引卡片沒有例句；卡片捲進畫面時才去載該級別的完整題庫並換成完整卡片。
   * 這樣搜尋結果能立刻出現，只有真的被看到的項目才付出載入成本。 */
  const upgraded = new Set();
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const id = e.target.dataset.itemId;
        if (!id || upgraded.has(id)) continue;
        upgraded.add(id);
        findItem(id).then((found) => {
          if (!found || !e.target.isConnected) return;
          e.target.replaceWith(detailCard(found.item, favSet));
        }).catch(() => {});
      }
    }, { rootMargin: '200px' })
    : null;

  function upgrade(card, item) {
    card.dataset.itemId = item.id;
    if (io) io.observe(card);
  }

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
      const card = detailCard(it, favSet);
      results.append(card);
      upgrade(card, it); // 捲進畫面時補上例句等完整內容
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
