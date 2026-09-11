/* 模擬考計時模式
 *
 * 和一般測驗最大的差別不是「有計時」，而是**作答當下不給對錯**：
 * 全科作答完才一次結算，中途可以跳題、回頭改答案——這才是考場的樣子。
 *
 * 時間不是隨便訂的：真實 JLPT 各級的「總時間 ÷ 題數」約是每題 45–65 秒，
 * 本模式就照這個節奏給時間，所以練到的是實際考場的作答速度。
 * 合格判定也照官方基準換算（各科基準點 19/60、總分合格線依級別不同）。
 *
 * 沒做的部分要講清楚：讀解（長文閱讀）本 App 沒有題庫，所以模擬考不含讀解，
 * 分數只能反映文字語彙／文法／聽解三科，不等於真實考試的總分。
 */
import { h, spinner, shuffle, pct } from '../ui.js';
import { loadMany, LEVELS } from '../data.js';
import { buildDistractors } from '../session.js';
import { recordAnswer, getSetting, setSetting } from '../store.js';
import { navigate } from '../router.js';
import {
  isSupported, hasJapaneseVoice, whenVoicesReady, primeSpeech,
  speakChecked, stop as stopSpeech
} from '../speech.js';
import {
  canAskReading, canAskCloze, readingIndex,
  makeReadingQuestion, makeClozeQuestion, audioOf
} from '../qtypes.js';
import { bindKeys } from '../keys.js';

/* 真實 JLPT 的作答節奏：總時間 ÷ 題數（言語知識部分），取整數秒 */
const SEC_PER_Q = { N5: 45, N4: 50, N3: 55, N2: 60, N1: 65 };
/* 聽解每題時間由音檔長度決定，與級別關係不大 */
const LISTEN_SEC_PER_Q = 35;

/* 官方合格基準：各科目基準點 19/60；總分合格線 /180 */
const PASS_SECTION = 19 / 60;
const PASS_TOTAL = { N5: 80 / 180, N4: 90 / 180, N3: 95 / 180, N2: 90 / 180, N1: 100 / 180 };

const LENGTHS = {
  quick: { label: '快速', vocab: 10, grammar: 8, listening: 5 },
  standard: { label: '標準', vocab: 20, grammar: 15, listening: 10 }
};

const HISTORY_KEY = 'examHistory';
const HISTORY_MAX = 20;

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;

export default async function examView(ctx) {
  const wrap = h('div');
  wrap.append(spinner());

  let level = ctx.query.level || (await getSetting('examLevel', 'N5')) || 'N5';
  if (!LEVELS.includes(level)) level = 'N5';
  let lenKey = ctx.query.len === 'standard' ? 'standard' : 'quick';

  await whenVoicesReady();
  const canListen = isSupported() && hasJapaneseVoice();

  // 目前正在進行的考試（runExam 會填），鍵盤只綁一次，避免「再考一次」重複綁定
  let running = null;
  bindKeys(wrap, (e) => {
    if (!running || !running.hasTimer()) return;
    const s = running.cur();
    const at = running.at();
    if (e.key === 'ArrowLeft' && at > 0) { running.goto(at - 1); return; }
    if (e.key === 'ArrowRight' && at + 1 < s.questions.length) { running.goto(at + 1); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 4) {
      const btns = wrap.querySelectorAll('.opt');
      if (btns[n - 1]) btns[n - 1].click();
    }
  });

  wrap.replaceChildren();
  renderSetup();
  return wrap;

  /* ============================ 設定畫面 ============================ */
  function sectionPlan() {
    const L = LENGTHS[lenKey];
    const per = SEC_PER_Q[level];
    const plan = [
      { key: 'vocab', name: '文字・語彙', n: L.vocab, sec: L.vocab * per },
      { key: 'grammar', name: '文法', n: L.grammar, sec: L.grammar * per }
    ];
    if (canListen) plan.push({ key: 'listening', name: '聽解', n: L.listening, sec: L.listening * LISTEN_SEC_PER_Q });
    return plan;
  }

  function renderSetup() {
    running = null;   // 回到設定畫面 = 沒有考試在跑
    const plan = sectionPlan();
    const totalSec = plan.reduce((a, s) => a + s.sec, 0);
    wrap.replaceChildren();

    wrap.append(h('div', { class: 'section-title', text: '📝 模擬考' }));
    wrap.append(h('p', { class: 'small muted', style: 'margin:-4px 0 12px' },
      '作答中不顯示對錯，可跳題與改答案，全科結束才結算——和考場一樣。'));

    wrap.append(h('div', { class: 'section-title', text: '級別' }));
    const lvBox = h('div', { class: 'chips' });
    LEVELS.forEach((lv) => {
      lvBox.append(h('button', {
        class: 'chip' + (lv === level ? ' on' : ''),
        'aria-pressed': String(lv === level),
        onclick: () => { level = lv; setSetting('examLevel', lv); renderSetup(); }
      }, lv));
    });
    wrap.append(lvBox);

    wrap.append(h('div', { class: 'section-title', text: '長度' }));
    const lenBox = h('div', { class: 'chips' });
    Object.entries(LENGTHS).forEach(([k, v]) => {
      lenBox.append(h('button', {
        class: 'chip' + (k === lenKey ? ' on' : ''),
        'aria-pressed': String(k === lenKey),
        onclick: () => { lenKey = k; renderSetup(); }
      }, v.label));
    });
    wrap.append(lenBox);

    const card = h('div', { class: 'card', style: 'margin-top:14px' });
    plan.forEach((s, i) => {
      card.append(h('div', { class: 'list-item' }, [
        h('div', { class: 'li-main' }, [
          h('div', { class: 'li-jp', text: `第 ${i + 1} 科　${s.name}` }),
          h('div', { class: 'li-sub', text: `${s.n} 題・${mmss(s.sec)}` })
        ])
      ]));
    });
    card.append(h('div', { class: 'list-item' }, [
      h('div', { class: 'li-main' }, [
        h('div', { class: 'li-jp', text: '合計' }),
        h('div', { class: 'li-sub', text: `${plan.reduce((a, s) => a + s.n, 0)} 題・約 ${Math.round(totalSec / 60)} 分鐘` })
      ])
    ]));
    wrap.append(card);

    wrap.append(h('p', { class: 'small muted', style: 'margin-top:10px' },
      `每題 ${SEC_PER_Q[level]} 秒，是 ${level} 實際考試「總時間 ÷ 題數」的節奏。`));
    if (!canListen) {
      wrap.append(h('p', { class: 'small muted' },
        '這台裝置沒有日文語音，本次不含聽解科目（可到「🎧 聽力練習」看安裝說明）。'));
    }
    wrap.append(h('p', { class: 'small muted' },
      '本 App 沒有讀解題庫，模擬考不含讀解，分數不等同真實考試總分。'));

    wrap.append(h('button', { class: 'btn', style: 'margin-top:12px', onclick: start }, '開始模擬考'));
    wrap.append(h('button', { class: 'btn ghost', style: 'margin-top:10px', onclick: () => navigate('/learn') }, '返回'));
    renderHistory();
  }

  async function renderHistory() {
    const hist = (await getSetting(HISTORY_KEY, [])) || [];
    if (!Array.isArray(hist) || !hist.length) return;
    wrap.append(h('div', { class: 'section-title', style: 'margin-top:18px', text: '歷次成績' }));
    const box = h('div', { class: 'card' });
    hist.slice(0, 8).forEach((r) => {
      const d = new Date(r.at);
      box.append(h('div', { class: 'list-item' }, [
        h('div', { class: 'li-main' }, [
          h('div', { class: 'li-jp', text: `${r.level}　${r.correct} / ${r.total}（${pct(r.correct, r.total)}%）` }),
          h('div', { class: 'li-sub', text: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}　${r.sections.map((s) => `${s.name} ${s.correct}/${s.total}`).join('・')}` })
        ]),
        h('span', { class: 'pill ' + (r.pass ? 'ok' : 'no'), text: r.pass ? '合格' : '不合格' })
      ]));
    });
    wrap.append(box);
  }

  /* ============================ 組卷 ============================ */
  async function start() {
    wrap.replaceChildren(spinner());
    const plan = sectionPlan();
    let pools;
    try {
      pools = await buildPaper(plan);
    } catch (e) {
      wrap.replaceChildren(h('div', { class: 'empty' }, [
        h('div', { class: 'big', text: '⚠️' }),
        h('p', {}, '出題失敗，請再試一次'),
        h('button', { class: 'btn ghost', style: 'max-width:200px;margin:0 auto', onclick: renderSetup }, '返回')
      ]));
      return;
    }
    const sections = plan
      .map((s) => ({ ...s, questions: pools[s.key] }))
      .filter((s) => s.questions.length > 0);
    if (!sections.length) {
      wrap.replaceChildren(h('div', { class: 'empty' }, [
        h('div', { class: 'big', text: '📭' }),
        h('p', {}, '這個級別沒有足夠的題目'),
        h('button', { class: 'btn ghost', style: 'max-width:200px;margin:0 auto', onclick: renderSetup }, '返回')
      ]));
      return;
    }
    // 題目可能不足，時間依實際題數重算，避免「10 題卻給 20 題的時間」
    sections.forEach((s) => { s.sec = s.key === 'listening' ? s.questions.length * LISTEN_SEC_PER_Q : s.questions.length * SEC_PER_Q[level]; });
    runExam(sections);
  }

  async function buildPaper(plan) {
    const [vocab, grammar] = await Promise.all([
      loadMany('vocab', [level]), loadMany('grammar', [level])
    ]);
    const out = { vocab: [], grammar: [], listening: [] };

    const vNeed = plan.find((s) => s.key === 'vocab')?.n || 0;
    if (vNeed) {
      const rIdx = await readingIndex();
      const picked = shuffle(vocab).slice(0, vNeed * 2);
      for (const item of picked) {
        if (out.vocab.length >= vNeed) break;
        // 一半漢字讀音（對應「漢字読み・表記」），一半語意（對應「文脈規定・言い換え」）
        let q = null;
        if (canAskReading(item) && Math.random() < 0.5) {
          q = makeReadingQuestion(item, rIdx, Math.random() < 0.7 ? 'kanji2kana' : 'kana2kanji');
        }
        if (!q || q.opts.length < 4) q = await plainVocabQ(item, vocab);
        if (q && q.opts.length >= 4) out.vocab.push(q);
      }
    }

    const gNeed = plan.find((s) => s.key === 'grammar')?.n || 0;
    if (gNeed) {
      const clozePool = [...vocab, ...grammar].filter(canAskCloze);
      const picked = shuffle(grammar).slice(0, gNeed * 2);
      for (const item of picked) {
        if (out.grammar.length >= gNeed) break;
        let q = null;
        if (canAskCloze(item) && Math.random() < 0.5) q = makeClozeQuestion(item, clozePool);
        if (!q || q.opts.length < 4) q = await plainGrammarQ(item, grammar);
        if (q && q.opts.length >= 4) out.grammar.push(q);
      }
    }

    const lNeed = plan.find((s) => s.key === 'listening')?.n || 0;
    if (lNeed) {
      const pool = [...vocab, ...grammar].filter((it) => audioOf(it));
      for (const item of shuffle(pool).slice(0, lNeed)) {
        const q = listeningQ(item, pool);
        if (q && q.opts.length >= 4) out.listening.push(q);
      }
    }
    return out;
  }

  async function plainVocabQ(item) {
    if (Math.random() < 0.5) {
      const d = await buildDistractors(item, 'vocab', item.level, 3, 'meaning');
      return mkQ(item, '這個單字的意思是？', item.kanji || item.kana,
        (item.kanji && item.kana && item.kanji !== item.kana) ? item.kana : '',
        item.meaning, d.map((x) => x.meaning), { promptIsJp: true });
    }
    const d = await buildDistractors(item, 'vocab', item.level, 3, 'kanji');
    return mkQ(item, '對應的日文單字是？', item.meaning, '',
      item.kanji || item.kana, d.map((x) => x.kanji || x.kana), { optionsAreJp: true });
  }

  async function plainGrammarQ(item) {
    if (Math.random() < 0.5) {
      const d = await buildDistractors(item, 'grammar', item.level, 3, 'pattern');
      return mkQ(item, '符合此意思／用法的文法是？', item.meaning, item.structure || '',
        item.pattern, d.map((x) => x.pattern), { optionsAreJp: true });
    }
    const d = await buildDistractors(item, 'grammar', item.level, 3, 'meaning');
    return mkQ(item, '這個文法的意思是？', item.pattern, '',
      item.meaning, d.map((x) => x.meaning), { promptIsJp: true });
  }

  function listeningQ(item, pool) {
    const a = audioOf(item);
    const seen = new Set([a.zh]);
    const distractors = [];
    for (const x of shuffle(pool)) {
      if (x.id === item.id) continue;
      const z = audioOf(x)?.zh;
      if (!z || seen.has(z)) continue;
      seen.add(z);
      distractors.push(z);
      if (distractors.length >= 3) break;
    }
    const q = mkQ(item, '聽到的句子意思是？', '', '', a.zh, distractors, {});
    if (q) q.audio = a;
    return q;
  }

  function mkQ(item, qLabel, prompt, promptSub, correct, distractors, flags) {
    const opts = shuffle([
      { text: correct, correct: true },
      ...distractors.filter(Boolean).map((t) => ({ text: t, correct: false }))
    ]).filter((o, i, arr) => o.text && arr.findIndex((z) => z.text === o.text) === i);
    return { item, qLabel, prompt, promptSub, opts, correctText: correct, picked: null, ...flags };
  }

  /* ============================ 考試進行 ============================ */
  function runExam(sections) {
    let si = 0;
    let qi = 0;
    let left = 0;
    let timer = null;
    const results = [];
    // 只有一份考試在跑：讓鍵盤處理器找得到目前這一份（避免「再考一次」重複綁定）
    running = {
      hasTimer: () => !!timer,
      cur: () => sections[si],
      goto: (n) => { qi = n; renderQ(); },
      at: () => qi
    };
    introSection();

    function introSection() {
      stopTimer();
      const s = sections[si];
      wrap.replaceChildren();
      wrap.append(h('div', { class: 'result-hero' }, [
        h('div', { class: 'muted', text: `第 ${si + 1} 科 / 共 ${sections.length} 科` }),
        h('div', { class: 'result-score', style: 'font-size:1.6rem', text: s.name }),
        h('div', { class: 'muted', text: `${s.questions.length} 題・${mmss(s.sec)}` })
      ]));
      if (s.key === 'listening') {
        wrap.append(h('p', { class: 'small muted', style: 'text-align:center' },
          '每題按 ▶ 播放，可重播；時間到會自動交卷。'));
      }
      wrap.append(h('button', {
        class: 'btn', style: 'margin-top:8px',
        onclick: () => {
          if (s.key === 'listening') primeSpeech();  // iOS 首次發聲必須在手勢事件裡
          beginSection();
        }
      }, '開始作答'));
      wrap.append(h('button', { class: 'btn ghost', style: 'margin-top:10px', onclick: quitConfirm }, '離開模擬考'));
    }

    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

    function beginSection() {
      qi = 0;
      left = sections[si].sec;
      stopTimer();
      timer = setInterval(() => {
        // 使用者可能已離開這個畫面（路由切換），自行收掉避免殘留計時器
        if (!document.body.contains(wrap)) { stopTimer(); stopSpeech(); return; }
        left -= 1;
        const el = wrap.querySelector('.exam-timer');
        if (el) {
          el.textContent = mmss(left);
          el.classList.toggle('urgent', left <= 60);
        }
        if (left <= 0) { stopTimer(); submitSection(true); }
      }, 1000);
      renderQ();
    }

    function renderQ() {
      const s = sections[si];
      const q = s.questions[qi];
      wrap.replaceChildren();

      wrap.append(h('div', { class: 'exam-head' }, [
        h('span', { class: 'pill ' + String(level).toLowerCase(), text: level }),
        h('span', { class: 'exam-sec', text: s.name }),
        h('span', { class: 'exam-timer' + (left <= 60 ? ' urgent' : ''), role: 'timer', 'aria-live': 'off', text: mmss(left) }),
        h('button', { class: 'icon-btn', title: '離開', 'aria-label': '離開模擬考', onclick: quitConfirm }, '✕')
      ]));

      // 題號導覽：看得出哪幾題還沒作答，也能直接跳過去改
      const nav = h('div', { class: 'exam-nav', role: 'group', 'aria-label': '題號' });
      s.questions.forEach((x, i) => {
        nav.append(h('button', {
          class: 'exam-no' + (x.picked != null ? ' done' : '') + (i === qi ? ' cur' : ''),
          'aria-label': `第 ${i + 1} 題${x.picked != null ? '（已作答）' : '（未作答）'}`,
          'aria-current': i === qi ? 'true' : null,
          onclick: () => { qi = i; renderQ(); }
        }, String(i + 1)));
      });
      wrap.append(nav);

      wrap.append(h('div', { class: 'quiz-q' }, `${qi + 1}. ${q.qLabel}`));

      if (q.audio) {
        wrap.append(h('div', { style: 'text-align:center;margin:10px 0' }, [
          h('button', { class: 'btn', style: 'max-width:200px;margin:0 auto', onclick: () => speakChecked(q.audio.jp) }, '▶ 播放'),
          h('button', {
            class: 'btn ghost', style: 'max-width:200px;margin:8px auto 0',
            onclick: () => speakChecked(q.audio.jp, { rate: 0.7 })
          }, '🐢 慢速')
        ]));
      } else {
        wrap.append(h('div', { class: 'quiz-prompt' }, [
          h('span', { class: q.promptIsJp ? 'jp' : '', text: q.prompt }),
          q.promptSub ? h('span', { class: 'sub', text: q.promptSub }) : null
        ]));
      }

      const optBox = h('div', { role: 'group', 'aria-label': '答案選項' });
      q.opts.forEach((o, i) => {
        optBox.append(h('button', {
          class: 'opt' + (q.optionsAreJp ? ' jp' : '') + (q.picked === i ? ' picked' : ''),
          'aria-pressed': String(q.picked === i),
          onclick: () => {
            q.picked = q.picked === i ? null : i;   // 再按一次取消，考場上可以留白
            if (q.picked != null && qi + 1 < s.questions.length) { qi += 1; renderQ(); } else renderQ();
          }
        }, [h('span', { class: 'opt-num', text: String(i + 1) }), o.text]));
      });
      wrap.append(optBox);

      const nrow = h('div', { class: 'row', style: 'gap:8px;margin-top:12px' }, [
        h('button', { class: 'btn ghost', disabled: qi === 0 || null, onclick: () => { qi -= 1; renderQ(); } }, '← 上一題'),
        h('button', { class: 'btn ghost', disabled: qi + 1 >= s.questions.length || null, onclick: () => { qi += 1; renderQ(); } }, '下一題 →')
      ]);
      wrap.append(nrow);

      const unanswered = s.questions.filter((x) => x.picked == null).length;
      wrap.append(h('button', {
        class: 'btn secondary', style: 'margin-top:10px',
        onclick: () => {
          if (unanswered && !confirm(`還有 ${unanswered} 題沒作答，未作答一律算錯。確定交卷？`)) return;
          submitSection(false);
        }
      }, si + 1 >= sections.length ? '交卷並看結果' : `交卷，進入下一科`));
      if (unanswered) wrap.append(h('p', { class: 'small muted', style: 'text-align:center' }, `尚有 ${unanswered} 題未作答`));

      wrap.append(h('p', { class: 'kbd-hint small muted', text: '鍵盤：1–4 選答・← → 換題' }));
    }

    async function submitSection(byTimeout) {
      stopTimer();
      stopSpeech();
      const s = sections[si];
      wrap.replaceChildren(spinner());
      let correct = 0;
      const wrong = [];
      for (const q of s.questions) {
        const hit = q.picked != null && q.opts[q.picked] && q.opts[q.picked].correct;
        if (hit) correct += 1; else wrong.push(q);
        // 未作答不記 SRS：時間到來不及寫，不代表「這個詞學錯了」
        if (q.picked != null) {
          await recordAnswer({ item: q.item, level: q.item.level, type: q.item.type, grade: hit ? 'good' : 'again' });
        }
      }
      results.push({ key: s.key, name: s.name, correct, total: s.questions.length, wrong, byTimeout });
      si += 1;
      if (si >= sections.length) finishExam(results);
      else introSection();
    }

    function quitConfirm() {
      if (!confirm('離開後這次模擬考不計分，確定離開？')) return;
      running = null;
      stopTimer();
      stopSpeech();
      navigate('/learn');
    }
  }

  /* ============================ 結算 ============================ */
  async function finishExam(results) {
    running = null;
    const total = results.reduce((a, r) => a + r.total, 0);
    const correct = results.reduce((a, r) => a + r.correct, 0);
    const overall = total ? correct / total : 0;
    const secOk = results.every((r) => (r.total ? r.correct / r.total : 0) >= PASS_SECTION);
    const pass = secOk && overall >= PASS_TOTAL[level];

    await saveHistory({
      at: Date.now(), level, len: lenKey, correct, total, pass,
      sections: results.map((r) => ({ key: r.key, name: r.name, correct: r.correct, total: r.total }))
    });

    wrap.replaceChildren();
    wrap.append(h('div', { class: 'result-hero', role: 'status' }, [
      h('div', { class: 'result-score', text: `${pct(correct, total || 1)}%` }),
      h('div', { class: 'muted', text: `答對 ${correct} / ${total} 題` }),
      h('div', { class: 'pill ' + (pass ? 'ok' : 'no'), style: 'margin-top:8px;display:inline-block', text: pass ? '達到合格基準' : '未達合格基準' })
    ]));

    wrap.append(h('div', { class: 'section-title', text: '各科表現' }));
    const card = h('div', { class: 'card' });
    results.forEach((r) => {
      const rate = r.total ? r.correct / r.total : 0;
      card.append(h('div', { class: 'list-item' }, [
        h('div', { class: 'li-main' }, [
          h('div', { class: 'li-jp', text: `${r.name}　${r.correct} / ${r.total}` }),
          h('div', { class: 'li-sub', text: `${Math.round(rate * 100)}%　基準 ${Math.round(PASS_SECTION * 100)}%${r.byTimeout ? '・時間到自動交卷' : ''}` })
        ]),
        h('span', { class: 'pill ' + (rate >= PASS_SECTION ? 'ok' : 'no'), text: rate >= PASS_SECTION ? '過' : '未過' })
      ]));
    });
    wrap.append(card);
    wrap.append(h('p', { class: 'small muted', style: 'margin-top:8px' },
      `判定依 JLPT 基準換算：各科需達 ${Math.round(PASS_SECTION * 100)}%（19/60），總分需達 ${Math.round(PASS_TOTAL[level] * 100)}%（${level} 合格線）。本模擬考不含讀解。`));

    const allWrong = results.flatMap((r) => r.wrong);
    if (allWrong.length) {
      wrap.append(h('div', { class: 'section-title', text: `需要加強（${allWrong.length}）` }));
      const wb = h('div', { class: 'card' });
      allWrong.forEach((q) => {
        const it = q.item;
        const jp = it.type === 'vocab' ? (it.kanji || it.kana) : it.pattern || it.jp;
        wb.append(h('div', { class: 'list-item' }, [
          h('div', { class: 'li-main' }, [
            h('div', { class: 'li-jp', text: jp }),
            h('div', { class: 'li-sub', text: `正解：${q.correctText}${q.picked == null ? '（未作答）' : ''}` })
          ])
        ]));
      });
      wrap.append(wb);
    }

    wrap.append(h('button', { class: 'btn', style: 'margin-top:12px', onclick: renderSetup }, '再考一次'));
    wrap.append(h('button', { class: 'btn ghost', style: 'margin-top:10px', onclick: () => navigate('/home') }, '回首頁'));
  }

  async function saveHistory(rec) {
    const prev = (await getSetting(HISTORY_KEY, [])) || [];
    const list = Array.isArray(prev) ? prev : [];
    list.unshift(rec);
    await setSetting(HISTORY_KEY, list.slice(0, HISTORY_MAX));
  }
}
