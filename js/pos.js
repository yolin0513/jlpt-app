/* 詞性篩選：題庫 `pos` 欄的值 → 學習頁上的分類。
 * 畫面上用學日文的人實際在用的叫法（い形容詞／な形容詞），資料裡是「形容詞／形容動詞」。
 * 注意：這裡只做「挑哪些字來練」。**沒有**活用（て形、ない形…）的資料，
 * 全庫也還沒有動詞的一類／二類／三類，所以不要在這裡替「詞性變化」預留任何欄位。 */

/* 題庫裡形容詞的 pos 實際寫成「形容詞（い形）」「形容動詞（な形）」（不是光禿禿的「形容詞」），
 * 所以這兩類用前綴比對；其餘是完全相符。改這裡之前先用 data/vocab/*.json 確認實際字串。 */
const isVerb = (p) => p === '動詞';
const isIAdj = (p) => typeof p === 'string' && p.startsWith('形容詞');
const isNaAdj = (p) => typeof p === 'string' && p.startsWith('形容動詞');
// 「名詞・副詞」那一筆兩邊都算得上，選名詞或副詞時都要出現
const isNoun = (p) => p === '名詞' || p === '名詞・副詞';
const isAdv = (p) => p === '副詞' || p === '名詞・副詞';
const isOther = (p) => !(isVerb(p) || isIAdj(p) || isNaAdj(p) || isNoun(p) || isAdv(p));

/** 選項順序就是學習頁上那一排的順序 */
export const POS_OPTIONS = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'verb', label: '動詞', match: isVerb },
  { key: 'i-adj', label: 'い形容詞', match: isIAdj },
  { key: 'na-adj', label: 'な形容詞', match: isNaAdj },
  { key: 'noun', label: '名詞', match: isNoun },
  { key: 'adv', label: '副詞', match: isAdv },
  { key: 'other', label: '其他', match: isOther }
];

export const DEFAULT_POS = 'all';

export function isPosKey(key) {
  return POS_OPTIONS.some((o) => o.key === key);
}

/**
 * 回傳給 buildSession 用的 filter；'all'、空值、不認得的 key 都回 null（不篩）。
 * 只有單字有 pos，文法與旅行沒有 → 那些項目一律留著，由呼叫端決定要不要套用。
 */
export function posFilter(key) {
  const opt = POS_OPTIONS.find((o) => o.key === key);
  if (!opt || opt.key === 'all') return null;
  return (item) => (item.pos == null ? true : opt.match(item.pos));
}

/**
 * 這個詞性在目前這一級還有沒有字：沒有就退回「全部」，不要讓使用者卡在空池。
 * （目前五級的六類都不是 0，所以這是防未來題庫變動的保險，不是現在會踩到的路徑。）
 */
export function resolvePos(key, counts) {
  if (!isPosKey(key) || key === DEFAULT_POS) return DEFAULT_POS;
  return counts && counts[key] > 0 ? key : DEFAULT_POS;
}

/** 每個選項在這批單字裡有幾個（數字一律從題庫實際算，不寫死） */
export function countByPos(list) {
  const out = {};
  for (const o of POS_OPTIONS) out[o.key] = 0;
  for (const it of list) {
    out.all += 1;
    for (const o of POS_OPTIONS) {
      if (o.key !== 'all' && o.match(it.pos)) out[o.key] += 1;
    }
  }
  return out;
}
