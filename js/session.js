/* 依設定組出一輪練習題目 */
import { loadSet, loadMany, findItem, LEVELS, loadTravel, loadTravelAll } from './data.js';
import { progressMap } from './store.js';
import { idb } from './db.js';
import { shuffle } from './ui.js';
import { openMistakes, allFavorites, allProgress } from './store.js';
import { rankWeak } from './weak.js';

const DEFAULT_LIMIT = 20;

/**
 * @param {object} o
 * @param {'vocab'|'grammar'} o.type
 * @param {string} o.level  'N5'..'N1' 或 'ALL'
 * @param {'smart'|'random'|'order'} o.scope
 * @param {'set'|'review'|'mistakes'|'favorites'|'weak'|'travel'} o.src
 * @param {number} [o.limit]
 * @returns {Promise<{items:any[], type:string, meta:object}>}
 */
export async function buildSession(o) {
  const limit = o.limit || DEFAULT_LIMIT;
  const pmap = await progressMap();

  if (o.src === 'review') {
    const dueRecs = await idb.dueProgress();
    dueRecs.sort((a, b) => a.due - b.due);
    const items = [];
    const seenTypes = new Set();
    for (const r of dueRecs) {
      const found = await findItem(r.itemId);
      if (found) { items.push({ ...found.item }); seenTypes.add(found.type); }
      if (items.length >= limit) break;
    }
    return { items, type: seenTypes.size === 1 ? [...seenTypes][0] : 'mixed', meta: { src: 'review', totalDue: dueRecs.length } };
  }

  if (o.src === 'mistakes') {
    const ms = await openMistakes();
    ms.sort((a, b) => (b.lastWrong || 0) - (a.lastWrong || 0));
    const items = [];
    for (const m of ms.slice(0, limit)) {
      const found = await findItem(m.itemId);
      if (found) items.push({ ...found.item });
    }
    return { items, type: 'mixed', meta: { src: 'mistakes' } };
  }

  if (o.src === 'weak') {
    const ranked = rankWeak(await allProgress(), { level: o.level || 'ALL', limit });
    const items = [];
    for (const r of ranked) {
      const found = await findItem(r.itemId);
      if (found) items.push({ ...found.item });
    }
    const types = new Set(items.map((i) => i.type));
    return { items, type: types.size === 1 ? [...types][0] : 'mixed', meta: { src: 'weak' } };
  }

  if (o.src === 'favorites') {
    const favs = await allFavorites();
    const ordered = o.scope === 'order' ? favs : shuffle(favs);
    const items = [];
    for (const f of ordered.slice(0, limit)) {
      const found = await findItem(f.itemId);
      if (found) items.push({ ...found.item });
    }
    const types = new Set(items.map((i) => i.type));
    return { items, type: types.size === 1 ? [...types][0] : 'mixed', meta: { src: 'favorites', total: favs.length } };
  }

  // 生活旅行
  if (o.src === 'travel') {
    let pool = (!o.cat || o.cat === 'all')
      ? await loadTravelAll()
      : await loadTravel(o.cat);
    if (o.scene) pool = pool.filter((it) => it.scene === o.scene);
    const ordered = orderPool(pool.slice(), o.scope, pmap);
    return {
      items: ordered.slice(0, limit),
      type: 'travel',
      meta: { src: 'travel', cat: o.cat || 'all', poolSize: pool.length }
    };
  }

  // 一般題庫
  // 級別一律以 o.level 為準。這裡原本還有個 `|| o.src === 'mix'`，
  // 會讓任何 src='mix' 的呼叫無視級別直接載入全部五級——首頁「N5 快速測驗」
  // 明明帶了 level=N5 卻出 N1~N5 的題就是這行造成的。要全級別請用 level='ALL'。
  let pool;
  if (o.level === 'ALL') {
    pool = await loadMany(o.type, LEVELS);
  } else {
    pool = await loadSet(o.type, o.level);
  }
  pool = pool.slice();
  // 特殊題型（漢字讀音、例句填空）只有部分題目適用 → 先篩掉不適用的
  if (typeof o.filter === 'function') pool = pool.filter(o.filter);

  const ordered = orderPool(pool, o.scope, pmap, limit);

  return {
    items: ordered.slice(0, limit),
    type: o.type,
    meta: { src: 'set', poolSize: pool.length }
  };
}

/** 一輪裡最多有多少比例給到期複習題（其餘留給新題，免得複習債一多就再也看不到新內容） */
export const DUE_QUOTA = 0.7;

/** 依 scope 排序題目池
 *
 * smart 原本是「未學過 → 已到期 → 其他」，但題庫有三千多條，
 * 未學過的永遠填滿整輪 20 題，**到期的複習題永遠排不進來** →
 * 使用者一直在把新題推到 box 1，沒有任何項目能升到 box 3（已掌握），
 * 掌握度就永遠是 0。間隔重複的重點就是複習，所以到期題要排在前面。
 * 但也不能讓複習債塞滿整輪，保留 (1 - DUE_QUOTA) 給新題。
 */
function orderPool(pool, scope, pmap, limit) {
  if (scope === 'order') return pool;
  if (scope === 'random') return shuffle(pool);
  const now = Date.now();
  const fresh = [], dueList = [], rest = [];
  for (const it of pool) {
    const r = pmap.get(it.id);
    if (!r) fresh.push(it);
    else if (r.due <= now) dueList.push(it);
    else rest.push(it);
  }
  const due = shuffle(dueList);
  const quota = Math.max(1, Math.ceil((limit || pool.length) * DUE_QUOTA));
  return [...due.slice(0, quota), ...shuffle(fresh), ...due.slice(quota), ...shuffle(rest)];
}

/**
 * 為四選一測驗產生誘答選項。
 * @param {string} [field]  用來去重的欄位（避免選項意思重複）。預設 'meaning'。
 *   travel-kanji 用 'jpMeaning' 或 'kanji'；travel-phrases/usage 用 'zh' 或 'jp'。
 */
export async function buildDistractors(item, type, level, n = 3, field) {
  let pool = [];
  try {
    if (item.type === 'travel') {
      pool = item.cat === 'kanji'
        ? await loadTravel('kanji')
        : await loadTravelAll(['phrases', 'usage']);
    } else if (level && level !== 'ALL') {
      pool = await loadSet(type, level);
    } else {
      pool = await loadMany(type, LEVELS);
    }
  } catch { pool = []; }
  if (pool.length < n + 1 && item.type !== 'travel') {
    pool = pool.concat(await loadMany(type, LEVELS));
  }
  const key = field || 'meaning';
  const seen = new Set([item[key]]);
  const out = [];
  // 干擾選項優先挑同詞性的：選了「動詞」還混進名詞的話，看詞性就能刪掉選項，題目會失去鑑別度。
  // 同詞性不夠 n 個才往外補（第二輪）。沒有 pos 的項目（文法、旅行）兩輪都在後面那一批。
  const samePos = item.pos ? shuffle(pool.filter((c) => c.pos === item.pos)) : [];
  const rest = shuffle(item.pos ? pool.filter((c) => c.pos !== item.pos) : pool);
  for (const cand of [...samePos, ...rest]) {
    if (cand.id === item.id) continue;
    const val = cand[key];
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(cand);
    if (out.length >= n) break;
  }
  return out;
}
