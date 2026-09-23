/* 拼寫練習（排假名方塊）的核心：怎麼把讀音拆成方塊、干擾方塊怎麼挑。
 *
 * 判定只比「排出來的單位序列」與 splitKana() 拆出來的序列是否逐一相同，
 * 所以拆法就是判定標準——改這裡之前先跑 audit 的全題庫掃描（P2）。
 */
import { shuffle } from './ui.js';

// 會黏在前一個假名後面、自己不成一格的小字（拗音與外來語的小母音）。
// 促音「っ／ッ」不在這裡：它自己是一格。
const SMALL = new Set('ゃゅょャュョァィゥェォぁぃぅぇぉゎヮ');
// 一般的假名字元（含長音「ー」與疊字符號）；「・」（U+30FB）不算
const KANA_CHAR = /^[ぁ-ゖゝゞァ-ヺーヽヾ]$/;

export const SPELL_MIN = 2;
export const SPELL_MAX = 8;

/**
 * 把讀音拆成方塊單位。含非假名字元（括號、「・」、「〜」、空白…）或小字開頭 → 回傳 null（不出題）。
 * 平假名、片假名照原樣，不轉換。
 */
export function splitKana(s) {
  const str = String(s || '');
  if (!str) return null;
  const out = [];
  for (const ch of str) {
    if (!KANA_CHAR.test(ch)) return null;
    if (SMALL.has(ch)) {
      if (!out.length) return null;          // 小字前面沒有可以黏的假名
      out[out.length - 1] += ch;
    } else {
      out.push(ch);
    }
  }
  return out;
}

/** 這個單字能不能出拼寫題 */
export function canAskSpell(item) {
  if (!item || item.type !== 'vocab' || item.dup) return false;
  const u = splitKana(item.kana);
  return !!u && u.length >= SPELL_MIN && u.length <= SPELL_MAX;
}

/** 干擾方塊的數量：max(3, 正確單位數的一半無條件進位)；8 個單位時總數 8＋4＝12 */
export function distractorCount(n) {
  return Math.max(3, Math.ceil(n / 2));
}

/* ---------- 混淆表（以平假名寫；片假名的字用同一張表轉成片假名） ---------- */
const ROWS = [
  'あいうえお', 'かきくけこ', 'がぎぐげご', 'さしすせそ', 'ざじずぜぞ',
  'たちつてと', 'だぢづでど', 'なにぬねの', 'はひふへほ', 'ばびぶべぼ',
  'ぱぴぷぺぽ', 'まみむめも', 'やゆよ', 'らりるれろ', 'わをん'
];
// 清音↔濁音↔半濁音：同一欄
const VOICING = [['かきくけこ', 'がぎぐげご'], ['さしすせそ', 'ざじずぜぞ'], ['たちつてと', 'だぢづでど'],
  ['はひふへほ', 'ばびぶべぼ', 'ぱぴぷぺぽ']];
// 長得像的（平假名一組、片假名一組）
const LOOKALIKE = [
  ['さ', 'ち'], ['ぬ', 'め'], ['ね', 'れ', 'わ'], ['る', 'ろ'], ['は', 'ほ'], ['い', 'り'], ['こ', 'に'], ['あ', 'お'], ['き', 'さ'],
  ['っ', 'つ'],
  ['シ', 'ツ'], ['ソ', 'ン'], ['ク', 'ケ'], ['ワ', 'ウ'], ['コ', 'ユ'], ['チ', 'テ'], ['ヌ', 'ス'], ['ッ', 'ツ']
];

const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const isKataUnit = (u) => /[ァ-ヺ]/.test(u);

function buildTable() {
  const m = new Map();   // 平假名單字元 → Set<容易混淆的平假名>
  const add = (a, b) => {
    if (a === b) return;
    if (!m.has(a)) m.set(a, new Set());
    m.get(a).add(b);
  };
  for (const row of ROWS) for (const a of row) for (const b of row) add(a, b);
  for (const cols of VOICING) {
    for (let i = 0; i < cols[0].length; i++) {
      const group = cols.map((r) => r[i]);
      for (const a of group) for (const b of group) add(a, b);
    }
  }
  return m;
}
const TABLE = buildTable();
/** 同一欄的清濁半濁夥伴（か → が；は → ば、ぱ） */
function voicingPartners(c) {
  for (const cols of VOICING) {
    for (const r of cols) {
      const i = r.indexOf(c);
      if (i >= 0) return cols.map((rr) => rr[i]).filter((x) => x !== c);
    }
  }
  return [];
}
const LOOK = new Map();
for (const g of LOOKALIKE) for (const a of g) for (const b of g) if (a !== b) {
  if (!LOOK.has(a)) LOOK.set(a, new Set());
  LOOK.get(a).add(b);
}

/** 一個方塊單位容易跟哪些單位搞混（同一種文字：平假名配平假名、片假名配片假名） */
export function confusablesOf(unit) {
  const kata = isKataUnit(unit);
  const out = new Set();
  for (const x of LOOK.get(unit) || []) out.add(x);
  const h = toHira(unit);
  const conv = (x) => (kata ? toKata(x) : x);
  if (h.length === 1) {
    for (const x of TABLE.get(h) || []) out.add(conv(x));
  } else if (h.length === 2 && SMALL.has(h[1])) {
    // 拗音：換小字的母音（きゃ↔きゅ↔きょ、ファ↔フィ↔フェ），也換前一個字的清濁（きゃ↔ぎゃ）
    const [head, tail] = [h[0], h[1]];
    const family = 'ゃゅょ'.includes(tail) ? 'ゃゅょ' : 'ぁぃぅぇぉ'.includes(tail) ? 'ぁぃぅぇぉ' : '';
    for (const t of family) if (t !== tail) out.add(conv(head + t));
    for (const x of voicingPartners(head)) out.add(conv(x + tail));
  }
  out.delete(unit);
  return [...out];
}

/**
 * 出一題拼寫題。
 * @param {object} item   目標單字（canAskSpell 必須為真）
 * @param {object[]} pool 同級其他單字（混淆表不夠時從這裡抽假名）
 */
export function makeSpellQuestion(item, pool) {
  const units = splitKana(item.kana);
  if (!units || units.length < SPELL_MIN || units.length > SPELL_MAX) return null;
  const correctSet = new Set(units);
  const need = distractorCount(units.length);
  const picked = [];
  const seen = new Set();
  const take = (u) => {
    // 干擾單位都不在正確答案的單位集合裡 → 不會出現另一種也合法的排法
    if (picked.length >= need || !u || correctSet.has(u) || seen.has(u)) return;
    seen.add(u);
    picked.push(u);
  };
  // 1) 先放容易混淆的
  const conf = [];
  for (const u of units) for (const c of confusablesOf(u)) conf.push(c);
  for (const c of shuffle(conf)) take(c);
  // 2) 不夠再從同級其他單字的假名裡抽（同一種文字優先）
  if (picked.length < need) {
    const kata = units.some(isKataUnit);
    const extra = [];
    for (const x of pool || []) {
      if (x.id === item.id) continue;
      const xs = splitKana(x.kana);
      if (!xs) continue;
      for (const u of xs) if (isKataUnit(u) === kata) extra.push(u);
    }
    for (const u of shuffle(extra)) take(u);
  }
  let n = 0;
  const tiles = shuffle([
    ...units.map((text) => ({ text, id: `t${n++}` })),
    ...picked.map((text) => ({ text, id: `t${n++}` }))
  ]);
  return {
    kind: 'spell', item, units, tiles,
    qLabel: '把讀音依序排出來',
    prompt: item.meaning, promptSub: item.pos || '', promptIsJp: false,
    correctText: item.kana
  };
}
