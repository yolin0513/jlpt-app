/* 特殊題型的出題邏輯：漢字讀音、例句填空
 *
 * 抽出來獨立成檔，是因為這兩種題型的「干擾選項怎麼選」才是重點，
 * 隨便挑三個選項會讓題目一眼就能排除、失去鑑別度。
 */
import { loadMany, LEVELS } from './data.js';
import { shuffle } from './ui.js';

const HAN = /[一-鿿]/;

/* ============================================================
 *  漢字讀音
 * ============================================================ */

/** 這個詞能不能出讀音題：要有漢字、有假名、而且兩者不同（片假名外來語不算） */
export function canAskReading(item) {
  return item.type === 'vocab' && !item.dup &&
    !!item.kanji && !!item.kana &&
    HAN.test(item.kanji) && item.kanji !== item.kana;
}

/* 同一個漢字寫法可能有多個合法讀音（同形異讀）。
 * 題目綁在「詞」上，但干擾選項若剛好是同一寫法的另一個讀音就會變成兩個正解，
 * 所以先建一份 漢字寫法 → 所有合法讀音 的索引來排除。 */
let _readingIndex = null;
export async function readingIndex() {
  if (_readingIndex) return _readingIndex;
  const all = await loadMany('vocab', LEVELS);
  const byKanji = new Map();   // 漢字寫法 → Set<讀音>
  const byKana = new Map();    // 讀音 → Set<漢字寫法>（同音異字）
  for (const it of all) {
    if (!canAskReading(it)) continue;
    if (!byKanji.has(it.kanji)) byKanji.set(it.kanji, new Set());
    byKanji.get(it.kanji).add(it.kana);
    if (!byKana.has(it.kana)) byKana.set(it.kana, new Set());
    byKana.get(it.kana).add(it.kanji);
  }
  _readingIndex = { byKanji, byKana, all };
  return _readingIndex;
}

/** 片假名→平假名，比對音近程度時用 */
function toHira(s) {
  return String(s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 兩個讀音的「像不像」分數 —— 越像越適合當干擾選項 */
function similarity(a, b) {
  const x = toHira(a), y = toHira(b);
  if (x === y) return -1;               // 一樣就不能當干擾選項
  let s = 0;
  if (x.length === y.length) s += 3;    // 拍數相同最容易混淆
  else if (Math.abs(x.length - y.length) === 1) s += 1;
  if (x[0] === y[0]) s += 2;            // 同開頭
  if (x[x.length - 1] === y[y.length - 1]) s += 2;  // 同結尾
  if (/[っゃゅょー]/.test(x) === /[っゃゅょー]/.test(y)) s += 1; // 促音/拗音/長音的有無一致
  // 外來語（片假名讀音）混在漢語詞裡會一眼被排除，扣分
  if (/^[ァ-ヴー]+$/.test(a) !== /^[ァ-ヴー]+$/.test(b)) s -= 3;
  return s;
}

/**
 * 出一題漢字讀音題。
 * @param {object} item  目標單字
 * @param {object} idx   readingIndex() 的結果
 * @param {'kanji2kana'|'kana2kanji'} dir
 */
export function makeReadingQuestion(item, idx, dir) {
  const validReadings = idx.byKanji.get(item.kanji) || new Set([item.kana]);

  if (dir === 'kana2kanji') {
    // 給讀音選漢字：必須排除同音異字，否則會有兩個正解
    const sameSound = idx.byKana.get(item.kana) || new Set();
    const cands = idx.all.filter((x) =>
      x.id !== item.id &&
      x.kanji !== item.kanji &&
      !sameSound.has(x.kanji) &&          // ← 同音異字：排除
      x.kanji.length === item.kanji.length // 字數相同，看起來才像
    );
    const picked = pickDistinct(shuffle(cands), 3, (x) => x.kanji);
    const opts = shuffle([
      { text: item.kanji, correct: true },
      ...picked.map((x) => ({ text: x.kanji, correct: false }))
    ]);
    return {
      item, opts,
      qLabel: '這個讀音對應哪個漢字？',
      prompt: item.kana, promptSub: '', promptIsJp: true, optionsAreJp: true,
      correctText: item.kanji
    };
  }

  // 給漢字選讀音
  const cands = idx.all.filter((x) =>
    x.id !== item.id &&
    !validReadings.has(x.kana)            // ← 同形異讀：排除該寫法的其他合法讀音
  );
  // 依「音近程度」排序，取最像的幾個當干擾選項
  const scored = cands
    .map((x) => ({ x, s: similarity(item.kana, x.kana) }))
    .filter((o) => o.s >= 0)
    .sort((a, b) => b.s - a.s);
  const top = scored.slice(0, 40);        // 取前段再隨機，避免每次都出同樣三個
  const picked = pickDistinct(shuffle(top).map((o) => o.x), 3, (x) => x.kana);
  const opts = shuffle([
    { text: item.kana, correct: true },
    ...picked.map((x) => ({ text: x.kana, correct: false }))
  ]);
  return {
    item, opts,
    qLabel: '這個詞怎麼唸？',
    prompt: item.kanji, promptSub: item.pos || '', promptIsJp: true, optionsAreJp: true,
    correctText: item.kana
  };
}

/* ============================================================
 *  例句填空
 * ============================================================ */

/** 把目標詞在例句裡實際出現的那一段找出來（含活用變化） */
export function findBlankSpan(item) {
  const sent = item.example || '';
  if (!sent) return null;

  if (item.type === 'grammar') {
    // 文法：句型可能寫成「～ながら」「～ば～ほど」「～得る／～得ない」
    const parts = String(item.pattern || '')
      .split(/[／/]/)[0]                       // 取第一個變體
      .replace(/[～~]/g, '')                   // 去掉波浪
      .replace(/（.*?）/g, '')                  // 去掉括號註解
      .trim();
    if (parts && sent.includes(parts)) {
      return { text: parts, start: sent.indexOf(parts) };
    }
    return null;
  }

  // 單字：先試原形，再試去掉語尾的語幹（食べる→食べ、勉強する→勉強）
  const cands = [item.kanji];
  const k = item.kanji;
  if (/する$/.test(k)) cands.push(k.slice(0, -2));
  if (/[うくぐすつぬぶむるい]$/.test(k) && k.length > 1) cands.push(k.slice(0, -1));
  if (item.kana && item.kana !== k) cands.push(item.kana);
  for (const c of cands) {
    if (c && c.length >= 1 && sent.includes(c)) {
      return { text: c, start: sent.indexOf(c) };
    }
  }
  return null;
}

/** 這個項目能不能出填空題：例句裡真的找得到目標詞 */
export function canAskCloze(item) {
  if (item.dup) return false;
  if (!item.example || !item.exampleMeaning) return false;
  const span = findBlankSpan(item);
  // 挖掉的片段太短（1 個假名）會變成猜字遊戲，沒有鑑別度
  return !!span && span.text.length >= 2;
}

/**
 * 出一題例句填空。
 * 干擾選項挑「同詞性、長度相近」的詞，讓四個選項都塞得進句子、真的要懂意思才能選。
 */
export function makeClozeQuestion(item, pool) {
  const span = findBlankSpan(item);
  if (!span) return null;
  const sent = item.example;
  const blanked = sent.slice(0, span.start) + '＿＿＿' + sent.slice(span.start + span.text.length);

  const isGrammar = item.type === 'grammar';
  const answer = span.text;

  /* 干擾選項要「塞得進這個空格」才有鑑別度。
   * 最強也最便宜的訊號是空格前後那個字 —— 多半是助詞，
   * 直接決定了這裡能放什麼詞（「～の＿を検討」跟「ボールが＿に転がる」要的東西完全不同）。 */
  const ctxBefore = span.start > 0 ? sent[span.start - 1] : '';
  const ctxAfter = sent[span.start + answer.length] || '';
  const isKata = (s) => /^[ァ-ヴー]+$/.test(s);

  const sameKind = pool.filter((x) => x.id !== item.id && x.type === item.type && !x.dup);
  const scored = sameKind.map((x) => {
    const sp = findBlankSpan(x);
    if (!sp || sp.text === answer) return null;
    const xs = x.example;
    const before = sp.start > 0 ? xs[sp.start - 1] : '';
    const after = xs[sp.start + sp.text.length] || '';
    let s = 0;
    if (after && after === ctxAfter) s += 4;   // 後接助詞相同 → 文法上最可能成立
    if (before && before === ctxBefore) s += 2; // 前接字相同
    if (!isGrammar && x.pos && item.pos && x.pos === item.pos) s += 3;
    if (isKata(sp.text) === isKata(answer)) s += 2; // 都是外來語或都不是，外觀才不會一眼分出來
    const dl = Math.abs(sp.text.length - answer.length);
    if (dl === 0) s += 2; else if (dl === 1) s += 1; else if (dl >= 3) s -= 2;
    if (x.level === item.level) s += 1;
    return { text: sp.text, s };
  }).filter(Boolean).sort((a, b) => b.s - a.s);

  // 只從最像的前段裡隨機取，兼顧鑑別度與不重複
  const picked = pickDistinct(shuffle(scored.slice(0, 24)), 3, (o) => o.text)
    .filter((o) => o.text !== answer);
  if (picked.length < 3) return null;

  const opts = shuffle([
    { text: answer, correct: true },
    ...picked.map((o) => ({ text: o.text, correct: false }))
  ]);
  return {
    item, opts,
    qLabel: '選出最適合填入空格的選項',
    // 刻意不在題目顯示中譯 —— 顯示了等於直接給答案，這題就只剩看中文選詞。
    // 中譯在作答後的解說區才出現（quiz.js 的 feedback 本來就會帶例句與中譯）。
    prompt: blanked, promptSub: '',
    promptIsJp: true, optionsAreJp: true,
    correctText: answer
  };
}

/* ---------- 小工具 ---------- */
function pickDistinct(list, n, keyOf) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = keyOf(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}
