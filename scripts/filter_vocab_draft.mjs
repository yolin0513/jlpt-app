/* 單字草稿過濾器（題庫增補用的開發工具，App 本身不需要）
 *
 * 用法：node scripts/filter_vocab_draft.mjs [--allow-empty] <草稿1.txt> [草稿2.txt ...]
 *   空檔或全部被剔除都回 1；這一輪真的沒有新草稿、或全部剔除也沒關係時，加 --allow-empty 明講。
 *   草稿格式同 data/src/vocab.*.txt：漢字 | 假名 | 中文釋義 | 詞性 | 例句 | 例句假名 | 例句中譯
 *   每份草稿輸出一份 <草稿>.ok.txt（只留通過的行）；人工抽查後，再手動附加到 data/src/ 對應檔的**檔尾**。
 *
 * 為什麼要有這支：
 * - 草稿要同時跟「五級全部既有詞」與「同一輪的其他草稿」比對（key = 漢字｜假名）。
 *   v1.7.2 曾把 N2、N1 草稿分兩次過濾，兩批互相看不到，結果「慌ただしい」同時進了兩級。
 *   → 同一輪的所有草稿一定要在同一次指令裡傳進來。
 * - 生成的草稿常混入西里爾字母、韓文、英文雜訊，而且連欄位內都有，只檢查欄位數擋不住。
 * 注意：例句自然含拉丁字母（CD、SNS）也會被擋下，人工確認沒問題就手動加回。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = ['n5', 'n4', 'n3', 'n2', 'n1'];

const existing = new Map(); // 漢字｜假名 → 級別
for (const lv of LEVELS) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vocab', `${lv}.json`), 'utf8'));
  for (const it of j.items) existing.set(`${it.kanji || ''}｜${it.kana || ''}`, lv.toUpperCase());
}

// 波浪號有兩個長得一樣的字：題庫用 ～(U+FF5E)，但也容忍 〜(U+301C)
const KANA = /^[\u3040-\u309F\u30A0-\u30FF\u30FC\u301C\uFF5E々・、。！？（）○\s]*$/;
const HAN = /[\u4E00-\u9FFF]/;
const LAT = /[A-Za-z]/;
const BAD = /[\u0400-\u04FF\uAC00-\uD7A3]/; // 西里爾字母、韓文

// --allow-empty：明確表示「這一輪真的沒有新草稿／全部剔除也沒關係」。沒帶的話，空檔或全被剔除都回 1
// （2026-09-24 J11：以前空檔回 0、印「草稿共 0 行」，取到空的被當成沒問題）。
const ALLOW_EMPTY = process.argv.includes('--allow-empty');
const files = process.argv.slice(2).filter((a) => a !== '--allow-empty');
if (!files.length) {
  console.error('用法：node scripts/filter_vocab_draft.mjs [--allow-empty] <草稿.txt> [...]（同一輪的草稿請一次全部傳入）');
  process.exit(1);
}
const emptyFiles = [];

function problem(c, line) {
  if (c.length !== 7) return `欄位數 ${c.length}（應為 7）`;
  const [k, kn, m, pos, ex, exk, exm] = c;
  if (!k || !kn || !m || !pos || !ex || !exk || !exm) return '有空欄位';
  if (BAD.test(line)) return '含西里爾字母或韓文（生成雜訊）';
  if (!KANA.test(kn)) return `假名欄不是純假名：${kn}`;
  if (HAN.test(exk)) return `例句假名殘留漢字：${exk}`;
  if (LAT.test(exk) || LAT.test(ex)) return `含拉丁字母（若是 CD／SNS 這類自然用法請人工確認）：${ex}`;
  return null;
}

const seen = new Map(); // 本輪草稿之間也要互相比對
let total = 0;
let kept = 0;
for (const f of files) {
  const out = [];
  let rowsInFile = 0;
  for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    total++;
    rowsInFile++;
    const c = line.split('|').map((s) => s.trim());
    const why = problem(c, line);
    if (why) { console.log(`  x ${c[0] || line.slice(0, 20)} → ${why}`); continue; }
    const key = `${c[0]}｜${c[1]}`;
    if (existing.has(key)) { console.log(`  x ${key} → 已收錄於 ${existing.get(key)}`); continue; }
    if (seen.has(key)) { console.log(`  x ${key} → 本輪草稿重複（${seen.get(key)}）`); continue; }
    seen.set(key, path.basename(f));
    out.push(line);
    kept++;
  }
  const dst = f.replace(/\.txt$/, '') + '.ok.txt';
  if (!rowsInFile) emptyFiles.push(path.basename(f));
  fs.writeFileSync(dst, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
  console.log(`${path.basename(f)} → ${path.basename(dst)}：保留 ${out.length} 行`);
}
console.log(`\n草稿共 ${total} 行，保留 ${kept}，剔除 ${total - kept}`);
if (!ALLOW_EMPTY) {
  const why = [];
  if (emptyFiles.length) why.push(`${emptyFiles.length} 份草稿沒有任何資料列（${emptyFiles.join('、')}）`);
  if (total > 0 && kept === 0) why.push(`全部 ${total} 行都被剔除`);
  if (why.length) {
    console.error(`停：${why.join('；')}。取到空的不當成沒問題；若這一輪真的沒有新草稿，請加 --allow-empty 明講。`);
    process.exit(1);
  }
}
