/* 弱點清單：依 SRS 紀錄排出「最學不起來」的項目 */
import { h, spinner, pct } from '../ui.js';
import { allProgress } from '../store.js';
import { getManifest, findItem, LEVELS } from '../data.js';
import { navigate } from '../router.js';
import { LEARNED_BOX } from '../srs.js';
import { rankWeak, accuracyOf, MIN_REPS } from '../weak.js';

const LIMIT = 50;

export default async function weakView(ctx) {
  const wrap = h('div');
  wrap.append(spinner());

  const [prog, man] = await Promise.all([allProgress(), getManifest()]);
  const dupSet = new Set(man.dupIds || []);
  let level = ctx.query.level || 'ALL';

  wrap.replaceChildren();
  await render();
  return wrap;

  async function render() {
    wrap.replaceChildren();
    wrap.append(h('div', { class: 'section-title', text: '🩹 弱點清單' }));
    wrap.append(h('p', { class: 'small muted', style: 'margin:-4px 0 10px;line-height:1.6' },
      `依錯誤率、是否還沒升到「已掌握」、累計錯誤次數排序。` +
      `作答未滿 ${MIN_REPS} 次的不列入——次數太少還看不出是不是真的弱。`));

    const chips = h('div', { class: 'chips' });
    [['ALL', '全部'], ...LEVELS.map((l) => [l, l]), ['TRAVEL', '旅行']].forEach(([v, label]) => {
      chips.append(h('button', {
        class: 'chip' + (v === level ? ' on' : ''),
        'aria-pressed': String(v === level),
        onclick: () => { level = v; render(); }
      }, label));
    });
    wrap.append(chips);

    const ranked = rankWeak(prog, { level, limit: LIMIT, exclude: dupSet });
    if (!ranked.length) {
      wrap.append(h('div', { class: 'empty' }, [
        h('div', { class: 'big', text: '💪' }),
        h('p', {}, level === 'ALL' ? '目前沒有明顯的弱點' : `${level} 目前沒有明顯的弱點`),
        h('p', { class: 'small muted' }, `多練幾輪後，錯得多、又還沒掌握的項目會排在這裡。`),
        h('button', { class: 'btn', style: 'max-width:220px;margin:12px auto 0', onclick: () => navigate('/learn') }, '去練習')
      ]));
      return;
    }

    wrap.append(h('button', {
      class: 'btn', style: 'margin:10px 0',
      onclick: () => navigate('/study', { mode: 'quiz', src: 'weak', level })
    }, `📝 針對這 ${Math.min(ranked.length, 20)} 項練一輪`));

    const box = h('div', { class: 'card' });
    const rows = await Promise.all(ranked.map(async (r) => {
      const found = await findItem(r.itemId);
      return { r, item: found?.item || null };
    }));
    let orphan = 0;
    for (const { r, item } of rows) {
      if (!item) { orphan += 1; continue; }
      const jp = item.type === 'vocab' ? (item.kanji || item.kana)
        : item.type === 'grammar' ? item.pattern
          : item.cat === 'kanji' ? item.kanji : item.jp;
      const zh = item.type === 'travel'
        ? (item.cat === 'kanji' ? item.jpMeaning : item.zh)
        : item.meaning;
      const acc = accuracyOf(r);
      box.append(h('div', { class: 'list-item' }, [
        h('div', { class: 'li-main' }, [
          h('div', { class: 'li-jp', text: jp }),
          h('div', { class: 'li-sub', text: zh }),
          h('div', { class: 'small muted', style: 'margin-top:2px' },
            `錯 ${r.wrong} / 共 ${(r.correct || 0) + (r.wrong || 0)} 次・正確率 ${acc}%・` +
            ((r.box ?? 0) >= LEARNED_BOX ? '已掌握但錯過很多次' : '尚未掌握'))
        ]),
        h('span', {
          class: `pill ${r.level === 'TRAVEL' ? 'travel' : String(r.level).toLowerCase()}`,
          text: r.level === 'TRAVEL' ? '旅行' : r.level
        })
      ]));
    }
    wrap.append(box);
    if (orphan) {
      wrap.append(h('p', { class: 'small muted' },
        `另有 ${orphan} 筆紀錄在目前題庫中找不到對應項目（題庫調整過），已略過。`));
    }
    wrap.append(h('button', { class: 'btn ghost', style: 'margin-top:12px', onclick: () => navigate('/mistakes') }, '看錯題本 →'));
  }
}
