/* 備份：下載 JSON、記錄上次匯出時間、向瀏覽器要求持久儲存。
 * 統計頁的按鈕與首頁提醒卡的按鈕都走這裡，不要另外再寫一份匯出。 */
import { exportAll, todayKey, markExported } from './store.js';
import { getManifest } from './data.js';

/**
 * 產生並下載一份備份。成功才記 lastExportAt（失敗不記，否則提醒會被錯誤地消掉）。
 * 寫入時機在 exportAll() 取完資料之後 → 備份檔裡帶的是「上一次」的值，不會自己記到自己。
 * @returns {Promise<object>} 這次匯出的內容
 */
export async function downloadBackup() {
  const man = await getManifest().catch(() => ({}));
  const data = await exportAll({ dataVersion: man.dataVersion });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `jlpt-progress-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  await markExported(data.exportedAt);
  await requestPersistence();   // 只在使用者按下匯出時要求，見下方註解
  return data;
}

/**
 * 請瀏覽器不要在空間不足時自動清掉本站資料。
 * 只在使用者按匯出時呼叫：有的瀏覽器會跳權限詢問，一開 App 就被問會嚇到人。
 * 不支援就安靜略過，永遠不丟錯（不能讓匯出因為這個失敗）。
 */
export async function requestPersistence() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      return await navigator.storage.persist();
    }
  } catch { /* 不支援或被拒絕都不影響匯出 */ }
  return null;
}

/** 目前是否已取得持久儲存：true／false／null（不支援或問不到）。 */
export async function persistedState() {
  try {
    if (navigator.storage && typeof navigator.storage.persisted === 'function') {
      return await navigator.storage.persisted();
    }
  } catch { /* 同上 */ }
  return null;
}
