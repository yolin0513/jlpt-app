/* 間隔重複（SRS）— Leitner box 變體
 * box 0..6，對應下次複習間隔（分鐘）。box 0 表示很快會在同一 session 再出現。
 */
export const BOX_INTERVALS_MIN = [
  10,          // box 0：約 10 分鐘後（同場複習）
  60 * 24,     // box 1：1 天
  60 * 24 * 2, // box 2：2 天
  60 * 24 * 4, // box 3：4 天
  60 * 24 * 8, // box 4：8 天
  60 * 24 * 16,// box 5：16 天
  60 * 24 * 32 // box 6：32 天
];
export const LEARNED_BOX = 3; // box >= 3 視為「已掌握」

const MIN = 60 * 1000;

export function newRecord(itemId, level, type) {
  return {
    itemId, level, type,
    box: 0,
    due: Date.now(),
    reps: 0,
    lapses: 0,
    correct: 0,
    wrong: 0,
    updated: Date.now()
  };
}

/**
 * 依作答結果更新 SRS 紀錄。
 * @param {object} rec  progress 紀錄（可為 null）
 * @param {'good'|'hard'|'again'} grade  good=答對/認得, hard=勉強, again=答錯/不會
 */
export function schedule(rec, grade, meta = {}) {
  const r = rec
    ? { ...rec }
    : newRecord(meta.itemId, meta.level, meta.type);

  // 防呆：舊／匯入紀錄若缺欄位，補成數字
  const box0 = Number.isFinite(r.box) ? r.box : 0;
  r.reps = (Number(r.reps) || 0) + 1;
  r.lapses = Number(r.lapses) || 0;
  r.correct = Number(r.correct) || 0;
  r.wrong = Number(r.wrong) || 0;
  r.level = r.level || meta.level;
  r.type = r.type || meta.type;

  const MAX_BOX = BOX_INTERVALS_MIN.length - 1;
  if (grade === 'again') {
    r.box = 0;
    r.lapses += 1;
    r.wrong += 1;
  } else if (grade === 'hard') {
    r.box = Math.max(0, box0 - 1);
    r.correct += 1;
  } else {
    r.box = Math.min(MAX_BOX, box0 + 1);
    r.correct += 1;
  }
  r.due = Date.now() + BOX_INTERVALS_MIN[r.box] * MIN;
  r.updated = Date.now();
  return r;
}

export function isLearned(rec) {
  return !!rec && rec.box >= LEARNED_BOX;
}
