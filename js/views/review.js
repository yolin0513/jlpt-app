import { h, spinner } from '../ui.js';
import { idb } from '../db.js';
import { navigate } from '../router.js';
import { BOX_INTERVALS_MIN } from '../srs.js';

export default async function reviewView() {
  const wrap = h('div');
  wrap.append(spinner());
  const due = await idb.dueProgress();
  const all = await idb.getAll('progress');
  wrap.replaceChildren();

  if (!due.length) {
    const upcoming = all
      .filter((r) => r.due > Date.now())
      .sort((a, b) => a.due - b.due)[0];
    wrap.append(h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '✅' }),
      h('p', {}, '目前沒有到期的複習項目'),
      upcoming
        ? h('p', { class: 'small muted' }, `下一次複習：${fmtWhen(upcoming.due)}`)
        : h('p', { class: 'small muted' }, '先去學習一些單字或文法吧'),
      h('button', { class: 'btn', style: 'max-width:220px;margin:12px auto 0', onclick: () => navigate('/learn') }, '開始學習')
    ]));
    return wrap;
  }

  // 統計分佈
  const byLevel = {};
  const byType = { vocab: 0, grammar: 0 };
  for (const r of due) {
    byLevel[r.level] = (byLevel[r.level] || 0) + 1;
    byType[r.type] = (byType[r.type] || 0) + 1;
  }

  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'row spread' }, [
      h('div', {}, [
        h('div', { class: 'small muted', text: '待複習' }),
        h('div', { class: 'big-num', text: String(due.length) })
      ]),
      h('div', { style: 'text-align:right' }, [
        h('div', { class: 'small muted', text: '單字 / 文法' }),
        h('div', { class: 'big-num', style: 'font-size:22px', text: `${byType.vocab} / ${byType.grammar}` })
      ])
    ]),
    h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:10px' },
      Object.entries(byLevel).sort().map(([lv, n]) =>
        h('span', { class: `pill ${lv.toLowerCase()}`, text: `${lv} × ${n}` })))
  ]));

  wrap.append(h('div', { class: 'section-title', text: '複習方式' }));
  wrap.append(h('button', {
    class: 'btn', style: 'margin-bottom:10px',
    onclick: () => navigate('/study', { mode: 'flash', src: 'review' })
  }, '🃏 閃卡複習'));
  wrap.append(h('button', {
    class: 'btn secondary',
    onclick: () => navigate('/study', { mode: 'quiz', src: 'review' })
  }, '📝 測驗複習'));

  wrap.append(h('p', { class: 'small muted', style: 'margin-top:14px' },
    '答對的項目會依間隔重複法逐步拉長複習間隔；答錯會重新排入近期複習並記入錯題本。'));

  return wrap;
}

function fmtWhen(ts) {
  const min = Math.round((ts - Date.now()) / 60000);
  if (min < 60) return `約 ${Math.max(1, min)} 分鐘後`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `約 ${hr} 小時後`;
  return `約 ${Math.round(hr / 24)} 天後`;
}
