/* 日文朗讀 — Web Speech API（SpeechSynthesis）
 * 完全在裝置端運作，無網路需求。不支援時所有函式安靜地不作用。
 */
import { getSetting, setSetting } from './store.js';

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
let jaVoice = null;
let voicesReady = false;

export function isSupported() {
  return !!synth && typeof SpeechSynthesisUtterance !== 'undefined';
}

function pickVoice() {
  if (!synth) return null;
  const voices = synth.getVoices();
  if (!voices.length) return null;
  voicesReady = true;
  // 優先：ja-JP；其次名稱含 Japanese / 日本語
  jaVoice =
    voices.find((v) => /^ja(-|_|$)/i.test(v.lang)) ||
    voices.find((v) => /japanese|日本語/i.test(v.name)) ||
    null;
  return jaVoice;
}

if (synth) {
  pickVoice();
  if (typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', pickVoice);
  } else {
    synth.onvoiceschanged = pickVoice;
  }
}

/** 是否有可用的日文語音（用來決定要不要顯示朗讀鈕） */
export function hasJapaneseVoice() {
  if (!isSupported()) return false;
  if (!voicesReady) pickVoice();
  // 即使沒有明確的 ja 語音，多數瀏覽器仍可用預設語音勉強發音；
  // 但為避免奇怪讀音，只有偵測到 ja 語音時才回報 true。
  return !!jaVoice;
}

/** 重新偵測語音清單。
 *  Android 的日文語音資料可能是使用者事後才下載的，
 *  所以「沒有日文語音」不是永久結論，要能重驗。 */
export function refreshVoices() {
  voicesReady = false;
  jaVoice = null;
  pickVoice();
  return !!jaVoice;
}

/** 等語音清單就緒（getVoices() 首次常常是空的）。 */
export function whenVoicesReady(timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!synth) return resolve(false);
    if (pickVoice()) return resolve(true);
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(!!pickVoice()); } };
    const t = setTimeout(finish, timeoutMs);
    const on = () => { clearTimeout(t); finish(); };
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', on, { once: true });
    } else {
      synth.onvoiceschanged = on;
    }
  });
}

/** 目前的語音狀態，給 UI 顯示用 */
export function voiceStatus() {
  const supported = isSupported();
  const voices = supported ? synth.getVoices() : [];
  return {
    supported,
    hasJa: !!jaVoice,
    voiceCount: voices.length,
    voiceName: jaVoice ? `${jaVoice.name}（${jaVoice.lang}）` : null
  };
}

/* iOS 規定：第一次 speak() 必須發生在使用者手勢的事件處理中，
 * 否則會被靜靜忽略。進入聽力練習時先用一段空白 utterance 解鎖。 */
let primed = false;
export function primeSpeech() {
  if (primed || !isSupported()) return;
  primed = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.lang = 'ja-JP';
    synth.speak(u);
  } catch (e) { /* 忽略 */ }
}

/**
 * 朗讀並回報「到底有沒有真的唸出來」。
 *
 * 為什麼需要這個：實測發現即使裝置上一個語音都沒有，
 * speak() 仍然會觸發 start/end 事件 —— 事件本身無法證明有出聲。
 * 但播放時間會跟文字長度成正比（實測 3 字約 1.3 秒、54 字約 10 秒），
 * 所以用「每字至少 40ms」當下限來判斷引擎是不是空轉。
 *
 * @returns {Promise<{ok:boolean, reason?:string, ms:number}>}
 */
export function speakChecked(text, { rate } = {}) {
  return new Promise((resolve) => {
    if (!isSupported()) return resolve({ ok: false, reason: 'unsupported', ms: 0 });
    if (!text) return resolve({ ok: false, reason: 'empty', ms: 0 });
    if (!jaVoice) pickVoice();
    if (!jaVoice) return resolve({ ok: false, reason: 'no-japanese-voice', ms: 0 });

    const chars = String(text).length;
    const minMs = Math.max(300, chars * 40); // 低於這個時間視為沒真的唸
    const t0 = Date.now();
    let started = false;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = 'ja-JP';
      u.voice = jaVoice;
      u.rate = rate || ratePref;
      u.pitch = 1;
      lastUtter = u;
      u.onstart = () => { started = true; };
      u.onend = () => {
        const ms = Date.now() - t0;
        if (!started) return done({ ok: false, reason: 'never-started', ms });
        if (ms < minMs) return done({ ok: false, reason: 'too-fast', ms });
        done({ ok: true, ms });
      };
      u.onerror = (e) => done({ ok: false, reason: 'error:' + (e.error || 'unknown'), ms: Date.now() - t0 });
      synth.speak(u);
      // 完全沒有任何事件的保險絲
      setTimeout(() => done({ ok: false, reason: 'timeout', ms: Date.now() - t0 }),
        Math.max(8000, chars * 400));
    } catch (e) {
      done({ ok: false, reason: 'exception', ms: 0 });
    }
  });
}

let lastUtter = null;
let ratePref = 0.95;

/** 朗讀語速偏好（0.6–1.1）。從設定載入後由 App 呼叫一次。 */
export function setRatePref(r) {
  const n = Number(r);
  if (Number.isFinite(n) && n >= 0.5 && n <= 1.2) ratePref = n;
}
export function getRatePref() {
  return ratePref;
}

export function speak(text, { rate } = {}) {
  if (!isSupported() || !text) return;
  try {
    synth.cancel();
    if (!jaVoice) pickVoice(); // 語音清單可能較晚才就緒，臨用前再試一次
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'ja-JP';
    if (jaVoice) u.voice = jaVoice;
    u.rate = rate || ratePref;
    u.pitch = 1;
    lastUtter = u;
    synth.speak(u);
  } catch (e) {
    /* 忽略 */
  }
}

export function stop() {
  if (synth) {
    try { synth.cancel(); } catch (e) { /* 忽略 */ }
  }
}

/* 朗讀偏好（是否在翻開閃卡時自動朗讀） */
export async function getAutoSpeak() {
  return !!(await getSetting('autoSpeak', false));
}
export async function setAutoSpeak(v) {
  return setSetting('autoSpeak', !!v);
}

/* 語速偏好（持久化） */
export async function loadRatePref() {
  const r = await getSetting('speechRate', 0.95);
  setRatePref(r);
  return getRatePref();
}
export async function setSpeechRate(v) {
  setRatePref(v);
  return setSetting('speechRate', getRatePref());
}

/**
 * 建立一個朗讀按鈕（🔊）。text 可為字串或回傳字串的函式。
 */
export function speakButton(text, opts = {}) {
  const btn = document.createElement('button');
  btn.className = 'icon-btn speak-btn' + (opts.small ? ' sm' : '');
  btn.type = 'button';
  btn.setAttribute('aria-label', '朗讀日文');
  btn.textContent = '🔊';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = typeof text === 'function' ? text() : text;
    speak(t, opts);
  });
  return btn;
}
