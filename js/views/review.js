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
    wrap.append(...forecastBlock(all));
    return wrap;
  }

  // 統計分佈
  const byLevel = {};
  const byType = { vocab: 0, grammar: 0, travel: 0 };
  for (const r of due) {
    byLevel[r.level] = (byLevel[r.level] || 0) + 1;
    byType[r.type] = (byType[r.type] || 0) + 1;
  }
  const ORDER = ['N5', 'N4', 'N3', 'N2', 'N1', 'TRAVEL'];
  const typeParts = [
    byType.vocab ? `單字 ${byType.vocab}` : null,
    byType.grammar ? `文法 ${byType.grammar}` : null,
    byType.travel ? `旅行 ${byType.travel}` : null
  ].filter(Boolean).join('・');

  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'row spread' }, [
      h('div', {}, [
        h('div', { class: 'small muted', text: '待複習' }),
        h('div', { class: 'big-num', text: String(due.length) })
      ]),
      h('div', { style: 'text-align:right;max-width:55%' }, [
        h('div', { class: 'small muted', style: 'line-height:1.5', text: typeParts })
      ])
    ]),
    h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:10px' },
      Object.entries(byLevel)
        .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
        .map(([lv, n]) => h('span', {
          class: `pill ${lv === 'TRAVEL' ? 'travel' : lv.toLowerCase()}`,
          text: `${lv === 'TRAVEL' ? '旅行' : lv} × ${n}`
        })))
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

  wrap.append(...forecastBlock(all));

  wrap.append(h('p', { class: 'small muted', style: 'margin-top:14px' },
    '答對的項目會依間隔重複法逐步拉長複習間隔；答錯會重新排入近期複習並記入錯題本。'));

  return wrap;
}

/* ---------- 複習預測日曆 ----------
 * 只顯示「下一次複習是什麼時候」看不出負擔會不會塞車：
 * SRS 的間隔是倍增的，同一天學的東西會在未來同一天一起到期。
 * 把未來 14 天的到期量畫出來，才看得到哪天會爆量、可以提前分攤。 */
const DAYS = 14;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function forecast(all, days = DAYS, now = Date.now()) {
  const startOfDay = (t) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = startOfDay(now);
  const end = today + days * 86400000;
  const buckets = Array.from({ length: days }, (_, i) => ({ ts: today + i * 86400000, n: 0 }));
  let overdue = 0, later = 0;
  for (const r of all) {
    if (!Number.isFinite(r.due)) continue;
    if (r.due <= now) { overdue += 1; continue; }
    if (r.due >= end) { later += 1; continue; }
    const i = Math.round((startOfDay(r.due) - today) / 86400000);
    if (i >= 0 && i < days) buckets[i].n += 1;
  }
  return { buckets, overdue, later };
}

function forecastBlock(all) {
  const { buckets, overdue, later } = forecast(all);
  if (!all.length) return [];
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const week1 = buckets.slice(0, 7).reduce((a, b) => a + b.n, 0);
  const week2 = buckets.slice(7).reduce((a, b) => a + b.n, 0);
  const peak = buckets.reduce((a, b) => (b.n > a.n ? b : a), buckets[0]);

  const row = h('div', { class: 'fc-row', role: 'img', 'aria-label':
    `未來 ${DAYS} 天複習預測：` + buckets.map((b) => {
      const d = new Date(b.ts);
      return `${d.getMonth() + 1}月${d.getDate()}日 ${b.n} 項`;
    }).join('、') });
  buckets.forEach((b, i) => {
    const d = new Date(b.ts);
    row.append(h('div', { class: 'fc-col' + (i === 0 ? ' today' : '') }, [
      h('div', { class: 'fc-n', text: b.n ? String(b.n) : '' }),
      h('div', { class: 'fc-track' }, [
        h('i', { class: 'fc-bar', style: `height:${b.n ? Math.max(8, Math.round(b.n / max * 100)) : 0}%` })
      ]),
      h('div', { class: 'fc-lab', text: i === 0 ? '今天' : `${d.getMonth() + 1}/${d.getDate()}` }),
      h('div', { class: 'fc-wk', text: WEEK[d.getDay()] })
    ]));
  });

  return [
    h('div', { class: 'section-title', style: 'margin-top:18px', text: `複習預測（未來 ${DAYS} 天）` }),
    h('div', { class: 'card', style: 'padding:12px 10px' }, [
      row,
      h('div', { class: 'small muted', style: 'margin-top:10px;line-height:1.6' },
        `本週 ${week1} 項・下週 ${week2} 項` +
        (peak.n > 0 ? `　最多是 ${new Date(peak.ts).getMonth() + 1}/${new Date(peak.ts).getDate()} 的 ${peak.n} 項` : '') +
        (overdue ? `　已逾期 ${overdue} 項` : '') +
        (later ? `　${DAYS} 天後還有 ${later} 項` : ''))
    ])
  ];
}

function fmtWhen(ts) {
  const min = Math.round((ts - Date.now()) / 60000);
  if (min < 60) return `約 ${Math.max(1, min)} 分鐘後`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `約 ${hr} 小時後`;
  return `約 ${Math.round(hr / 24)} 天後`;
}
