/* 弱點排序
 *
 * 和錯題本的差別：錯題本只回答「有沒有答錯過、修好了沒」，是二元的。
 * 弱點清單回答的是「哪些一直學不起來」——同樣答錯 1 次，
 * 練過 3 次錯 1 次和練過 12 次錯 1 次，困難度完全不同；
 * 而「錯很多次但最後終於升到已掌握」的項目，錯題本會標成已解決、整個消失，
 * 但它其實正是最該回頭複習的那種。
 */
import { LEARNED_BOX } from './srs.js';

/** 要有足夠的作答次數才談得上「弱」，否則一次手滑就排到第一名 */
export const MIN_REPS = 3;

/**
 * 弱點分數（越高越弱）。三個成分都是 0–1，權重寫在這裡方便調。
 *  - 錯誤率：最直接的訊號
 *  - 尚未掌握：練了這麼多次還沒升到 LEARNED_BOX，代表卡住
 *  - 絕對錯誤次數：錯 8 次比錯 2 次嚴重，但邊際遞減，取 10 次封頂
 */
export function weakScore(r) {
  const att = (r.correct || 0) + (r.wrong || 0);
  if (!att) return 0;
  const errRate = (r.wrong || 0) / att;
  const notLearned = (r.box ?? 0) < LEARNED_BOX ? 1 : 0;
  const volume = Math.min(r.wrong || 0, 10) / 10;
  return errRate * 0.55 + notLearned * 0.30 + volume * 0.15;
}

/**
 * @param {object[]} progress  allProgress() 的結果
 * @param {object}  [o]
 * @param {string}  [o.level]  'ALL' 或 'N5'..'N1' 或 'TRAVEL'
 * @param {string}  [o.type]   'vocab' | 'grammar' | 'travel'
 * @param {number}  [o.limit]
 * @param {Set}     [o.exclude] 要排除的 itemId（例如已隱藏的跨級別重複）
 */
export function rankWeak(progress, o = {}) {
  const { level = 'ALL', type = null, limit = 50, exclude = null } = o;
  return progress
    .filter((r) => {
      if (exclude && exclude.has(r.itemId)) return false;
      if ((r.reps || 0) < MIN_REPS) return false;
      if (!(r.wrong > 0)) return false;              // 全對的不算弱點
      if (level !== 'ALL' && r.level !== level) return false;
      if (type && r.type !== type) return false;
      return true;
    })
    .map((r) => ({ ...r, score: weakScore(r) }))
    .sort((a, b) => b.score - a.score || (b.wrong || 0) - (a.wrong || 0))
    .slice(0, limit);
}

export function accuracyOf(r) {
  const att = (r.correct || 0) + (r.wrong || 0);
  return att ? Math.round(((r.correct || 0) / att) * 100) : 0;
}
