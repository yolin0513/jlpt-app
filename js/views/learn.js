import { h, spinner, pct, progressBar } from '../ui.js';
import { getManifest, LEVELS, TYPES } from '../data.js';
import { progressMap } from '../store.js';
import { LEARNED_BOX } from '../srs.js';
import { navigate } from '../router.js';
import { getSetting, setSetting } from '../store.js';

export default async function learnView(ctx) {
  const wrap = h('div');
  wrap.append(spinner());
  const [man, pmap] = await Promise.all([getManifest(), progressMap()]);
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
    const total = set ? set.count : 0;
    let learned = 0;
    for (const r of pmap.values()) {
      if (r.type === state.type && r.level === state.level && r.box >= LEARNED_BOX) learned += 1;
    }
    wrap.append(h('div', { class: 'card', style: 'margin-top:10px' }, [
      h('div', { class: 'row spread', style: 'margin-bottom:6px' }, [
        h('span', { class: 'small muted', text: `題庫共 ${total} 項｜已掌握 ${learned}` }),
        h('span', { class: 'small muted', text: `${pct(learned, total)}%` })
      ]),
      progressBar(learned, total, learned === total && total > 0),
      total === 0 ? h('p', { class: 'small muted', style: 'margin:8px 0 0' }, '此級別題庫尚在擴充中，敬請期待。') : null
    ]));

    wrap.append(h('div', { class: 'section-title', text: '出題範圍' }));
    wrap.append(seg([
      { value: 'smart', label: '新題優先' },
      { value: 'random', label: '隨機' },
      { value: 'order', label: '依序' }
    ], state.scope, (v) => { state.scope = v; render(); }));
    wrap.append(h('p', { class: 'small muted', style: 'margin:6px 2px 0', text: {
      smart: '先出還沒學過的，再出到期該複習的。',
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
      class: 'btn secondary', disabled,
      onclick: () => start('quiz')
    }, '📝 四選一測驗'));
  }

  async function start(mode) {
    await Promise.all([
      setSetting('lastType', state.type),
      setSetting('lastLevel', state.level),
      setSetting('lastScope', state.scope)
    ]);
    navigate('/study', { type: state.type, level: state.level, mode, scope: state.scope });
  }

  render();
  return wrap;
}
