/* 依設定組出一輪練習題目 */
import { loadSet, loadMany, findItem, LEVELS, loadTravel, loadTravelAll } from './data.js';
import { progressMap } from './store.js';
import { idb } from './db.js';
import { shuffle } from './ui.js';
import { openMistakes, allFavorites } from './store.js';

const DEFAULT_LIMIT = 20;

/**
 * @param {object} o
 * @param {'vocab'|'grammar'} o.type
 * @param {string} o.level  'N5'..'N1' 或 'ALL'
 * @param {'smart'|'random'|'order'} o.scope
 * @param {'set'|'review'|'mistakes'|'mix'} o.src
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
  let pool;
  if (o.level === 'ALL' || o.src === 'mix') {
    pool = await loadMany(o.type, LEVELS);
  } else {
    pool = await loadSet(o.type, o.level);
  }
  pool = pool.slice();

  const ordered = orderPool(pool, o.scope, pmap);

  return {
    items: ordered.slice(0, limit),
    type: o.type,
    meta: { src: 'set', poolSize: pool.length }
  };
}

/** 依 scope 排序題目池 */
function orderPool(pool, scope, pmap) {
  if (scope === 'order') return pool;
  if (scope === 'random') return shuffle(pool);
  // smart：未學過 → 已到期 → 其他（各組內隨機）
  const now = Date.now();
  const fresh = [], dueList = [], rest = [];
  for (const it of pool) {
    const r = pmap.get(it.id);
    if (!r) fresh.push(it);
    else if (r.due <= now) dueList.push(it);
    else rest.push(it);
  }
  return [...shuffle(fresh), ...shuffle(dueList), ...shuffle(rest)];
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
  for (const cand of shuffle(pool)) {
    if (cand.id === item.id) continue;
    const val = cand[key];
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(cand);
    if (out.length >= n) break;
  }
  return out;
}
