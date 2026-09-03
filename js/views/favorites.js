import { h, spinner, clear, toast } from '../ui.js';
import { allFavorites, favoriteIdSet } from '../store.js';
import { findItem } from '../data.js';
import { detailCard } from '../itemview.js';
import { navigate } from '../router.js';

export default async function favoritesView() {
  const wrap = h('div');
  wrap.append(spinner());

  const [favs, favSet] = await Promise.all([allFavorites(), favoriteIdSet()]);
  const rows = [];
  for (const f of favs) {
    const found = await findItem(f.itemId);
    if (found) rows.push(found.item);
  }
  clear(wrap);

  if (!rows.length) {
    wrap.append(h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '☆' }),
      h('p', {}, '還沒有重點複習項目'),
      h('p', { class: 'small muted' }, '在閃卡、測驗、搜尋或錯題本點 ☆ 即可加入'),
      h('button', { class: 'btn', style: 'max-width:220px;margin:12px auto 0', onclick: () => navigate('/search') }, '去搜尋單字')
    ]));
    return wrap;
  }

  let type = 'all';
  function render() {
    clear(wrap);
    const shown = rows.filter((r) => type === 'all' || r.type === type);

    wrap.append(h('div', { class: 'card' }, [
      h('div', { class: 'row spread' }, [
        h('div', {}, [
          h('div', { class: 'small muted', text: '重點複習' }),
          h('div', { class: 'big-num', text: String(rows.length) })
        ]),
        h('div', { class: 'row', style: 'gap:8px' }, [
          h('button', { class: 'btn sm', onclick: () => navigate('/study', { mode: 'flash', src: 'favorites' }) }, '🃏 閃卡'),
          h('button', { class: 'btn sm secondary', onclick: () => navigate('/study', { mode: 'quiz', src: 'favorites' }) }, '📝 測驗')
        ])
      ]),
      h('div', { class: 'chips', style: 'margin-top:10px' }, [
        chip('全部', type === 'all', () => { type = 'all'; render(); }),
        chip('單字', type === 'vocab', () => { type = 'vocab'; render(); }),
        chip('文法', type === 'grammar', () => { type = 'grammar'; render(); }),
        rows.some((r) => r.type === 'travel') ? chip('旅行', type === 'travel', () => { type = 'travel'; render(); }) : null
      ])
    ]));

    for (const it of shown) {
      wrap.append(detailCard(it, favSet));
    }
    wrap.append(h('p', { class: 'small muted', style: 'text-align:center;margin-top:14px' },
      '取消 ★ 後，重新進入此頁即會移除。'));
  }

  function chip(label, active, on) {
    return h('button', { class: 'chip' + (active ? ' on' : ''), type: 'button', onclick: on }, label);
  }

  render();
  return wrap;
}
