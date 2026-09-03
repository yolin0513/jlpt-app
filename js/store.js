/* 高階資料存取層：包裝 idb，處理進度 / 錯題 / 每日統計 */
import { idb } from './db.js';
import { schedule, isLearned, LEARNED_BOX } from './srs.js';

export function todayKey(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/* ---------- 進度 ---------- */
export async function getProgress(itemId) {
  return idb.get('progress', itemId);
}
export async function allProgress() {
  return idb.getAll('progress');
}
export async function progressMap() {
  const list = await allProgress();
  const m = new Map();
  for (const r of list) m.set(r.itemId, r);
  return m;
}

/* ---------- 記錄一次作答 ---------- */
export async function recordAnswer({ item, level, type, grade }) {
  const prev = await getProgress(item.id);
  const rec = schedule(prev, grade, { itemId: item.id, level, type });
  await idb.put('progress', rec);

  // 錯題本
  if (grade === 'again') {
    const m = (await idb.get('mistakes', item.id)) || {
      itemId: item.id, level, type, count: 0, resolved: false
    };
    m.count += 1;
    m.lastWrong = Date.now();
    m.resolved = false;
    m.level = level;
    m.type = type;
    await idb.put('mistakes', m);
  } else {
    const m = await idb.get('mistakes', item.id);
    if (m && !m.resolved && rec.box >= LEARNED_BOX) {
      m.resolved = true;
      await idb.put('mistakes', m);
    }
  }

  // 每日統計
  await bumpDaily(grade);
  return rec;
}

async function bumpDaily(grade) {
  const key = todayKey();
  const d = (await idb.get('daily', key)) || { date: key, studied: 0, correct: 0, wrong: 0, cards: 0 };
  d.studied += 1;
  if (grade === 'again') d.wrong += 1;
  else d.correct += 1;
  await idb.put('daily', d);
}

/** 閃卡翻卡也算學習量（不影響正確率），grade 為 'view' */
export async function bumpCardViewed() {
  const key = todayKey();
  const d = (await idb.get('daily', key)) || { date: key, studied: 0, correct: 0, wrong: 0, cards: 0 };
  d.cards += 1;
  await idb.put('daily', d);
}

/* ---------- 錯題 ---------- */
export async function allMistakes() {
  return idb.getAll('mistakes');
}
export async function openMistakes() {
  return (await allMistakes()).filter((m) => !m.resolved);
}
export async function removeMistake(itemId) {
  return idb.del('mistakes', itemId);
}
export async function clearResolvedMistakes() {
  const all = await allMistakes();
  await Promise.all(all.filter((m) => m.resolved).map((m) => idb.del('mistakes', m.itemId)));
}

/* ---------- 每日 / 統計 ---------- */
export async function allDaily() {
  return (await idb.getAll('daily')).sort((a, b) => (a.date < b.date ? -1 : 1));
}
export async function dailyFor(key = todayKey()) {
  return (await idb.get('daily', key)) || { date: key, studied: 0, correct: 0, wrong: 0, cards: 0 };
}

export async function streak() {
  const days = new Set((await allDaily()).filter((d) => d.studied > 0 || d.cards > 0).map((d) => d.date));
  let s = 0;
  const cur = new Date();
  // 若今天尚未學習，仍容許從昨天起算
  if (!days.has(todayKey(cur))) cur.setDate(cur.getDate() - 1);
  while (days.has(todayKey(cur))) {
    s += 1;
    cur.setDate(cur.getDate() - 1);
  }
  return s;
}

/* ---------- 我的最愛 / 重點複習 ---------- */
export async function allFavorites() {
  return (await idb.getAll('favorites')).sort((a, b) => (b.added || 0) - (a.added || 0));
}
export async function isFavorite(itemId) {
  return !!(await idb.get('favorites', itemId));
}
export async function favoriteIdSet() {
  return new Set((await idb.getAll('favorites')).map((f) => f.itemId));
}
export async function addFavorite(item) {
  await idb.put('favorites', {
    itemId: item.id, level: item.level, type: item.type, added: Date.now()
  });
}
export async function removeFavorite(itemId) {
  return idb.del('favorites', itemId);
}
/** 切換，回傳切換後是否為最愛 */
export async function toggleFavorite(item) {
  if (await isFavorite(item.id)) {
    await removeFavorite(item.id);
    return false;
  }
  await addFavorite(item);
  return true;
}

/* ---------- 設定 ---------- */
export async function getSetting(k, dflt = null) {
  const row = await idb.get('meta', k);
  return row ? row.v : dflt;
}
export async function setSetting(k, v) {
  return idb.put('meta', { k, v });
}

export const DEFAULT_DAILY_GOAL = 20;
export async function getDailyGoal() {
  const v = await getSetting('dailyGoal', DEFAULT_DAILY_GOAL);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DAILY_GOAL;
}
export async function setDailyGoal(n) {
  return setSetting('dailyGoal', Math.max(5, Math.min(200, Math.round(n))));
}

/* ---------- 匯出 / 匯入 / 重置 ---------- */
export async function exportAll() {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    progress: await idb.getAll('progress'),
    mistakes: await idb.getAll('mistakes'),
    daily: await idb.getAll('daily'),
    meta: await idb.getAll('meta'),
    favorites: await idb.getAll('favorites')
  };
}
export async function importAll(obj) {
  // 接受 v1（無 favorites）與 v2；未知版本才拒絕
  if (!obj || !(obj.version === 1 || obj.version === 2)) throw new Error('格式不符');
  if (obj.progress) await idb.bulkPut('progress', obj.progress);
  if (obj.mistakes) await idb.bulkPut('mistakes', obj.mistakes);
  if (obj.daily) await idb.bulkPut('daily', obj.daily);
  if (obj.meta) await idb.bulkPut('meta', obj.meta);
  if (obj.favorites) await idb.bulkPut('favorites', obj.favorites);
}
export async function resetAll() {
  await Promise.all(['progress', 'mistakes', 'daily', 'favorites'].map((s) => idb.clear(s)));
}

export { isLearned };
