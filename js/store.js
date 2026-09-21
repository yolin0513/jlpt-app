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

/* ---------- 備份提醒 ---------- */
const DAY_MS = 86400000;
/** 距上次匯出超過這麼多天才提醒（統籌者 2026-09-21 的建議值，Yolin 可改） */
export const BACKUP_REMIND_DAYS = 14;
/** 從沒匯出過的人，要先學過這麼多天才提醒：剛裝好、還沒東西可丟的人不打擾 */
export const BACKUP_MIN_STUDY_DAYS = 3;
/** 「這週先不要」延後的天數（只有延後，沒有永久關閉：資料丟了救不回來） */
export const BACKUP_SNOOZE_DAYS = 7;

/** 匯出成功之後才呼叫：記下這次匯出的時間，並清掉「這週先不要」。 */
export async function markExported(exportedAt = new Date().toISOString()) {
  await setSetting('lastExportAt', exportedAt);
  await idb.del('meta', 'backupSnoozeUntil');
}

export async function snoozeBackupReminder(now = Date.now()) {
  return setSetting('backupSnoozeUntil', new Date(now + BACKUP_SNOOZE_DAYS * DAY_MS).toISOString());
}

/**
 * 首頁那張備份提醒卡要不要出現，以及卡上要寫的數字。純讀取，不寫任何東西。
 * 兩個條件都成立才提醒：(1) 太久沒匯出；(2) 上次匯出之後真的有新的作答紀錄
 * ——沒有新進度就沒有東西會丟。從沒匯出過的人改看「學習過幾天」。
 */
export async function backupReminder(now = Date.now()) {
  const [lastExportAt, snoozeUntil, daily] = await Promise.all([
    getSetting('lastExportAt', null),
    getSetting('backupSnoozeUntil', null),
    allDaily()
  ]);
  const studyDays = daily.filter((d) => d.studied > 0 || d.cards > 0).length;
  const out = {
    show: false, never: !lastExportAt, lastExportAt,
    days: null, studyDaysSince: 0, studyDays,
    snoozed: !!snoozeUntil && Date.parse(snoozeUntil) > now
  };
  if (out.snoozed) return out;
  if (!lastExportAt) {
    out.studyDaysSince = studyDays;
    out.show = studyDays >= BACKUP_MIN_STUDY_DAYS;
    return out;
  }
  const t = Date.parse(lastExportAt);
  if (!Number.isFinite(t)) return out;   // 壞掉的值當成沒匯出過，但不提醒，免得每次都跳
  out.days = Math.floor((now - t) / DAY_MS);
  const lastKey = todayKey(new Date(t));
  out.studyDaysSince = daily.filter((d) => d.date > lastKey && d.studied > 0).length;
  out.show = out.days > BACKUP_REMIND_DAYS && out.studyDaysSince > 0;
  return out;
}

/* ---------- 匯出 / 匯入 / 重置 ---------- */
export const EXPORT_VERSION = 3;

/** 備份檔格式版本說明：
 *  v1 無 favorites；v2 有 favorites；
 *  v3 起多記 idScheme（題庫 id 方案）與 dataVersion（題庫內容雜湊），
 *     未來若真要重編 id，可據此判斷這份備份是否需要轉換。 */
export async function exportAll(meta = {}) {
  const [progress, mistakes, daily, metaRows, favorites] = await Promise.all([
    idb.getAll('progress'), idb.getAll('mistakes'), idb.getAll('daily'),
    idb.getAll('meta'), idb.getAll('favorites')
  ]);
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    idScheme: 'positional-v1',      // id = 來源檔行序（n5-v-0001…）
    dataVersion: meta.dataVersion || null,
    counts: {
      progress: progress.length, mistakes: mistakes.length,
      daily: daily.length, favorites: favorites.length
    },
    progress, mistakes, daily, meta: metaRows, favorites
  };
}

const STORES = ['progress', 'mistakes', 'daily', 'meta', 'favorites'];

/** 檢查備份檔並回傳摘要，不寫入任何資料。給匯入前的確認對話框用。 */
export function inspectBackup(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('不是有效的 JSON 物件');
  const v = obj.version;
  if (!(v === 1 || v === 2 || v === 3)) throw new Error(`不支援的備份版本：${v}`);
  for (const s of STORES) {
    if (obj[s] != null && !Array.isArray(obj[s])) throw new Error(`欄位 ${s} 格式錯誤（應為陣列）`);
  }
  if (obj.idScheme && obj.idScheme !== 'positional-v1') {
    throw new Error(`備份使用不同的 id 方案（${obj.idScheme}），無法直接匯入`);
  }
  return {
    version: v,
    exportedAt: obj.exportedAt || null,
    dataVersion: obj.dataVersion || null,
    progress: (obj.progress || []).length,
    mistakes: (obj.mistakes || []).length,
    daily: (obj.daily || []).length,
    favorites: (obj.favorites || []).length
  };
}

/**
 * 匯入備份。
 * @param {object} obj
 * @param {'replace'|'merge'} mode  預設 replace：還原成備份當下的狀態
 *   （merge 會保留現有資料、同 id 以備份覆蓋，兩份進度會混在一起）
 */
export async function importAll(obj, mode = 'replace') {
  inspectBackup(obj); // 格式不對就在動資料之前先擋下來
  if (mode === 'replace') {
    // 設定（meta）只在備份有帶時才覆蓋，避免把主題/目標一起清掉
    await Promise.all(['progress', 'mistakes', 'daily', 'favorites'].map((s) => idb.clear(s)));
    if (Array.isArray(obj.meta) && obj.meta.length) await idb.clear('meta');
  }
  for (const s of STORES) {
    if (Array.isArray(obj[s]) && obj[s].length) await idb.bulkPut(s, obj[s]);
  }
  // 匯入是「取代」，資料此刻就跟這份備份一樣安全 → 上次匯出時間＝這份備份的產生時間。
  // 備份裡帶的 meta 也會蓋進來（含它自己那一次的 lastExportAt），所以要在 bulkPut 之後才寫。
  // 舊備份沒有 exportedAt → 當成「沒匯出過」，照提醒規則重新算。
  if (obj.exportedAt) await setSetting('lastExportAt', obj.exportedAt);
  else await idb.del('meta', 'lastExportAt');
  await idb.del('meta', 'backupSnoozeUntil');
}

export async function resetAll() {
  await Promise.all(['progress', 'mistakes', 'daily', 'favorites'].map((s) => idb.clear(s)));
  // 引導是「新手狀態」不是偏好設定 → 一併重置，讓重置後的 App 真的像第一次打開
  await idb.del('meta', 'seenGuide');
}

export { isLearned };
