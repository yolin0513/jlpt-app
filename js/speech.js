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
