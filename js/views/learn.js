import { h, spinner, pct, progressBar } from '../ui.js';
import { getManifest, LEVELS, TYPES } from '../data.js';
import { progressMap } from '../store.js';
import { LEARNED_BOX, stageOf } from '../srs.js';
import { navigate } from '../router.js';
import { getSetting, setSetting } from '../store.js';

export default async function learnView(ctx) {
  const wrap = h('div');
  wrap.append(spinner());
  const [man, pmap] = await Promise.all([getManifest(), progressMap()]);
  const dupSet = new Set(man.dupIds || []);
  wrap.replaceChildren();

  const state = {
    type: ctx.query.type || (await getSetting('lastType', 'vocab')),
    level: ctx.query.level || (await getSetting('lastLevel', 'N5')),
    scope: ctx.query.scope || (await getSetting('lastScope', 'smart'))
  };

  function seg(options, cur, onPick) {
    return h('div', { class: 'btn-grid', style: `grid-template-columns:repeat(${options.length},1fr);gap:8px` },
      options.map((o) => h('button', {
        class: 'btn ' + (o.value === cur ? '' : 'secondary'),
        style: 'font-size:14px;min-height:42px',
        onclick: () => onPick(o.value)
      }, o.label)));
  }

  function render() {
    wrap.replaceChildren();

    wrap.append(h('div', { class: 'section-title', text: '練習內容' }));
    wrap.append(seg(TYPES.map((t) => ({ value: t.key, label: t.label })), state.type, (v) => { state.type = v; render(); }));

    wrap.append(h('div', { class: 'section-title', text: '級別' }));
    wrap.append(seg(LEVELS.map((l) => ({ value: l, label: l })), state.level, (v) => { state.level = v; render(); }));

    // 該組進度摘要
    const set = man.sets.find((s) => s.type === state.type && s.level === state.level);
    // 用 activeCount（扣掉跨級別重複），與首頁／統計頁的掌握度分母一致
    const total = set ? (set.activeCount ?? set.count) : 0;
    let learned = 0, learning = 0, dueNow = 0;
    const now = Date.now();
    for (const r of pmap.values()) {
      if (dupSet.has(r.itemId)) continue; // 舊版本練過、現已隱藏的重複詞不計入
      if (r.type !== state.type || r.level !== state.level) continue;
      const s = stageOf(r);
      if (s === 'learned') learned += 1;
      else learning += 1;               // 學習中與需加強都還在路上
      if (s !== 'learned' && r.due <= now) dueNow += 1;
    }
    wrap.append(h('div', { class: 'card', style: 'margin-top:10px' }, [
      h('div', { class: 'row spread', style: 'margin-bottom:6px' }, [
        h('span', { class: 'small muted', text: `題庫共 ${total} 項｜已掌握 ${learned}｜學習中 ${learning}` }),
        h('span', { class: 'small muted', text: `${pct(learned, total)}%` })
      ]),
      progressBar(learned, total, learned === total && total > 0, undefined, learning),
      // 「已掌握」不是答對一次就算，講清楚才不會讓人以為程式壞了
      h('p', { class: 'small muted', style: 'margin:8px 0 0;line-height:1.6' },
        '同一項目答對 3 次才算「已掌握」，而間隔是 1 天 → 2 天，所以最快要跨 3 天。' +
        '淺色段是「學習中」——今天練的會先進到這裡。'),
      dueNow
        ? h('p', { class: 'small', style: 'margin:6px 0 0;color:var(--primary);font-weight:600' },
          `🔔 這個範圍現在有 ${dueNow} 項到期，開始練習會優先出這些。`)
        : null,
      total === 0 ? h('p', { class: 'small muted', style: 'margin:8px 0 0' }, '此級別題庫尚在擴充中，敬請期待。') : null
    ]));

    wrap.append(h('div', { class: 'section-title', text: '出題範圍' }));
    wrap.append(seg([
      { value: 'smart', label: '智慧排程' },
      { value: 'random', label: '隨機' },
      { value: 'order', label: '依序' }
    ], state.scope, (v) => { state.scope = v; render(); }));
    wrap.append(h('p', { class: 'small muted', style: 'margin:6px 2px 0', text: {
      smart: '到期該複習的優先出（最多七成），其餘補新題——這樣掌握度才會往上走。',
      random: '整個題庫隨機抽。',
      order: '照題庫既定順序，適合從頭讀。'
    }[state.scope] }));

    wrap.append(h('div', { style: 'height:8px' }));
    const disabled = total === 0;
    wrap.append(h('button', {
      class: 'btn', style: 'margin-bottom:10px', disabled,
      onclick: () => start('flash')
    }, '🃏 閃卡背誦'));
    wrap.append(h('button', {
      class: 'btn secondary', style: 'margin-bottom:10px', disabled,
      onclick: () => start('quiz')
    }, '📝 四選一測驗'));
    wrap.append(h('button', {
      class: 'btn secondary', style: 'margin-bottom:10px', disabled,
      onclick: () => navigate('/listening', { level: state.level, scope: state.scope })
    }, '🎧 聽力練習'));
    wrap.append(h('div', { class: 'btn-grid' }, [
      h('button', {
        class: 'btn secondary', disabled,
        onclick: () => start('quiz', { qtype: 'reading' })
      }, '🈯 漢字讀音'),
      h('button', {
        class: 'btn secondary', disabled,
        onclick: () => start('quiz', { qtype: 'cloze' })
      }, '✏️ 例句填空')
    ]));
    wrap.append(h('button', {
      class: 'btn secondary', style: 'margin-top:10px',
      onclick: () => navigate('/exam', { level: state.level })
    }, '⏱️ 模擬考（計時）'));
  }

  async function start(mode, extra) {
    await Promise.all([
      setSetting('lastType', state.type),
      setSetting('lastLevel', state.level),
      setSetting('lastScope', state.scope)
    ]);
    navigate('/study', { type: state.type, level: state.level, mode, scope: state.scope, ...extra });
  }

  render();
  return wrap;
}
