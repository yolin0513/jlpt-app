import { h, spinner, shuffle, progressBar, pct } from '../ui.js';
import { buildSession, buildDistractors } from '../session.js';
import { posFilter } from '../pos.js';
import { loadMany, LEVELS } from '../data.js';
import { recordAnswer, favoriteIdSet } from '../store.js';
import { navigate } from '../router.js';
import { actionRow, speakText } from '../itemview.js';
import { speak } from '../speech.js';
import { bindKeys } from '../keys.js';
import {
  canAskReading, canAskCloze, readingIndex,
  makeReadingQuestion, makeClozeQuestion
} from '../qtypes.js';
import { canAskSpell, makeSpellQuestion } from '../kana.js';

export default async function quizView(ctx) {
  const wrap = h('div');
  wrap.append(spinner());

  const src = ctx.query.src || 'set';
  const level = ctx.query.level || 'N5';
  const qtype = ctx.query.qtype || '';   // '' = 一般四選一；'reading' = 漢字讀音；'cloze' = 例句填空；'spell' = 拼寫（排假名方塊）
  const backTo = { travel: '/travel', review: '/review', mistakes: '/mistakes', favorites: '/favorites', weak: '/weak' }[src] || '/learn';
  const back = () => navigate(backTo);
  // 特殊題型只有部分題目適用，先在組卷階段篩掉
  const qFilter = qtype === 'reading' ? canAskReading
    : qtype === 'cloze' ? canAskCloze
      : qtype === 'spell' ? canAskSpell
        : null;
  // 詞性篩選只作用在一般題庫；複習／錯題本／收藏／弱點／旅行不受影響，
  // 網址被手動加上 pos 也一樣不理。兩個條件要同時成立，不是後者蓋掉前者。
  const pFilter = src === 'set' ? posFilter(ctx.query.pos) : null;
  const filter = qFilter && pFilter ? (it) => qFilter(it) && pFilter(it) : (qFilter || pFilter);
  const [{ items }, favSet] = await Promise.all([
    buildSession({
      type: (qtype === 'reading' || qtype === 'spell') ? 'vocab' : (ctx.query.type || 'vocab'),
      level,
      scope: ctx.query.scope || 'smart',
      src,
      cat: ctx.query.cat,
      scene: ctx.query.scene,
      filter
    }),
    favoriteIdSet()
  ]);
  // 特殊題型需要一份完整候選池來挑干擾選項
  const rIdx = qtype === 'reading' ? await readingIndex() : null;
  let clozePool = null;
  if (qtype === 'cloze') {
    const lv = level === 'ALL' ? LEVELS : [level];
    const [v, g] = await Promise.all([loadMany('vocab', lv), loadMany('grammar', lv)]);
    clozePool = [...v, ...g].filter(canAskCloze);
  }
  // 拼寫：混淆表不夠時，從同級其他單字的假名裡抽干擾方塊
  const spellPool = qtype === 'spell' ? await loadMany('vocab', level === 'ALL' ? LEVELS : [level]) : null;

  wrap.replaceChildren();
  if (!items.length) {
    wrap.append(h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '📭' }),
      h('p', {}, '沒有可測驗的項目'),
      h('button', { class: 'btn ghost', style: 'max-width:200px;margin:0 auto', onclick: back }, '返回選擇')
    ]));
    return wrap;
  }

  // 預先為每題準備題目
  const questions = [];
  for (const item of items) {
    questions.push(await makeQuestion(item));
  }

  let idx = 0;
  let answered = false;
  let finished = false;
  let correctCount = 0;
  let moveFocus = false; // 僅在使用者動作後移動焦點，首次進場不搶焦點
  const wrongItems = [];

  bindKeys(wrap, (e) => {
    if (finished) return;
    if (!answered) {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 4) {
        const btns = wrap.querySelectorAll('.opt:not([disabled])');
        if (btns[n - 1]) btns[n - 1].click();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      const nextBtn = wrap.querySelector('.quiz-next');
      // 若焦點已在「下一題」上，交給瀏覽器原生處理，避免重複觸發跳過題目
      if (nextBtn && document.activeElement !== nextBtn) { nextBtn.click(); e.preventDefault(); }
    } else if (e.key.toLowerCase() === 's') {
      speak(speakText(questions[idx].item));
    }
  });

  async function makeQuestion(item) {
    // 漢字讀音 / 例句填空：題目與干擾選項的邏輯在 qtypes.js
    if (qtype === 'reading') {
      const dir = Math.random() < 0.7 ? 'kanji2kana' : 'kana2kanji';
      const q = makeReadingQuestion(item, rIdx, dir);
      if (q && q.opts.length >= 2) return q;
    }
    if (qtype === 'cloze') {
      const q = makeClozeQuestion(item, clozePool);
      if (q && q.opts.length >= 2) return q;
    }
    if (qtype === 'spell') {
      const q = makeSpellQuestion(item, spellPool);
      if (q) return q;
    }

    let prompt, promptSub = '', correct, optionOf, qLabel, distractorField;

    let promptIsJp = false, optionsAreJp = false;

    if (item.type === 'vocab') {
      if (Math.random() < 0.5) {
        prompt = item.kanji || item.kana; promptIsJp = true;
        promptSub = (item.kanji && item.kana && item.kanji !== item.kana) ? item.kana : '';
        correct = item.meaning; optionOf = (x) => x.meaning;
        qLabel = '這個單字的意思是？'; distractorField = 'meaning';
      } else {
        prompt = item.meaning; optionsAreJp = true;
        correct = item.kanji || item.kana; optionOf = (x) => (x.kanji || x.kana);
        qLabel = '對應的日文單字是？'; distractorField = 'kanji';
      }
    } else if (item.type === 'grammar') {
      if (Math.random() < 0.5) {
        prompt = item.meaning; promptSub = item.structure || ''; optionsAreJp = true;
        correct = item.pattern; optionOf = (x) => x.pattern;
        qLabel = '符合此意思／用法的文法是？'; distractorField = 'pattern';
      } else {
        prompt = item.pattern; promptIsJp = true;
        correct = item.meaning; optionOf = (x) => x.meaning;
        qLabel = '這個文法的意思是？'; distractorField = 'meaning';
      }
    } else if (item.cat === 'kanji') {
      if (Math.random() < 0.5) {
        prompt = item.kanji; promptSub = '（日文漢字）'; promptIsJp = true;
        correct = item.jpMeaning; optionOf = (x) => x.jpMeaning;
        qLabel = '這個漢字在日文的意思是？'; distractorField = 'jpMeaning';
      } else {
        prompt = item.jpMeaning; promptSub = '對應哪個日文漢字？'; optionsAreJp = true;
        correct = item.kanji; optionOf = (x) => x.kanji;
        qLabel = '哪個漢字在日文是這個意思？'; distractorField = 'kanji';
      }
    } else {
      // travel phrases / usage
      if (Math.random() < 0.5) {
        prompt = item.zh; promptSub = item.scene || ''; optionsAreJp = true;
        correct = item.jp; optionOf = (x) => x.jp;
        qLabel = item.cat === 'usage' ? '日文會怎麼說？' : '用日文怎麼說？';
        distractorField = 'jp';
      } else {
        prompt = item.jp; promptSub = item.kana || ''; promptIsJp = true;
        correct = item.zh; optionOf = (x) => x.zh;
        qLabel = '這句話的意思是？'; distractorField = 'zh';
      }
    }

    const distractors = await buildDistractors(item, item.type, item.level, 3, distractorField);
    const opts = shuffle([
      { text: correct, correct: true },
      ...distractors.map((d) => ({ text: optionOf(d), correct: false }))
    ]).filter((o, i, arr) => o.text && arr.findIndex((z) => z.text === o.text) === i);

    return { item, prompt, promptSub, qLabel, opts, correctText: correct, promptIsJp, optionsAreJp };
  }

  function render() {
    const q = questions[idx];
    wrap.replaceChildren();

    wrap.append(h('div', { class: 'study-head' }, [
      h('span', { class: 'study-count', text: `${idx + 1} / ${questions.length}` }),
      progressBar(idx, questions.length, false, `第 ${idx + 1} 題，共 ${questions.length} 題`),
      h('button', { class: 'icon-btn', title: '結束', 'aria-label': '結束測驗', onclick: () => (idx === 0 && !answered ? back() : finish()) }, '✕')
    ]));

    const isTravel = q.item.type === 'travel';
    wrap.append(h('div', { class: 'quiz-q' }, [
      h('span', {
        class: `pill ${isTravel ? 'travel' : String(q.item.level).toLowerCase()}`,
        style: 'margin-right:6px',
        text: isTravel ? '旅行' : q.item.level
      }),
      q.qLabel
    ]));
    wrap.append(h('div', { class: 'quiz-prompt' }, [
      h('span', { class: q.promptIsJp ? 'jp' : '', text: q.prompt }),
      q.promptSub ? h('span', { class: 'sub', text: q.promptSub }) : null
    ]));

    if (q.kind === 'spell') { renderSpell(q); return; }

    const optBox = h('div', { role: 'group', 'aria-label': '答案選項' });
    q.opts.forEach((o, i) => {
      const b = h('button', { class: 'opt' + (q.optionsAreJp ? ' jp' : ''), onclick: () => pick(o, b, optBox) }, [
        h('span', { class: 'opt-num', text: String(i + 1) }),
        o.text
      ]);
      optBox.append(b);
    });
    wrap.append(optBox);

    const fb = h('div', { id: 'fb', role: 'status', 'aria-live': 'polite' });
    wrap.append(fb);

    if (!answered) {
      wrap.append(h('p', { class: 'kbd-hint small muted', text: '鍵盤：1–4 選答・Enter 下一題・S 朗讀' }));
      requestAnimationFrame(() => {
        const first = optBox.querySelector('.opt');
        if (moveFocus && first) first.focus();
        moveFocus = false;
      });
    }
  }

  /* 拼寫（排假名方塊）：點方塊填進下一個空格；點答案列裡的方塊退回（任何位置都能退）；
   * 填滿就自動判定。題目只顯示中文意思與詞性，不顯示漢字與讀音。 */
  function renderSpell(q) {
    const n = q.units.length;
    const placed = new Array(n).fill(null);   // 每一格放的是哪一個方塊（tile 物件）
    const slotRow = h('div', { class: 'spell-slots', role: 'group', 'aria-label': `答案列，共 ${n} 格` });
    const tileBox = h('div', { class: 'spell-tiles', role: 'group', 'aria-label': '假名方塊' });
    const fb = h('div', { id: 'fb', role: 'status', 'aria-live': 'polite' });

    function paint() {
      slotRow.replaceChildren(...placed.map((t, i) => h('button', {
        class: 'spell-slot' + (t ? ' filled' : ''),
        disabled: answered || !t,
        'aria-label': t ? `第 ${i + 1} 格：${t.text}（點一下退回）` : `第 ${i + 1} 格：空`,
        onclick: () => {
          if (answered || !placed[i]) return;
          placed[i] = null;
          paint();
        }
      }, t ? t.text : '')));
      const used = new Set(placed.filter(Boolean).map((t) => t.id));
      tileBox.replaceChildren(...q.tiles.map((t) => h('button', {
        class: 'spell-tile jp' + (used.has(t.id) ? ' used' : ''),
        disabled: answered || used.has(t.id),
        'aria-label': `假名方塊 ${t.text}${used.has(t.id) ? '（已使用）' : ''}`,
        onclick: () => {
          if (answered || used.has(t.id)) return;
          const at = placed.indexOf(null);
          if (at < 0) return;
          placed[at] = t;
          paint();
          if (placed.every(Boolean)) judge();
        }
      }, t.text)));
    }

    async function judge() {
      if (answered) return;
      answered = true;
      const got = placed.map((t) => t.text);
      // 唯一的判定：排出來的單位序列與拆出來的序列逐一相同
      const wrongAt = got.map((u, i) => (u === q.units[i] ? -1 : i)).filter((i) => i >= 0);
      const correct = wrongAt.length === 0;
      paint();
      slotRow.querySelectorAll('.spell-slot').forEach((el, i) => {
        el.classList.add(wrongAt.includes(i) ? 'wrong' : 'correct');
        if (wrongAt.includes(i)) el.setAttribute('aria-label', `第 ${i + 1} 格：${got[i]}（錯，應為 ${q.units[i]}）`);
      });
      const extra = correct ? [] : [h('div', { class: 'small spell-answer' }, `正確讀音：${q.item.kana}`)];
      await afterAnswer(correct, q, extra);
    }

    paint();
    wrap.append(slotRow, tileBox, fb);
    if (!answered) {
      requestAnimationFrame(() => {
        const first = tileBox.querySelector('.spell-tile');
        if (moveFocus && first) first.focus();
        moveFocus = false;
      });
    }
  }

  async function pick(o, btn, optBox) {
    if (answered) return;
    answered = true;
    const q = questions[idx];
    optBox.querySelectorAll('.opt').forEach((el, i) => {
      el.disabled = true;
      if (q.opts[i] && q.opts[i].correct) {
        el.classList.add('correct');
        el.setAttribute('aria-label', `${q.opts[i].text}（正確答案）`);
      }
    });
    if (!o.correct) {
      btn.classList.add('wrong');
      btn.setAttribute('aria-label', `${o.text}（你的選擇，答錯）`);
    }

    await afterAnswer(o.correct, q);
  }

  /* 答題後共用的收尾：記分、寫進度、解說、下一題（四選一與拼寫都走這裡）。
   * 拼寫與漢字讀音一樣：答對 good、答錯 again，不另訂分數對應。 */
  async function afterAnswer(correct, q, extraLines = []) {
    const grade = correct ? 'good' : 'again';
    if (correct) correctCount += 1;
    else wrongItems.push(q.item);
    await recordAnswer({ item: q.item, level: q.item.level, type: q.item.type, grade });

    const it = q.item;
    let detail;
    if (it.type === 'vocab') {
      detail = [
        h('div', { class: 'small' }, `${it.kanji || ''}${it.kana && it.kana !== it.kanji ? '（' + it.kana + '）' : ''}　${it.meaning}`),
        it.example ? h('div', { class: 'small muted', style: 'margin-top:4px' }, `${it.example}${it.exampleMeaning ? '　' + it.exampleMeaning : ''}`) : null
      ];
    } else if (it.type === 'travel' && it.cat === 'kanji') {
      detail = [
        h('div', { class: 'small' }, `${it.kanji}（${it.reading}）日文意思：${it.jpMeaning}`),
        it.zhMisread ? h('div', { class: 'small', style: 'color:var(--bad)' }, `台灣人常誤解：${it.zhMisread}`) : null,
        it.example ? h('div', { class: 'small muted', style: 'margin-top:4px' }, `${it.example}${it.exampleMeaning ? '　' + it.exampleMeaning : ''}`) : null
      ];
    } else if (it.type === 'travel') {
      detail = [
        h('div', { class: 'small' }, `${it.jp}${it.kana ? '（' + it.kana + '）' : ''}`),
        h('div', { class: 'small muted' }, it.zh),
        it.note ? h('div', { class: 'small', style: 'color:var(--accent);margin-top:4px' }, it.cat === 'usage' ? `💡 ${it.note}` : it.note) : null
      ];
    } else {
      detail = [
        h('div', { class: 'small' }, `${it.pattern}　${it.meaning}`),
        it.structure ? h('div', { class: 'small muted' }, it.structure) : null,
        it.example ? h('div', { class: 'small muted', style: 'margin-top:4px' }, `${it.example}${it.exampleMeaning ? '　' + it.exampleMeaning : ''}`) : null
      ];
    }

    const fb = document.getElementById('fb');
    fb.className = 'quiz-feedback ' + (correct ? 'ok' : 'no');
    fb.append(
      h('div', { class: 'row spread' }, [
        h('div', { class: 'fb-title', text: correct ? '答對了！' : '答錯了' }),
        actionRow(it, favSet)
      ]),
      ...extraLines,
      ...detail.filter(Boolean)
    );

    const nextBtn = h('button', {
      class: 'btn quiz-next', style: 'margin-top:12px',
      onclick: next
    }, idx + 1 >= questions.length ? '看結果' : '下一題');
    wrap.append(nextBtn);
    requestAnimationFrame(() => nextBtn.focus());
  }

  function next() {
    idx += 1;
    answered = false;
    moveFocus = true;
    if (idx >= questions.length) return finish();
    render();
  }

  function finish() {
    finished = true;
    const done = Math.max(idx, answered ? idx + 1 : idx);
    const acc = pct(correctCount, done || 1);
    wrap.replaceChildren();
    wrap.append(h('div', { class: 'result-hero', role: 'status' }, [
      h('div', { class: 'result-score', text: `${acc}%` }),
      h('div', { class: 'muted', text: `答對 ${correctCount} / ${done} 題` })
    ]));
    if (wrongItems.length) {
      wrap.append(h('div', { class: 'section-title', text: '需要加強' }));
      const box = h('div', { class: 'card' });
      wrongItems.forEach((it) => {
        const jp = it.type === 'vocab' ? (it.kanji || it.kana)
          : it.type === 'grammar' ? it.pattern
            : it.cat === 'kanji' ? it.kanji : it.jp;
        const zh = it.type === 'travel'
          ? (it.cat === 'kanji' ? it.jpMeaning : it.zh)
          : it.meaning;
        box.append(h('div', { class: 'list-item' }, [
          h('div', { class: 'li-main' }, [
            h('div', { class: 'li-jp', text: jp }),
            h('div', { class: 'li-sub', text: zh })
          ])
        ]));
      });
      wrap.append(box);
      wrap.append(h('button', {
        class: 'btn', style: 'margin-bottom:10px',
        onclick: () => restartWith(wrongItems.slice())
      }, `重做答錯的 ${wrongItems.length} 題`));
    }
    wrap.append(h('button', { class: 'btn secondary', style: 'margin-bottom:10px', onclick: () => navigate(backTo) }, '換一組'));
    wrap.append(h('button', { class: 'btn ghost', onclick: () => navigate('/home') }, '回首頁'));
  }

  async function restartWith(list) {
    questions.length = 0;
    for (const item of list) {
      questions.push(await makeQuestion(item));
    }
    idx = 0; answered = false; finished = false; correctCount = 0; wrongItems.length = 0;
    render();
  }

  render();
  return wrap;
}
