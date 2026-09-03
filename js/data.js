/* 題庫載入 — 讀取 data/manifest.json，再依需求載入各級別檔案 */
const BASE = new URL('../data/', import.meta.url);

let _manifest = null;
const _cache = new Map(); // key: `${type}:${level}` -> items[]

/** fetch，失敗時重試（處理 Windows 上偶發的 ERR_NO_BUFFER_SPACE 等暫時性錯誤） */
async function fetchRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { cache: 'default' });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  throw lastErr;
}

export const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
export const TYPES = [
  { key: 'vocab', label: '單字' },
  { key: 'grammar', label: '文法' }
];

/* 生活旅行分類（與 JLPT 平行，不掛在級別底下） */
export const TRAVEL_CATS = [
  { key: 'phrases', label: '情境會話', icon: '💬', desc: '機場、交通、住宿、餐飲、購物、問路、緊急狀況的實用單字與句子' },
  { key: 'usage', label: '日本人這樣說', icon: '🗣️', desc: '課本 vs 現實日文、敬語場合、店員固定句與你該怎麼回' },
  { key: 'kanji', label: '中日漢字大不同', icon: '🀄', desc: '同一漢字在中日文意思落差大的詞，逐條對照台灣人常見誤解' }
];
export const TRAVEL_CAT_LABEL = Object.fromEntries(TRAVEL_CATS.map((c) => [c.key, c.label]));

export async function getManifest() {
  if (_manifest) return _manifest;
  const res = await fetchRetry(new URL('manifest.json', BASE));
  _manifest = await res.json();
  return _manifest;
}

/** 回傳某級別某類型的題目陣列（已正規化欄位） */
export async function loadSet(type, level) {
  const cacheKey = `${type}:${level}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  const man = await getManifest();
  const entry = man.sets.find((s) => s.type === type && s.level === level);
  if (!entry) {
    _cache.set(cacheKey, []);
    return [];
  }
  const res = await fetchRetry(new URL(entry.file, BASE));
  const raw = await res.json();
  const items = (raw.items || []).map((it) => normalize(it, type, level));
  _cache.set(cacheKey, items);
  return items;
}

/** 併發上限的 map（同時最多 limit 個，避免壓垮本機 dev server） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 一次載入多個級別（複習 / 混合模式 / 搜尋用）。
 *  會濾掉標記 dup 的跨級別重複條目（較低級別已收錄同一個詞），
 *  避免同一詞在混合出題／誘答／搜尋結果裡重複出現。
 *  單級別的 loadSet 不濾 → findItem() 仍解析得到，既有進度不受影響。 */
export async function loadMany(type, levels) {
  const groups = await mapLimit(levels, 3, (lv) => loadSet(type, lv));
  return groups.flat().filter((it) => !it.dup);
}

/* ---------- 生活旅行 ---------- */
export async function getTravelManifest() {
  const man = await getManifest();
  return man.travel || { total: 0, sets: [] };
}

/** 載入某個生活旅行分類（cat: phrases | usage | kanji） */
export async function loadTravel(cat) {
  const cacheKey = `travel:${cat}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);
  const tm = await getTravelManifest();
  const entry = tm.sets.find((s) => s.cat === cat);
  if (!entry) { _cache.set(cacheKey, []); return []; }
  const res = await fetchRetry(new URL(entry.file, BASE));
  const raw = await res.json();
  const items = (raw.items || []).map((it) => normalizeTravel(it));
  _cache.set(cacheKey, items);
  return items;
}

/** 載入全部生活旅行分類（可指定子集） */
export async function loadTravelAll(cats) {
  const tm = await getTravelManifest();
  const keys = cats && cats.length ? cats : tm.sets.map((s) => s.cat);
  const groups = await mapLimit(keys, 3, (c) => loadTravel(c));
  return groups.flat();
}

/** 依 id 反查（跨全部已載入 + 需要時載入對應檔） */
export async function findItem(itemId) {
  // 已載入的快取先找
  for (const [k, list] of _cache) {
    const hit = list.find((x) => x.id === itemId);
    if (hit) {
      const [a, b] = k.split(':');
      return { item: hit, type: hit.type || a, level: hit.level || b };
    }
  }
  // JLPT： n5-v-0007 / n3-g-0012
  const j = /^([nN][1-5])-([vg])-/.exec(itemId);
  if (j) {
    const level = j[1].toUpperCase();
    const type = j[2] === 'v' ? 'vocab' : 'grammar';
    const list = await loadSet(type, level);
    const hit = list.find((x) => x.id === itemId);
    if (hit) return { item: hit, type, level };
  }
  // 生活旅行： tv-p-0001 / tv-u-0001 / tv-k-0001
  const t = /^tv-([puk])-/.exec(itemId);
  if (t) {
    const cat = { p: 'phrases', u: 'usage', k: 'kanji' }[t[1]];
    const list = await loadTravel(cat);
    const hit = list.find((x) => x.id === itemId);
    if (hit) return { item: hit, type: 'travel', level: 'TRAVEL' };
  }
  return null;
}

function normalize(it, type, level) {
  if (type === 'vocab') {
    return {
      id: it.id,
      level,
      type,
      kanji: it.kanji || it.word || it.kana || '',
      kana: it.kana || '',
      romaji: it.romaji || '',
      pos: it.pos || '',
      meaning: it.meaning || '',
      example: it.example || '',
      exampleKana: it.exampleKana || it.example_kana || '',
      exampleMeaning: it.exampleMeaning || it.example_meaning || '',
      dup: !!it.dup
    };
  }
  return {
    id: it.id,
    level,
    type,
    pattern: it.pattern || it.title || '',
    reading: it.reading || '',
    meaning: it.meaning || '',
    explanation: it.explanation || '',
    structure: it.structure || '',
    example: it.example || '',
    exampleKana: it.exampleKana || it.example_kana || '',
    exampleMeaning: it.exampleMeaning || it.example_meaning || '',
    dup: !!it.dup
  };
}

function normalizeTravel(it) {
  const base = { id: it.id, track: 'travel', type: 'travel', level: 'TRAVEL', cat: it.cat };
  if (it.cat === 'kanji') {
    return {
      ...base,
      kanji: it.kanji || '',
      reading: it.reading || '',
      jpMeaning: it.jpMeaning || '',
      zhMisread: it.zhMisread || '',
      example: it.example || '',
      exampleKana: it.exampleKana || '',
      exampleMeaning: it.exampleMeaning || ''
    };
  }
  return {
    ...base,
    scene: it.scene || '',
    jp: it.jp || '',
    kana: it.kana || '',
    zh: it.zh || '',
    note: it.note || ''
  };
}

/* 顯示用：單字正面主體 / 讀音 / 釋義 */
export function faceOf(item) {
  if (item.type === 'vocab') {
    const showKana = item.kanji && item.kana && item.kanji !== item.kana;
    return {
      main: item.kanji || item.kana,
      reading: showKana ? item.kana : '',
      meaning: item.meaning,
      pos: item.pos
    };
  }
  return {
    main: item.pattern,
    reading: item.reading,
    meaning: item.meaning,
    pos: ''
  };
}
