/* 聽力練習
 *
 * 音源用瀏覽器內建的 speechSynthesis（零成本、免金鑰、本機語音可離線）。
 * 但各裝置差異很大，所以：
 *   1. 進來就先確認「真的有日文語音」，沒有就不給死按鈕，改顯示說明＋文字模式。
 *   2. 一律由使用者按 ▶ 才發聲（iOS 規定首次 speak 必須在手勢事件裡）。
 *   3. 播完會檢查播放時長，太短代表引擎空轉 → 主動提示並給「看文字」的退路。
 */
import { h, spinner, shuffle, progressBar, pct } from '../ui.js';
import { loadMany, loadTravelAll, LEVELS } from '../data.js';
import { recordAnswer, favoriteIdSet } from '../store.js';
import { navigate } from '../router.js';
import { actionRow } from '../itemview.js';
import {
  isSupported, hasJapaneseVoice, refreshVoices, whenVoicesReady,
  voiceStatus, primeSpeech, speakChecked, stop as stopSpeech
} from '../speech.js';
import { bindKeys } from '../keys.js';
import { audioOf } from '../qtypes.js';   // 與模擬考共用

const LIMIT = 10;
const SLOW_RATE = 0.7;

export default async function listeningView(ctx) {
  const wrap = h('div');
  wrap.append(spinner());

  await whenVoicesReady();           // getVoices() 首次常是空的，等它就緒
  const backTo = ctx.query.src === 'travel' ? '/travel' : '/learn';

  if (!isSupported()) {
    wrap.replaceChildren(unsupportedCard(backTo));
    return wrap;
  }
  if (!hasJapaneseVoice()) {
    wrap.replaceChildren(noVoiceCard(backTo, () => {
      // 重新偵測後整頁重來
      listeningView(ctx).then((n) => document.getElementById('view').replaceChildren(n));
    }));
    return wrap;
  }

  /* ---- 組題 ---- */
  const level = ctx.query.level || 'ALL';
  const scope = ctx.query.scope || 'random';
  let pool;
  if (ctx.query.src === 'travel') {
    pool = await loadTravelAll();
  } else if (level === 'ALL') {
    const [v, g] = await Promise.all([loadMany('vocab', LEVELS), loadMany('grammar', LEVELS)]);
    pool = [...v, ...g];
  } else {
    const [v, g] = await Promise.all([loadMany('vocab', [level]), loadMany('grammar', [level])]);
    pool = [...v, ...g];
  }
  pool = pool.filter((it) => audioOf(it));

  const favSet = await favoriteIdSet();
  wrap.replaceChildren();

  if (pool.length < 5) {
    wrap.append(h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '🎧' }),
      h('p', {}, '這個範圍沒有足夠的聽力題'),
      h('button', { class: 'btn ghost', style: 'max-width:220px;margin:12px auto 0', onclick: () => navigate(backTo) }, '返回')
    ]));
    return wrap;
  }

  const picked = (scope === 'order' ? pool : shuffle(pool)).slice(0, LIMIT);
  const questions = picked.map((item) => {
    const a = audioOf(item);
    // 干擾選項：同一批題庫裡其他題的中文意思，去重後取 3 個
    const others = shuffle(pool.filter((x) => x.id !== item.id))
      .map((x) => audioOf(x)?.zh)
      .filter((z) => z && z !== a.zh);
    const seen = new Set([a.zh]);
    const distractors = [];
    for (const z of others) {
      if (seen.has(z)) continue;
      seen.add(z);
      distractors.push(z);
      if (distractors.length >= 3) break;
    }
    const opts = shuffle([
      { text: a.zh, correct: true },
      ...distractors.map((z) => ({ text: z, correct: false }))
    ]);
    return { item, audio: a, opts };
  });

  let idx = 0;
  let answered = false;
  let finished = false;
  let correctCount = 0;
  let playCount = 0;
  let revealed = false;
  let audioTrouble = false;   // 播放異常時才顯示求助提示
  const wrongItems = [];

  bindKeys(wrap, (e) => {
    if (finished) return;
    if (e.key === 'p' || e.key === 'P') { doPlay(); return; }
    if (!answered) {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 4) {
        const btns = wrap.querySelectorAll('.opt:not([disabled])');
        if (btns[n - 1]) btns[n - 1].click();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      const nx = wrap.querySelector('.quiz-next');
      if (nx && document.activeElement !== nx) { nx.click(); e.preventDefault(); }
    }
  });

  let helpBox = null;   // 「沒聽到聲音？」區塊，播放後就地更新，不整頁重繪

  async function doPlay(rate) {
    const q = questions[idx];
    if (finished || !q) return;          // 收尾後殘留的自動播放 timer 不該再跑
    primeSpeech();                       // iOS：在手勢事件裡解鎖
    playCount += 1;
    const btn = wrap.querySelector('.play-btn');
    if (btn) { btn.classList.add('playing'); btn.disabled = true; }
    const res = await speakChecked(q.audio.jp, { rate });
    if (btn && btn.isConnected) { btn.classList.remove('playing'); btn.disabled = false; }
    if (!res.ok) audioTrouble = true;
    updateHelp();
  }

  /** 播放異常、或已經播兩次還沒作答 → 給「看文字」的退路，不讓人卡住 */
  function updateHelp() {
    if (!helpBox || !helpBox.isConnected) return;
    const show = !answered && (audioTrouble || playCount >= 2);
    helpBox.replaceChildren();
    helpBox.hidden = !show;
    if (!show) return;
    helpBox.append(
      h('span', { class: 'small muted', text: audioTrouble ? '沒有聽到聲音？' : '聽不出來？' }),
      revealed
        ? h('span', { class: 'small muted', text: '（已顯示文字）' })
        : h('button', {
          class: 'linklike small',
          onclick: () => { revealed = true; updateHelp(); updateReveal(); }
        }, '顯示日文原文')
    );
  }

  let revealBox = null;
  function updateReveal() {
    if (!revealBox || !revealBox.isConnected) return;
    const q = questions[idx];
    revealBox.replaceChildren();
    revealBox.hidden = !(revealed && !answered && q);
    if (revealBox.hidden) return;
    revealBox.append(
      h('div', { class: 'jp', text: q.audio.jp }),
      q.audio.kana ? h('div', { class: 'small muted', text: q.audio.kana }) : null
    );
  }

  function render() {
    const q = questions[idx];
    wrap.replaceChildren();

    wrap.append(h('div', { class: 'study-head' }, [
      h('span', { class: 'study-count', text: `${idx + 1} / ${questions.length}` }),
      progressBar(idx, questions.length, false, `第 ${idx + 1} 題，共 ${questions.length} 題`),
      h('button', {
        class: 'icon-btn', title: '結束', 'aria-label': '結束聽力練習',
        onclick: () => (idx === 0 && !answered ? navigate(backTo) : finish())
      }, '✕')
    ]));

    const isTravel = q.item.type === 'travel';
    wrap.append(h('div', { class: 'quiz-q' }, [
      h('span', {
        class: `pill ${isTravel ? 'travel' : String(q.item.level).toLowerCase()}`,
        style: 'margin-right:6px',
        text: isTravel ? '旅行' : q.item.level
      }),
      '聽聽看，這句話的意思是？'
    ]));

    /* ---- 播放區 ---- */
    const playBtn = h('button', {
      class: 'btn play-btn', 'aria-label': '播放日文語音',
      onclick: () => doPlay()
    }, '▶　播放');
    wrap.append(playBtn);
    wrap.append(h('div', { class: 'row', style: 'gap:8px;margin-top:8px' }, [
      h('button', { class: 'btn sm secondary', style: 'flex:1', onclick: () => doPlay(SLOW_RATE) }, '🐢 慢速'),
      h('button', { class: 'btn sm secondary', style: 'flex:1', onclick: () => doPlay() }, '🔁 重播')
    ]));

    helpBox = h('div', { class: 'audio-help', hidden: true });
    revealBox = h('div', { class: 'card', style: 'padding:10px 12px', hidden: true });
    wrap.append(helpBox, revealBox);
    updateHelp();
    updateReveal();

    /* ---- 選項 ---- */
    const optBox = h('div', { role: 'group', 'aria-label': '答案選項' });
    q.opts.forEach((o, i) => {
      const b = h('button', {
        class: 'opt' + (answered ? '' : ''),
        disabled: answered,
        onclick: () => pick(o, b, optBox)
      }, [h('span', { class: 'opt-num', text: String(i + 1) }), o.text]);
      if (answered) {
        if (o.correct) { b.classList.add('correct'); b.setAttribute('aria-label', `${o.text}（正確答案）`); }
      }
      optBox.append(b);
    });
    wrap.append(optBox);

    const fb = h('div', { id: 'fb', role: 'status', 'aria-live': 'polite' });
    wrap.append(fb);

    if (!answered) {
      wrap.append(h('p', { class: 'kbd-hint small muted', text: '鍵盤：P 播放・1–4 選答・Enter 下一題' }));
      // 第一題不自動播（iOS 首次 speak 必須來自手勢）；之後引擎已解鎖才自動播一次
      if (idx > 0 && playCount === 0) {
        const at = idx;
        setTimeout(() => { if (!finished && idx === at && playCount === 0) doPlay(); }, 250);
      }
    }
  }

  async function pick(o, btn, optBox) {
    if (answered) return;
    answered = true;
    updateHelp();     // 作答後收起「看文字」的退路，答案區會顯示完整原文
    updateReveal();
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
      wrongItems.push(q.item);
    } else {
      correctCount += 1;
    }
    await recordAnswer({
      item: q.item, level: q.item.level, type: q.item.type,
      grade: o.correct ? 'good' : 'again'
    });

    const fb = wrap.querySelector('#fb');
    fb.className = 'quiz-feedback ' + (o.correct ? 'ok' : 'no');
    fb.append(
      h('div', { class: 'row spread' }, [
        h('div', { class: 'fb-title', text: o.correct ? '答對了！' : '答錯了' }),
        actionRow(q.item, favSet)
      ]),
      h('div', { class: 'jp', style: 'font-size:17px;margin-top:4px', text: q.audio.jp }),
      q.audio.kana ? h('div', { class: 'small muted', text: q.audio.kana }) : null,
      h('div', { class: 'small', style: 'margin-top:4px', text: q.audio.zh })
    );

    const nextBtn = h('button', {
      class: 'btn quiz-next', style: 'margin-top:12px', onclick: next
    }, idx + 1 >= questions.length ? '看結果' : '下一題');
    wrap.append(nextBtn);
    requestAnimationFrame(() => nextBtn.focus());
  }

  function next() {
    idx += 1;
    answered = false;
    playCount = 0;
    revealed = false;
    if (idx >= questions.length) return finish();
    render();
  }

  function finish() {
    finished = true;
    stopSpeech();
    const done = Math.max(idx, answered ? idx + 1 : idx);
    wrap.replaceChildren();
    wrap.append(h('div', { class: 'result-hero', role: 'status' }, [
      h('div', { class: 'result-score', text: `${pct(correctCount, done || 1)}%` }),
      h('div', { class: 'muted', text: `聽對 ${correctCount} / ${done} 題` })
    ]));
    if (wrongItems.length) {
      wrap.append(h('div', { class: 'section-title', text: '需要再聽' }));
      const box = h('div', { class: 'card' });
      wrongItems.forEach((it) => {
        const a = audioOf(it);
        box.append(h('div', { class: 'list-item' }, [
          h('div', { class: 'li-main' }, [
            h('div', { class: 'li-jp', text: a.jp }),
            h('div', { class: 'li-sub', text: a.zh })
          ]),
          h('button', {
            class: 'icon-btn', 'aria-label': '朗讀這句',
            onclick: () => { primeSpeech(); speakChecked(a.jp); }
          }, '🔊')
        ]));
      });
      wrap.append(box);
    }
    wrap.append(h('button', {
      class: 'btn', style: 'margin-bottom:10px',
      onclick: () => listeningView(ctx).then((n) => document.getElementById('view').replaceChildren(n))
    }, '再來一輪'));
    wrap.append(h('button', { class: 'btn secondary', style: 'margin-bottom:10px', onclick: () => navigate(backTo) }, '換一組'));
    wrap.append(h('button', { class: 'btn ghost', onclick: () => navigate('/home') }, '回首頁'));
  }

  render();
  return wrap;
}

/* ---------- 沒有語音時的說明畫面（不是死按鈕） ---------- */

function unsupportedCard(backTo) {
  const box = h('div');
  box.append(h('div', { class: 'empty' }, [
    h('div', { class: 'big', text: '🎧' }),
    h('p', {}, '這個瀏覽器不支援語音合成'),
    h('p', { class: 'small muted' }, '聽力練習需要瀏覽器內建的語音功能。建議改用 Safari（iOS）或 Chrome（Android／電腦）開啟。')
  ]));
  box.append(h('button', { class: 'btn ghost', onclick: () => navigate(backTo) }, '返回'));
  return box;
}

function noVoiceCard(backTo, onRetry) {
  const st = voiceStatus();
  const box = h('div');
  box.append(h('div', { class: 'card' }, [
    h('div', { class: 'tile-title', text: '🎧 這台裝置還沒有日文語音' }),
    h('p', { class: 'small muted', style: 'margin:8px 0 0' },
      st.voiceCount
        ? `偵測到 ${st.voiceCount} 個語音，但其中沒有日文。聽力練習需要日文語音才能正確發音，所以先不開放，免得按了沒反應。`
        : '目前偵測不到任何語音。聽力練習需要日文語音才能正確發音，所以先不開放，免得按了沒反應。')
  ]));

  box.append(h('div', { class: 'section-title', text: '怎麼裝日文語音' }));
  const how = h('div', { class: 'card' });
  for (const [plat, steps] of [
    ['iPhone / iPad', '設定 → 一般 → 語言與地區 → 加入語言「日本語」；或 設定 → 輔助使用 → 朗讀內容 → 聲音 → 日文，下載一個聲音。'],
    ['Android', '設定 → 系統 → 語言與輸入法 → 文字轉語音輸出 → 偏好的引擎（Google 語音服務）→ 安裝語音資料 → 日本語。'],
    ['Windows', '設定 → 時間與語言 → 語言與地區 → 新增語言「日本語」，勾選「語音」選項後安裝。'],
    ['Mac', '系統設定 → 輔助使用 → 朗讀內容 → 系統語音 → 管理語音 → 下載日文（Kyoko）。']
  ]) {
    how.append(h('div', { class: 'list-item' }, [
      h('div', { class: 'li-main' }, [
        h('div', { class: 'li-jp', style: 'font-size:15px', text: plat }),
        h('div', { class: 'li-sub', text: steps })
      ])
    ]));
  }
  box.append(how);

  box.append(h('button', {
    class: 'btn', style: 'margin-bottom:10px',
    onclick: () => { refreshVoices(); onRetry(); }
  }, '🔄 裝好了，重新偵測'));
  box.append(h('button', {
    class: 'btn secondary', style: 'margin-bottom:10px',
    onclick: () => navigate('/study', { mode: 'quiz', type: 'vocab', level: 'N5', scope: 'smart' })
  }, '先改做四選一測驗'));
  box.append(h('button', { class: 'btn ghost', onclick: () => navigate(backTo) }, '返回'));
  return box;
}
