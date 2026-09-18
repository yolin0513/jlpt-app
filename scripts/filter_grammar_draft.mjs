/* 文法草稿過濾器（題庫增補用的開發工具，App 本身不需要）
 *
 * 用法：node scripts/filter_grammar_draft.mjs <草稿1.txt> [草稿2.txt ...]
 *   草稿格式同 data/src/grammar.*.txt：句型 | 讀音 | 中文意思 | 接續結構 | 例句 | 例句假名 | 例句中譯
 *   每份草稿輸出一份 <草稿>.ok.txt；人工抽查後，再手動附加到 data/src/ 對應檔的**檔尾**。
 *
 * 規則與踩過的坑：
 * - 同一輪的所有草稿要一次傳入，才會互相比對（v1.7.2 分批過濾曾造成跨級重複）。
 * - 比對 key 保留全形括號：N5 本來就用「～で（場所）」「～で（手段）」區分同一個助詞的不同用法，
 *   剝掉括號會把合法條目誤判成重複。剝括號的版本只拿來發「疑似近似」警告（! 開頭），需人工判斷。
 * - 例句句尾允許 。？！；例句假名允許片假名（外來語不轉寫），但不得殘留漢字。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = ['n5', 'n4', 'n3', 'n2', 'n1'];

const HIRA = '\u3040-\u309F';
const KATA = '\u30A0-\u30FF';
const KANJI = '\u4E00-\u9FFF';

// 正規化：去掉 ～（兩種波浪號都算）與空白，依全形斜線拆成多個 key；**保留**全形括號
function keys(pattern) {
  const out = new Set();
  for (const part of String(pattern).split('\uFF0F')) {
    const k = part.replace(/[\uFF5E\u301C~]/g, '').replace(/\s+/g, '').trim();
    if (k) out.add(k);
  }
  return [...out];
}
const looseKeys = (p) => keys(p).map((k) => k.replace(/\uFF08[^\uFF09]*\uFF09/g, '')).filter(Boolean);

const existing = new Map(); // key → 「N2 ～xxx」
const loose = new Map();
for (const lv of LEVELS) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/grammar', `${lv}.json`), 'utf8'));
  for (const it of j.items) {
    for (const k of keys(it.pattern)) if (!existing.has(k)) existing.set(k, `${lv.toUpperCase()} ${it.pattern}`);
    for (const k of looseKeys(it.pattern)) if (!loose.has(k)) loose.set(k, `${lv.toUpperCase()} ${it.pattern}`);
  }
}

const BAD_CHAR = /[A-Za-z\u0400-\u04FF\uAC00-\uD7A3]/;
const KANA_ONLY = new RegExp(`^[${HIRA}${KATA}\u3001\u3002\u30FB\uFF1F\uFF01\uFF08\uFF09\uFF10-\uFF19 0-9]+$`);
const HAS_KANJI = new RegExp(`[${KANJI}]`);
const HAS_JP = new RegExp(`[${KANJI}${HIRA}${KATA}]`);

function problem(f) {
  if (f.length !== 7) return `欄位數 ${f.length}（應為 7）`;
  const [pat, yomi, mean, conn, ex, exk, exz] = f;
  if (!pat || !mean || !conn || !ex || !exk || !exz) return '有空欄位（讀音欄可空，其餘必填）';
  if (BAD_CHAR.test(pat + yomi + conn + ex + exk)) return '含英文、西里爾字母或韓文（生成雜訊）';
  if (HAS_KANJI.test(exk)) return `例句假名殘留漢字：${exk}`;
  if (!KANA_ONLY.test(exk)) return `例句假名含異常字元：${exk}`;
  if (!HAS_JP.test(ex)) return '例句不含日文';
  if (!HAS_KANJI.test(exz)) return '中譯不含中文';
  if (!/[\u3002\uFF1F\uFF01]$/.test(ex)) return '例句缺句末標點（。？！）';
  if (HAS_KANJI.test(yomi)) return `讀音欄殘留漢字：${yomi}`;
  return null;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法：node scripts/filter_grammar_draft.mjs <草稿.txt> [...]（同一輪的草稿請一次全部傳入）');
  process.exit(1);
}

const seen = new Map();
let total = 0;
let kept = 0;
for (const file of files) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    total++;
    const f = line.split('|').map((s) => s.trim());
    const why = problem(f);
    if (why) { console.log(`  x ${f[0] || line.slice(0, 20)} → ${why}`); continue; }
    const pat = f[0];
    let hit = null;
    for (const k of keys(pat)) {
      if (existing.has(k)) { hit = `已收錄：${existing.get(k)}`; break; }
      if (seen.has(k)) { hit = `本輪草稿重複：${seen.get(k)}`; break; }
    }
    if (hit) { console.log(`  x ${pat} → ${hit}`); continue; }
    for (const k of looseKeys(pat)) {
      if (loose.has(k)) console.log(`  ! ${pat} ～ 疑似近似 ${loose.get(k)}（只差括號，請人工確認）`);
    }
    for (const k of keys(pat)) seen.set(k, pat);
    for (const k of looseKeys(pat)) if (!loose.has(k)) loose.set(k, pat);
    out.push(line);
    kept++;
  }
  const dst = file.replace(/\.txt$/, '') + '.ok.txt';
  fs.writeFileSync(dst, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
  console.log(`${path.basename(file)} → ${path.basename(dst)}：保留 ${out.length} 行`);
}
console.log(`\n草稿共 ${total} 行，保留 ${kept}，剔除 ${total - kept}`);
