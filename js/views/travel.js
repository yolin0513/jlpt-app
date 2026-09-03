import { h, spinner, clear, pct, progressBar } from '../ui.js';
import { getTravelManifest, loadTravel, TRAVEL_CATS } from '../data.js';
import { progressMap } from '../store.js';
import { LEARNED_BOX } from '../srs.js';
import { navigate } from '../router.js';

export default async function travelView() {
  const wrap = h('div');
  wrap.append(spinner());

  const [tm, pmap] = await Promise.all([getTravelManifest(), progressMap()]);
  clear(wrap);

  if (!tm.sets.length) {
    wrap.append(h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '🧳' }),
      h('p', {}, '生活旅行題庫尚未建立')
    ]));
    return wrap;
  }

  // 各分類掌握度
  const stat = {};
  for (const s of tm.sets) stat[s.cat] = { total: s.count, learned: 0, seen: 0 };
  for (const r of pmap.values()) {
    if (r.type !== 'travel') continue;
    const cat = catOfId(r.itemId);
    if (!stat[cat]) continue;
    stat[cat].seen += 1;
    if (r.box >= LEARNED_BOX) stat[cat].learned += 1;
  }

  wrap.append(h('p', { class: 'small muted', style: 'margin:0 0 12px' },
    '與 JLPT 級別無關，專為台灣人自由行、貼近日本人實際用法而整理。沿用閃卡、測驗、間隔重複與錯題本。'));

  for (const cat of TRAVEL_CATS) {
    const s = stat[cat.key] || { total: 0, learned: 0, seen: 0 };
    const card = h('div', { class: 'card' }, [
      h('div', { class: 'row', style: 'gap:10px;align-items:flex-start' }, [
        h('span', { style: 'font-size:26px', text: cat.icon }),
        h('div', { style: 'flex:1' }, [
          h('div', { class: 'tile-title', text: cat.label }),
          h('div', { class: 'tile-sub', text: cat.desc })
        ])
      ]),
      h('div', { class: 'row spread', style: 'margin:10px 0 6px' }, [
        h('span', { class: 'small muted', text: `${s.learned} / ${s.total} 已掌握・${s.seen} 學過` }),
        h('span', { class: 'small muted', text: `${pct(s.learned, s.total)}%` })
      ]),
      progressBar(s.learned, s.total, s.total > 0 && s.learned === s.total),
      h('div', { class: 'btn-grid', style: 'margin-top:12px' }, [
        h('button', { class: 'btn', onclick: () => go(cat.key, 'flash') }, '🃏 閃卡'),
        h('button', { class: 'btn secondary', onclick: () => go(cat.key, 'quiz') }, '📝 測驗')
      ]),
      cat.key === 'phrases' ? sceneRow(cat.key) : null
    ]);
    wrap.append(card);
  }

  wrap.append(h('div', { class: 'section-title', text: '綜合練習' }));
  wrap.append(h('div', { class: 'btn-grid' }, [
    h('button', { class: 'btn secondary', onclick: () => go('all', 'flash') }, '🃏 全部混合閃卡'),
    h('button', { class: 'btn secondary', onclick: () => go('all', 'quiz') }, '📝 全部混合測驗')
  ]));

  function go(cat, mode, scene) {
    const q = { mode, src: 'travel', cat, scope: 'smart' };
    if (scene) q.scene = scene;
    navigate('/study', q);
  }

  /* 情境會話的場景快捷（可折疊） */
  function sceneRow(catKey) {
    const box = h('div', { style: 'margin-top:10px' });
    const toggle = h('button', { class: 'linklike small', text: '依情境挑選 ▾' });
    const list = h('div', { class: 'chips', style: 'margin-top:8px', hidden: true });
    let loaded = false;
    toggle.addEventListener('click', async () => {
      list.hidden = !list.hidden;
      toggle.textContent = list.hidden ? '依情境挑選 ▾' : '依情境挑選 ▴';
      if (!loaded) {
        loaded = true;
        const items = await loadTravel(catKey);
        const scenes = [...new Set(items.map((i) => i.scene).filter(Boolean))];
        for (const sc of scenes) {
          list.append(h('button', {
            class: 'chip', type: 'button',
            onclick: () => go(catKey, 'flash', sc)
          }, sc));
        }
      }
    });
    box.append(toggle, list);
    return box;
  }

  return wrap;
}

function catOfId(id) {
  const m = /^tv-([puk])-/.exec(id || '');
  return m ? { p: 'phrases', u: 'usage', k: 'kanji' }[m[1]] : null;
}
