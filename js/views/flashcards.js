import { h, spinner, progressBar } from '../ui.js';
import { faceOf } from '../data.js';
import { buildSession } from '../session.js';
import { recordAnswer, bumpCardViewed, favoriteIdSet } from '../store.js';
import { navigate } from '../router.js';
import { actionRow, speakText } from '../itemview.js';
import { speak, getAutoSpeak, stop as stopSpeech } from '../speech.js';
import { bindKeys } from '../keys.js';

export default async function flashcardsView(ctx) {
  const wrap = h('div');
  wrap.append(spinner());

  const src = ctx.query.src || 'set';
  const backTo = { travel: '/travel', review: '/review', mistakes: '/mistakes', favorites: '/favorites' }[src] || '/learn';
  const [{ items }, favSet, autoSpeak] = await Promise.all([
    buildSession({
      type: ctx.query.type || 'vocab',
      level: ctx.query.level || 'N5',
      scope: ctx.query.scope || 'smart',
      src,
      cat: ctx.query.cat,
      scene: ctx.query.scene
    }),
    favoriteIdSet(),
    getAutoSpeak()
  ]);

  wrap.replaceChildren();
  if (!items.length) {
    wrap.replaceChildren(h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '🗂️' }),
      h('p', {}, '沒有可練習的項目'),
      h('button', { class: 'btn ghost', style: 'max-width:200px;margin:0 auto', onclick: () => navigate(backTo) }, '返回選擇')
    ]));
    return wrap;
  }

  let idx = 0;
  let flipped = false;
  let done = false;
  let moveFocus = false; // 僅在使用者動作後移動焦點，首次進場不搶焦點
  const tally = { good: 0, hard: 0, again: 0 };
  const againItems = [];

  bindKeys(wrap, (e) => {
    if (done) return;
    if (e.key === 'Escape') { end(); return; }
    if (!flipped) {
      if (e.key === ' ' || e.key === 'Enter') { doFlip(); e.preventDefault(); }
      return;
    }
    if (e.key === '1') grade('again');
    else if (e.key === '2') grade('hard');
    else if (e.key === '3' || e.key === ' ' || e.key === 'Enter') { grade('good'); e.preventDefault(); }
    else if (e.key.toLowerCase() === 's') speak(speakText(items[idx]));
  });

  function doFlip() {
    if (flipped) return;
    flipped = true;
    moveFocus = true;
    bumpCardViewed();
    if (autoSpeak) speak(speakText(items[idx]));
    render();
  }

  function render() {
    const item = items[idx];
    wrap.replaceChildren();

    wrap.append(h('div', { class: 'study-head' }, [
      h('span', { class: 'study-count', text: `${idx + 1} / ${items.length}` }),
      progressBar(idx, items.length, false, `第 ${idx + 1} 張，共 ${items.length} 張`),
      h('button', { class: 'icon-btn', title: '結束', 'aria-label': '結束練習', onclick: end }, '✕')
    ]));

    const card = h('div', {
      class: 'flashcard' + (flipped ? ' flipped' : ''),
      role: 'button',
      tabindex: '0',
      'aria-pressed': flipped ? 'true' : 'false',
      'aria-label': flipped ? '已翻面，下方為解答與評分' : '題面，點一下或按空白鍵看解答',
      onkeydown: (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !flipped) { e.preventDefault(); doFlip(); }
      }
    });
    let front, back;

    if (item.type === 'travel') {
      [front, back] = travelFaces(item);
    } else {
      const f = faceOf(item);
      front = h('div', { class: 'flash-face front' }, [
        h('div', { class: 'flash-main jp', style: item.type === 'vocab' ? '' : 'font-size:30px', text: f.main }),
        f.pos ? h('div', { class: 'flash-pos pill', text: f.pos }) : null,
        h('div', { class: 'flash-hint', text: '點一下看解答' })
      ]);
      const backKids = [];
      if (item.type === 'vocab') {
        if (f.reading) backKids.push(h('div', { class: 'flash-kana', text: f.reading }));
        backKids.push(h('div', { class: 'flash-meaning', text: f.meaning }));
      } else {
        backKids.push(h('div', { class: 'flash-meaning', style: 'font-size:20px', text: f.meaning }));
        if (item.structure) backKids.push(h('div', { class: 'small pill', text: item.structure }));
        if (item.explanation) backKids.push(h('div', { class: 'small muted', style: 'margin-top:4px', text: item.explanation }));
      }
      if (item.example) {
        backKids.push(h('div', { class: 'flash-example' }, [
          h('div', {}, [h('b', { text: item.example })]),
          item.exampleKana ? h('div', { class: 'small', text: item.exampleKana }) : null,
          item.exampleMeaning ? h('div', { class: 'small', text: item.exampleMeaning }) : null
        ]));
      }
      back = h('div', { class: 'flash-face back' }, backKids);
    }
    card.append(front, back);
    card.addEventListener('click', doFlip);
    wrap.append(h('div', { class: 'flashcard-wrap' }, [card]));

    // 星號 + 朗讀（翻面後才顯示，避免劇透）
    if (flipped) {
      wrap.append(h('div', { class: 'card-tools' }, [actionRow(item, favSet)]));
    }

    if (!flipped) {
      wrap.append(h('button', { class: 'btn', onclick: doFlip }, '顯示解答'));
      if (moveFocus) requestAnimationFrame(() => card.focus());
    } else {
      const knowBtn = h('button', { class: 'btn know', style: 'grid-column:1/3', onclick: () => grade('good') }, '認得 ✓');
      wrap.append(h('div', { class: 'grade-grid' }, [
        h('button', { class: 'btn dont', onclick: () => grade('again') }, '不會'),
        h('button', { class: 'btn secondary', onclick: () => grade('hard') }, '模糊'),
        knowBtn
      ]));
      wrap.append(h('p', { class: 'kbd-hint small muted', text: '鍵盤：1 不會・2 模糊・3 認得・S 朗讀' }));
      if (moveFocus) requestAnimationFrame(() => knowBtn.focus());
    }
    moveFocus = false;
  }

  let grading = false;
  async function grade(g) {
    if (!flipped || done || grading) return;
    grading = true;
    const item = items[idx];
    tally[g] += 1;
    if (g === 'again') againItems.push(item);
    await recordAnswer({ item, level: item.level, type: item.type, grade: g });
    idx += 1;
    flipped = false;
    moveFocus = true;
    grading = false;
    if (idx >= items.length) return finish();
    render();
  }

  function finish() {
    done = true;
    stopSpeech();
    wrap.replaceChildren();
    wrap.append(h('div', { class: 'result-hero', role: 'status' }, [
      h('div', { style: 'font-size:44px', text: '🎉' }),
      h('div', { class: 'big-num', text: `完成 ${idx} 張` })
    ]));
    wrap.append(h('div', { class: 'dist' }, [
      h('div', {}, [h('div', { class: 'big-num', style: 'font-size:22px', text: String(tally.good) }), h('div', { class: 'small muted', text: '認得' })]),
      h('div', {}, [h('div', { class: 'big-num', style: 'font-size:22px', text: String(tally.hard) }), h('div', { class: 'small muted', text: '模糊' })]),
      h('div', {}, [h('div', { class: 'big-num', style: 'font-size:22px', text: String(tally.again) }), h('div', { class: 'small muted', text: '不會' })])
    ]));
    wrap.append(h('div', { style: 'height:16px' }));
    if (againItems.length) {
      wrap.append(h('button', {
        class: 'btn', style: 'margin-bottom:10px',
        onclick: () => {
          items.length = 0; items.push(...againItems.splice(0));
          idx = 0; flipped = false; done = false; grading = false;
          tally.good = tally.hard = tally.again = 0;
          moveFocus = false;
          render();
        }
      }, `再練「不會」的 ${againItems.length} 張`));
    }
    wrap.append(h('button', { class: 'btn secondary', style: 'margin-bottom:10px', onclick: () => navigate(backTo) }, '換一組'));
    wrap.append(h('button', { class: 'btn ghost', onclick: () => navigate('/home') }, '回首頁'));
  }

  function end() {
    if (idx === 0 && !flipped) { navigate(backTo); return; }
    finish();
  }

  render();
  return wrap;
}

/* 生活旅行卡片的正反面 */
function travelFaces(item) {
  if (item.cat === 'kanji') {
    const front = h('div', { class: 'flash-face front' }, [
      h('div', { class: 'small muted', text: '日文漢字' }),
      h('div', { class: 'flash-main jp', text: item.kanji }),
      h('div', { class: 'flash-hint', text: '這個漢字在日文是什麼意思？' })
    ]);
    const back = h('div', { class: 'flash-face back' }, [
      item.reading ? h('div', { class: 'flash-kana', text: item.reading }) : null,
      h('div', { class: 'flash-meaning', style: 'font-size:22px', text: item.jpMeaning }),
      item.zhMisread ? h('div', { class: 'small', style: 'color:var(--bad);margin-top:4px', text: `台灣人常誤解：${item.zhMisread}` }) : null,
      item.example ? h('div', { class: 'flash-example' }, [
        h('div', {}, [h('b', { text: item.example })]),
        item.exampleKana ? h('div', { class: 'small', text: item.exampleKana }) : null,
        item.exampleMeaning ? h('div', { class: 'small', text: item.exampleMeaning }) : null
      ]) : null
    ]);
    return [front, back];
  }
  // phrases / usage：正面中文情境 → 背面日文
  const front = h('div', { class: 'flash-face front' }, [
    item.scene ? h('div', { class: 'small muted', text: item.scene }) : null,
    h('div', { class: 'flash-meaning', style: 'font-size:20px', text: item.zh }),
    h('div', { class: 'flash-hint', text: item.cat === 'usage' ? '日文會怎麼說？' : '用日文怎麼說？' })
  ]);
  const back = h('div', { class: 'flash-face back' }, [
    h('div', { class: 'flash-main jp', style: 'font-size:24px', text: item.jp }),
    item.kana ? h('div', { class: 'flash-kana', text: item.kana }) : null,
    item.note ? h('div', { class: 'small', style: 'margin-top:8px;color:var(--accent)', text: item.cat === 'usage' ? `💡 ${item.note}` : item.note }) : null
  ]);
  return [front, back];
}
