import { h, spinner, toast, relTime } from '../ui.js';
import { openMistakes, allMistakes, removeMistake, clearResolvedMistakes, favoriteIdSet } from '../store.js';
import { findItem } from '../data.js';
import { navigate } from '../router.js';
import { actionRow } from '../itemview.js';

export default async function mistakesView() {
  const wrap = h('div');
  wrap.append(spinner());

  const open = await openMistakes();
  const all = await allMistakes();
  const favSet = await favoriteIdSet();
  const resolvedCount = all.length - open.length;

  // 取回題目細節
  const rows = [];
  for (const m of open.sort((a, b) => (b.lastWrong || 0) - (a.lastWrong || 0))) {
    const found = await findItem(m.itemId);
    if (found) rows.push({ m, item: found.item });
  }
  wrap.replaceChildren();

  if (!rows.length) {
    wrap.append(h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '🌟' }),
      h('p', {}, '錯題本是空的'),
      h('p', { class: 'small muted' }, resolvedCount ? `已訂正 ${resolvedCount} 項` : '測驗或閃卡答錯的項目會出現在這裡'),
      h('button', { class: 'btn', style: 'max-width:220px;margin:12px auto 0', onclick: () => navigate('/learn') }, '開始練習')
    ]));
    return wrap;
  }

  let filterLevel = 'ALL';
  let filterType = 'ALL';

  function render() {
    wrap.replaceChildren();

    const shown = rows.filter((r) =>
      (filterLevel === 'ALL' || r.item.level === filterLevel) &&
      (filterType === 'ALL' || r.item.type === filterType));

    wrap.append(h('div', { class: 'card' }, [
      h('div', { class: 'row spread' }, [
        h('div', {}, [
          h('div', { class: 'small muted', text: '待訂正' }),
          h('div', { class: 'big-num', text: String(rows.length) })
        ]),
        h('button', { class: 'btn sm', onclick: () => navigate('/study', { mode: 'quiz', src: 'mistakes' }) }, '測驗這些題')
      ]),
      h('div', { class: 'row', style: 'gap:8px;margin-top:10px' }, [
        selectEl(['ALL', 'N5', 'N4', 'N3', 'N2', 'N1', 'TRAVEL'], filterLevel, (v) => { filterLevel = v; render(); }, '級別',
          { TRAVEL: '生活旅行' }),
        selectEl(['ALL', 'vocab', 'grammar', 'travel'], filterType, (v) => { filterType = v; render(); }, '類型',
          { ALL: '全部', vocab: '單字', grammar: '文法', travel: '旅行' })
      ])
    ]));

    const list = h('div', { class: 'card' });
    if (!shown.length) list.append(h('p', { class: 'small muted', text: '此篩選沒有項目' }));
    shown.forEach(({ m, item }) => {
      const isTv = item.type === 'travel';
      const jp = item.type === 'vocab' ? (item.kanji || item.kana)
        : item.type === 'grammar' ? item.pattern
          : item.cat === 'kanji' ? item.kanji : item.jp;
      const zh = isTv ? (item.cat === 'kanji' ? item.jpMeaning : item.zh) : item.meaning;
      const sub = item.type === 'vocab' && item.kana && item.kana !== item.kanji ? item.kana
        : isTv && item.cat === 'kanji' ? item.reading
          : isTv ? item.kana : '';
      list.append(h('div', { class: 'list-item' }, [
        h('div', { class: 'li-main' }, [
          h('div', { class: 'row', style: 'gap:6px;align-items:baseline' }, [
            h('span', { class: `pill ${isTv ? 'travel' : String(item.level).toLowerCase()}`, text: isTv ? '旅行' : item.level }),
            h('span', { class: 'li-jp', text: jp })
          ]),
          sub ? h('div', { class: 'li-sub', text: sub }) : null,
          h('div', { class: 'li-sub', text: zh }),
          h('div', { class: 'li-sub', text: `答錯 ${m.count} 次・${relTime(m.lastWrong || Date.now())}` })
        ]),
        actionRow(item, favSet),
        h('button', { class: 'icon-btn', title: '移除', onclick: async () => {
          await removeMistake(m.itemId);
          const i = rows.findIndex((r) => r.m.itemId === m.itemId);
          if (i >= 0) rows.splice(i, 1);
          toast('已從錯題本移除');
          if (!rows.length) return mistakesView().then((n) => document.getElementById('view').replaceChildren(n));
          render();
        } }, '🗑')
      ]));
    });
    wrap.append(list);

    wrap.append(h('button', {
      class: 'btn ghost', onclick: async () => {
        await clearResolvedMistakes();
        toast('已清除訂正完成的項目');
      }
    }, '清除已訂正項目'));
  }

  render();
  return wrap;
}

function selectEl(values, cur, onChange, label, labels = {}) {
  const map = { ALL: '全部', N5: 'N5', N4: 'N4', N3: 'N3', N2: 'N2', N1: 'N1', ...labels };
  const s = h('select', { class: 'sel', onchange: (e) => onChange(e.target.value) },
    values.map((v) => h('option', { value: v, selected: v === cur }, map[v] || v)));
  return s;
}
