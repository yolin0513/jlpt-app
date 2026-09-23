/* 全面功能檢測回歸套件（168 項）
 * 用法：先跑 python scripts/serve.py，再 node scripts/audit.mjs [baseUrl]
 * 涵蓋 verify-full 沒測到的：資料層一致性、掌握度分母、路由健壯性、
 * 匯出匯入、孤兒紀錄、搜尋、收藏即時性、重置、SRS 邊界、聽力、特殊題型、模擬考、備份提醒、詞性篩選、拼寫練習。
 */
import puppeteer from 'puppeteer';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://localhost:5173/').replace(/\/?$/, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const issues = [];
const ok = (c, m, note) => {
  c ? pass++ : fail++;
  if (!c) issues.push(m + (note ? ` — ${note}` : ''));
  console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`);
};
// 安全網：任何一節沒接住的錯誤（例如線上某個 fetch 失敗）都記成一條 FAIL，照樣印出已跑的結果與總結再結束，
// 不要像 2026-09-21 那樣整支中斷、連前面通過了什麼都看不到
let browser = null;
process.on('uncaughtException', async (e) => {
  ok(false, '執行中斷（未接住的錯誤，後面的項目沒有跑）', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ｜ ') : e));
  console.log(`\n===== ${pass} passed, ${fail} failed（中途中斷）=====`);
  console.log('\n--- 需處理清單 ---');
  issues.forEach((i, n) => console.log(`${n + 1}. ${i}`));
  try { await browser?.close(); } catch { /* 已經在收尾，關不掉就算了 */ }
  process.exit(1);
});

const b = browser = await puppeteer.launch({ headless: true, userDataDir: path.join(tmpdir(), 'audit-' + Date.now()), args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
// 等到路由真的把畫面放進 #view 才回傳（線上冷快取時，網路閒置後畫面還要 1–2 秒才渲染完，2026-09-18 實測）。
// 路由只在畫面資料全部備妥後才一次放進 #view，所以「#view 有子元素」就等於渲染完成。
const go = async (h) => {
  await p.goto('about:blank');
  await p.goto(BASE + h, { waitUntil: 'networkidle2' });
  await p.waitForFunction(() => document.querySelector('#view')?.children.length > 0, { timeout: 15000 }).catch(() => {});
  await sleep(500);
};

await go('#/home');

/* ================= 1. 資料層一致性 ================= */
console.log('\n[1] 資料層一致性');
// 每一步都自己接住錯誤、回報是哪一步哪個檔：以前這裡一個 fetch 失敗就讓整支 audit 當場中斷，
// 連前面通過的項目與總結都不印（2026-09-21 對剛部署的線上版連續踩到兩次）。
const d1 = await p.evaluate(async () => {
  let where = 'import js/data.js';
  try {
    const d = await import('./js/data.js');
    where = 'getManifest（data/manifest.json）';
    const man = await d.getManifest();
    const out = { levels: {} };
    for (const lv of d.LEVELS) {
      for (const t of ['vocab', 'grammar']) {
        where = `loadSet('${t}', '${lv}')`;
        const set = man.sets.find((s) => s.type === t && s.level === lv);
        const list = await d.loadSet(t, lv);
        out.levels[`${lv}-${t}`] = {
          manCount: set.count, manActive: set.activeCount,
          loadSetLen: list.length, loadSetDup: list.filter((x) => x.dup).length
        };
      }
    }
    where = "loadMany('vocab', 全部級別)";
    const many = await d.loadMany('vocab', d.LEVELS);
    out.loadManyDup = many.filter((x) => x.dup).length;
    out.totalItems = man.totalItems; out.activeItems = man.activeItems;
    return out;
  } catch (e) {
    return { error: `${where} 失敗：${e && e.message ? e.message : e}` };
  }
}).catch((e) => ({ error: `page.evaluate 本身失敗：${e.message}` }));
ok(!d1.error, '[1 前置] 題庫資料全部載得到（manifest＋五級單字與文法）', d1.error);
if (!d1.error) {
let mismatch = [];
for (const [k, v] of Object.entries(d1.levels)) {
  if (v.loadSetLen !== v.manActive) mismatch.push(`${k}: loadSet ${v.loadSetLen} != activeCount ${v.manActive}`);
}
ok(mismatch.length === 0, `loadSet 長度 == manifest.activeCount`, mismatch.join('; '));
ok(d1.loadManyDup === 0, 'loadMany 已濾除跨級別重複');
const dupExposed = Object.entries(d1.levels).filter(([, v]) => v.loadSetDup > 0);
ok(dupExposed.length === 0, `單級別出題池不含已隱藏的重複詞`,
  dupExposed.map(([k, v]) => `${k} 仍含 ${v.loadSetDup} 筆`).join('; '));

// 題庫份量在各級之間不得失衡：任一級不足最多者的 70%，就是該級沒補齊
// （曾發生 N2/N1 文法只有 51/47 點，不到 N5 的 60%，但三套測試都測不出來）
for (const t of ['vocab', 'grammar']) {
  const counts = Object.entries(d1.levels)
    .filter(([k]) => k.endsWith('-' + t))
    .map(([k, v]) => [k.split('-')[0], v.manActive]);
  const max = Math.max(...counts.map(([, n]) => n));
  const thin = counts.filter(([, n]) => n < max * 0.7);
  ok(thin.length === 0,
    `${t} 五級份量均衡（最多 ${max}，最少 ${Math.min(...counts.map(([, n]) => n))}）`,
    thin.map(([lv, n]) => `${lv} 只有 ${n} 條，不到最多者 ${max} 的 70%`).join('; '));
}
}

/* ================= 2. 掌握度分母一致性 ================= */
console.log('\n[2] 掌握度分母一致性');
// 直接比對兩個畫面實際渲染出來的分母
await go('#/learn?type=vocab&level=N3');
const learnDen = await p.evaluate(() =>
  +(document.body.innerText.match(/題庫共\s*(\d+)\s*項/) || [])[1]);
const poolLen = await p.evaluate(async () => (await (await import('./js/data.js')).loadSet('vocab', 'N3')).length);
ok(learnDen === poolLen, `學習頁分母 == 實際可練題數 (${learnDen} / ${poolLen})`,
  '分母比實際能練到的題目少或多 → 掌握度會不到或超過 100%');

// 極端情境：把該級別全部練到掌握（含「舊版本練過、現已隱藏」的重複詞），掌握度不得超過 100%
await p.evaluate(async () => {
  const { idb } = await import('./js/db.js');
  for (const t of ['vocab', 'grammar']) {
    const raw = await fetch(`./data/${t}/n3.json`).then((r) => r.json()); // raw = 含 dup
    for (const it of raw.items) {
      await idb.put('progress', { itemId: it.id, level: 'N3', type: t, box: 6, due: Date.now() + 9e8, reps: 6, correct: 6, wrong: 0, updated: Date.now() });
    }
  }
});
await go('#/stats');
const n3Pct = await p.evaluate(() => {
  const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('.pill.n3'));
  return { txt: c?.innerText.replace(/\n/g, ' '), bar: c?.querySelector('.bar > i')?.style.width };
});
ok(n3Pct.bar === '100%' && /100%/.test(n3Pct.txt),
  `N3 全部練完 → 掌握度剛好 100% (${n3Pct.bar})`, n3Pct.txt);
await p.evaluate(async () => {
  const { idb } = await import('./js/db.js');
  for (const r of await idb.getAll('progress')) if (r.level === 'N3') await idb.del('progress', r.itemId);
});

/* ================= 3. 路由健壯性 ================= */
console.log('\n[3] 路由健壯性');
const routeErrBefore = errs.length;
await go('#/nonexistent-page');
const nf = await p.evaluate(() => document.querySelector('#view')?.innerText || '');
ok(/找不到頁面/.test(nf), '未知路由顯示 404 畫面');

await p.goto('about:blank');
await p.goto(BASE + '#/search?q=%', { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(900);
const badPct = await p.evaluate(() => ({
  html: (document.querySelector('#view')?.innerText || '').slice(0, 60),
  empty: !document.querySelector('#view')?.firstElementChild
}));
ok(!badPct.empty, '畸形百分號編碼的 hash 不會讓畫面空白', `#view 內容：「${badPct.html}」`);

await go('#/study?type=vocab&level=NOPE&mode=quiz&scope=order');
const badLevel = await p.evaluate(() => document.querySelector('#view')?.innerText.slice(0, 40) || '');
ok(badLevel.length > 0, '不存在的級別參數有優雅處理', `顯示：「${badLevel}」`);

await go('#/study?mode=quiz&src=travel&cat=NOPE&scope=order');
const badCat = await p.evaluate(() => document.querySelector('#view')?.innerText.slice(0, 40) || '');
ok(badCat.length > 0, '不存在的旅行分類有優雅處理', `顯示：「${badCat}」`);

/* ================= 4. 測驗流程細節 ================= */
console.log('\n[4] 測驗流程');
await go('#/study?type=vocab&level=N5&mode=quiz&scope=order');
const q1 = await p.evaluate(() => {
  const opts = [...document.querySelectorAll('.opt')].map((o) => o.innerText.replace(/^\d+\s*/, '').trim());
  return { n: opts.length, uniq: new Set(opts).size, opts };
});
ok(q1.n === 4 && q1.uniq === 4, `測驗選項 4 個且互不重複 (${q1.n}/${q1.uniq})`, q1.opts.join(' | '));

// 跑完整輪，檢查題號連續、無重複題目
const runRes = await p.evaluate(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const seenPrompts = [];
  const counts = [];
  for (let i = 0; i < 40; i++) {
    if (document.querySelector('.result-hero')) break;
    const c = document.querySelector('.study-count')?.textContent?.trim();
    const prompt = document.querySelector('.quiz-prompt')?.innerText?.trim();
    if (c) counts.push(c);
    if (prompt) seenPrompts.push(prompt);
    const o = document.querySelector('.opt:not([disabled])');
    if (o) { o.click(); await s(60); }
    const nx = document.querySelector('.quiz-next');
    if (nx) { nx.click(); await s(80); }
  }
  return { counts, seenPrompts, hasResult: !!document.querySelector('.result-hero'),
    score: document.querySelector('.result-score')?.textContent };
});
const nums = runRes.counts.map((c) => +c.split('/')[0]);
const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
ok(runRes.hasResult && consecutive, `測驗 20 題連續無跳題並顯示結果 (${runRes.score})`, runRes.counts.join(','));
ok(new Set(runRes.seenPrompts).size === runRes.seenPrompts.length, '同一輪測驗題目不重複',
  `${runRes.seenPrompts.length} 題出現 ${new Set(runRes.seenPrompts).size} 個不同題目`);

// 重做答錯的
const redo = await p.evaluate(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = [...document.querySelectorAll('button')].find((x) => /重做答錯的/.test(x.textContent));
  if (!btn) return { skipped: true };
  const want = +btn.textContent.match(/(\d+)/)[1];
  btn.click(); await s(400);
  const total = document.querySelector('.study-count')?.textContent?.split('/')[1]?.trim();
  return { want, total: +total };
});
ok(redo.skipped || redo.want === redo.total, `「重做答錯的 N 題」題數正確 (${redo.want} → ${redo.total})`);

/* ================= 5. 閃卡流程 ================= */
console.log('\n[5] 閃卡流程');
await go('#/study?type=grammar&level=N4&mode=flash&scope=order');
const fc = await p.evaluate(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const before = document.querySelector('.study-count')?.textContent;
  document.querySelector('.flashcard').click(); await s(500);
  const flipped = !!document.querySelector('.flashcard.flipped');
  const tools = !!document.querySelector('.card-tools .star-btn');
  // 連按兩次「認得」測重入
  const know = [...document.querySelectorAll('.grade-grid button')].find((x) => /認得/.test(x.textContent));
  know.click(); know.click(); await s(400);
  const after = document.querySelector('.study-count')?.textContent;
  return { before, after, flipped, tools };
});
ok(fc.flipped && fc.tools, '閃卡可翻面且顯示 ★/🔊');
ok(fc.before?.trim().startsWith('1') && fc.after?.trim().startsWith('2'),
  `連點兩次評分只前進一張 (${fc.before?.trim()} → ${fc.after?.trim()})`);

// 「再練不會的」
const again = await p.evaluate(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    if (document.querySelector('.result-hero')) break;
    const card = document.querySelector('.flashcard');
    if (card && !document.querySelector('.grade-grid')) { card.click(); await s(320); }
    const dont = [...document.querySelectorAll('.grade-grid button')].find((x) => /不會/.test(x.textContent));
    if (dont) { dont.click(); await s(160); }
  }
  const btn = [...document.querySelectorAll('button')].find((x) => /再練「不會」的/.test(x.textContent));
  if (!btn) return { skipped: true };
  const want = +btn.textContent.match(/(\d+)/)[1];
  btn.click(); await s(400);
  return { want, total: +document.querySelector('.study-count')?.textContent?.split('/')[1]?.trim() };
});
ok(again.skipped || again.want === again.total, `「再練不會的 N 張」張數正確 (${again.want} → ${again.total})`);

/* ================= 6. SRS 排程 ================= */
console.log('\n[6] SRS 排程');
const srs = await p.evaluate(async () => {
  const { schedule, BOX_INTERVALS_MIN, LEARNED_BOX } = await import('./js/srs.js');
  const out = {};
  let r = null;
  for (let i = 0; i < 10; i++) r = schedule(r, 'good', { itemId: 'x', level: 'N5', type: 'vocab' });
  out.capped = r.box === BOX_INTERVALS_MIN.length - 1;
  out.repsAfter10 = r.reps;
  const r2 = schedule(r, 'again');
  out.againResets = r2.box === 0 && r2.lapses === 1;
  const r3 = schedule({ itemId: 'y' }, 'hard', { level: 'N5', type: 'vocab' });
  out.hardNoNegative = r3.box === 0;
  const r4 = schedule({ itemId: 'z', box: 'bad', reps: null, correct: undefined }, 'good', { level: 'N5', type: 'vocab' });
  out.robust = Number.isFinite(r4.box) && Number.isFinite(r4.due) && r4.reps === 1;
  out.dueFuture = r4.due > Date.now();
  out.learnedBox = LEARNED_BOX;
  return out;
});
ok(srs.capped && srs.repsAfter10 === 10, `box 上限封頂、reps 累計正確 (reps=${srs.repsAfter10})`);
ok(srs.againResets, 'again 歸零 box 並記 lapse');
ok(srs.hardNoNegative, 'hard 從 box0 不會變負');
ok(srs.robust && srs.dueFuture, '缺欄位／髒資料的舊紀錄可安全排程');

/* ================= 7. 統計正確性 ================= */
console.log('\n[7] 統計正確性');
const st = await p.evaluate(async () => {
  const s = await import('./js/store.js');
  const prog = await s.allProgress();
  const daily = await s.allDaily();
  const today = daily.find((d) => d.date === s.todayKey()) || {};
  const sumCorrect = prog.reduce((a, r) => a + (r.correct || 0), 0);
  const sumWrong = prog.reduce((a, r) => a + (r.wrong || 0), 0);
  return { progN: prog.length, sumCorrect, sumWrong,
    dStudied: today.studied || 0, dCorrect: today.correct || 0, dWrong: today.wrong || 0, dCards: today.cards || 0 };
});
ok(st.dStudied === st.dCorrect + st.dWrong, `daily: studied(${st.dStudied}) == correct+wrong(${st.dCorrect}+${st.dWrong})`);
ok(st.sumCorrect + st.sumWrong === st.dStudied, `progress 作答加總(${st.sumCorrect + st.sumWrong}) == daily.studied(${st.dStudied})`);

await go('#/stats');
const statsDom = await p.evaluate(() => {
  const over = [...document.querySelectorAll('.bar > i')].map((i) => parseFloat(i.style.width)).filter((w) => w > 100);
  const cards = [...document.querySelectorAll('.stat-grid .big-num')].map((e) => e.textContent);
  const pcts = [...document.querySelectorAll('.card .small.muted')].map((e) => e.textContent).filter((t) => /%$/.test(t));
  return { overflow: over, cards, badPct: pcts.filter((t) => parseInt(t) > 100) };
});
ok(statsDom.overflow.length === 0, '進度條寬度不超過 100%', statsDom.overflow.join(','));
ok(statsDom.badPct.length === 0, '掌握度百分比不超過 100%', statsDom.badPct.join(','));

/* ================= 8. 匯出 / 匯入 ================= */
console.log('\n[8] 匯出 / 匯入');
const io = await p.evaluate(async () => {
  const s = await import('./js/store.js');
  const before = await s.exportAll();
  const n0 = before.progress.length;
  // 往返
  await s.importAll(JSON.parse(JSON.stringify(before)));
  const after = await s.exportAll();
  const out = { roundTrip: after.progress.length === n0, n0 };
  // 錯誤格式應拋出
  try { await s.importAll({ version: 99 }); out.rejectsBadVersion = false; }
  catch { out.rejectsBadVersion = true; }
  try { await s.importAll(null); out.rejectsNull = false; } catch { out.rejectsNull = true; }
  // 髒資料
  try { await s.importAll({ version: 2, progress: 'not-an-array' }); out.rejectsBadShape = false; }
  catch { out.rejectsBadShape = true; }
  const after2 = await s.exportAll();
  out.notCorrupted = after2.progress.length === n0;
  return out;
});
ok(io.roundTrip, `匯出→匯入往返資料筆數不變 (${io.n0})`);
ok(io.rejectsBadVersion && io.rejectsNull, '拒絕未知版本 / null');
ok(io.rejectsBadShape, '拒絕欄位型別錯誤的匯入檔', '目前會讓 bulkPut 拋 TypeError（能擋下但訊息不友善）');
ok(io.notCorrupted, '失敗的匯入沒有污染既有資料');

/* ================= 9. 孤兒紀錄 ================= */
console.log('\n[9] 孤兒紀錄容錯');
const orphan = await p.evaluate(async () => {
  const { idb } = await import('./js/db.js');
  const s = await import('./js/store.js');
  const sess = await import('./js/session.js');
  await idb.put('progress', { itemId: 'n3-v-9999', level: 'N3', type: 'vocab', box: 5, due: Date.now() - 1000, reps: 3, correct: 3, wrong: 0, updated: Date.now() });
  await idb.put('mistakes', { itemId: 'n3-v-9999', level: 'N3', type: 'vocab', count: 1, lastWrong: Date.now(), resolved: false });
  await idb.put('favorites', { itemId: 'n3-v-9999', level: 'N3', type: 'vocab', added: Date.now() });
  const r = await sess.buildSession({ type: 'vocab', level: 'N3', scope: 'smart', src: 'review' });
  const learned = (await s.allProgress()).filter((x) => x.box >= 3).length;
  return { sessionOk: Array.isArray(r.items), learnedIncludesOrphan: learned };
});
ok(orphan.sessionOk, '含孤兒 itemId 時複習組卷不會崩潰');
await go('#/mistakes');
const orphanUi = await p.evaluate(() => {
  const head = document.querySelector('.big-num')?.textContent;
  const dom = document.querySelectorAll('.list-item').length;
  return { head, dom };
});
ok(orphanUi.head === undefined || +orphanUi.head === orphanUi.dom,
  `錯題本標題數字 == 實際可顯示筆數 (${orphanUi.head} / ${orphanUi.dom})`,
  '孤兒錯題被 findItem 濾掉但仍計入標題 → 數字對不上、且無法從 UI 刪除');
await go('#/stats');
const orphanStats = await p.evaluate(() => document.querySelector('.stat-grid .big-num')?.textContent);
await p.evaluate(async () => {
  const { idb } = await import('./js/db.js');
  await idb.del('progress', 'n3-v-9999');
  await idb.del('mistakes', 'n3-v-9999');
  await idb.del('favorites', 'n3-v-9999');
});

/* ================= 10. 搜尋 ================= */
console.log('\n[10] 搜尋');
await go('#/search?q=断る');
const s1 = await p.evaluate(() => ({
  n: document.querySelectorAll('.detail-card').length,
  txt: document.querySelector('.search-results .small.muted')?.textContent
}));
ok(s1.n === 1, `搜尋「断る」只回一筆（跨級別重複已去重）`, `實際 ${s1.n} 筆・${s1.txt}`);

const s2 = await p.evaluate(async () => {
  const inp = document.querySelector('.search-input');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, '   '); inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  const blank = document.querySelector('.search-results')?.innerText || '';
  set.call(inp, 'zzzzqqq'); inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  const none = document.querySelector('.search-results')?.innerText || '';
  set.call(inp, 'たべ'); inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  const kana = document.querySelectorAll('.detail-card').length;
  return { blank: blank.slice(0, 30), none: none.slice(0, 30), kana };
});
ok(/輸入關鍵字/.test(s2.blank), '空白查詢顯示提示而非全部結果');
ok(/沒有符合/.test(s2.none), '無結果顯示提示');
ok(s2.kana > 0, `假名搜尋有結果 (${s2.kana})`);

// 羅馬字搜尋（README 有承諾此功能）
const roma = [];
for (const [q, want] of [['taberu', '食べる'], ['gakkou', '学校'], ['koohii', 'コーヒー']]) {
  await go(`#/search?q=${q}`);
  await p.waitForSelector('.detail-card, .empty', { timeout: 15000 }).catch(() => {});
  const hit = await p.evaluate(() => document.querySelector('.detail-card .detail-main')?.textContent);
  roma.push(`${q}→${hit || '無'}`);
}
ok(roma.every((r, i) => r.includes(['食べる', '学校', 'コーヒー'][i])),
  `羅馬字搜尋可用 (${roma.join(', ')})`);
const romaField = await p.evaluate(async () => {
  const d = await import('./js/data.js');
  const all = await d.loadMany('vocab', d.LEVELS);
  return { tot: all.length, filled: all.filter((x) => x.romaji && x.romaji.trim()).length };
});
ok(romaField.filled === romaField.tot, `所有單字都有 romaji (${romaField.filled}/${romaField.tot})`);

/* ================= 11. 收藏即時性 ================= */
console.log('\n[11] 收藏');
await go('#/search?q=勉強');
const favFlow = await p.evaluate(async () => {
  const s = await import('./js/store.js');
  const star = document.querySelector('.detail-card .star-btn');
  star.click();
  await new Promise((r) => setTimeout(r, 250));
  const added = (await s.allFavorites()).length;
  const pressed = star.getAttribute('aria-pressed');
  return { added, pressed };
});
ok(favFlow.added >= 1 && favFlow.pressed === 'true', `搜尋頁可加入收藏 (${favFlow.added} 項)`);
await go('#/favorites');
const favUi = await p.evaluate(async () => {
  const n0 = document.querySelectorAll('.detail-card').length;
  const head = +document.querySelector('.big-num')?.textContent;
  document.querySelector('.detail-card .star-btn')?.click();
  await new Promise((r) => setTimeout(r, 250));
  return { n0, head, afterUnstar: document.querySelectorAll('.detail-card').length };
});
ok(favUi.n0 === favUi.head, `最愛頁標題數字 == 卡片數 (${favUi.head}/${favUi.n0})`);
ok(favUi.afterUnstar === favUi.n0 - 1, '取消 ★ 後卡片立即移除',
  `仍顯示 ${favUi.afterUnstar} 張（目前設計要重新進頁才會消失）`);

/* ================= 12. 無障礙 / 鍵盤 ================= */
console.log('\n[12] 無障礙');
await go('#/study?type=vocab&level=N5&mode=quiz&scope=order');
const a11y = await p.evaluate(() => {
  const pb = document.querySelector('[role="progressbar"]');
  const fb = document.querySelector('#fb');
  const optGroup = document.querySelector('[role="group"]');
  const noLabel = [...document.querySelectorAll('button')].filter((b) =>
    !b.textContent.trim() && !b.getAttribute('aria-label') && !b.title).length;
  return {
    pb: !!pb && pb.hasAttribute('aria-valuenow'),
    live: fb?.getAttribute('aria-live') === 'polite',
    group: !!optGroup, noLabel
  };
});
ok(a11y.pb, '進度條有 role/aria-valuenow');
ok(a11y.live, '解說區有 aria-live');
ok(a11y.noLabel === 0, `無可見文字的按鈕都有 aria-label/title (${a11y.noLabel} 個缺)`);

const tabOrder = await p.evaluate(async () => {
  document.querySelector('.opt')?.focus();
  return document.activeElement?.className;
});
ok(/opt/.test(tabOrder), '選項可程式化聚焦');

/* ================= 13. 重置 ================= */
console.log('\n[13] 重置');
const reset = await p.evaluate(async () => {
  const s = await import('./js/store.js');
  await s.setSetting('seenGuide', true);
  await s.setDailyGoal(45);
  await s.resetAll();
  return {
    prog: (await s.allProgress()).length,
    mis: (await s.allMistakes()).length,
    fav: (await s.allFavorites()).length,
    daily: (await s.allDaily()).length,
    seenGuide: await s.getSetting('seenGuide', false),
    goal: await s.getDailyGoal()
  };
});
ok(reset.prog === 0 && reset.mis === 0 && reset.fav === 0 && reset.daily === 0, '重置清空進度/錯題/最愛/每日');
ok(reset.seenGuide === null || reset.seenGuide === false, '重置會清掉 seenGuide（引導能再出現）');
ok(reset.goal === 45, `重置保留偏好設定（每日目標仍為 ${reset.goal}）`);

await go('#/home');
const guideAfterReset = await p.evaluate(() => !!document.querySelector('.guide-card'));
ok(guideAfterReset, '重置後首頁重新顯示引導');

// 有進度時也能從設定手動叫回引導
const reGuide = await p.evaluate(async () => {
  const s = await import('./js/store.js');
  const { idb } = await import('./js/db.js');
  await s.setSetting('seenGuide', true);
  await idb.put('progress', { itemId: 'n5-v-0001', level: 'N5', type: 'vocab', box: 2, due: Date.now() + 1e6, reps: 1, correct: 1, wrong: 0, updated: Date.now() });
  await s.setSetting('seenGuide', false); // 等同按下「重看引導」
  return true;
});
await go('#/home');
ok(await p.evaluate(() => !!document.querySelector('.guide-card')),
  '已有學習進度時，「重看引導」仍能叫回引導');
await p.evaluate(async () => {
  const { idb } = await import('./js/db.js');
  await idb.clear('progress');
  await (await import('./js/store.js')).setSetting('seenGuide', true);
});

/* ================= 13b. 搜尋索引 / 匯入語意 ================= */
console.log('\n[13b] 搜尋索引與匯入語意');
const idxReq = await (async () => {
  const p2 = await b.newPage();
  const reqs = [];
  p2.on('request', (r) => { if (/\/data\//.test(r.url())) reqs.push(r.url().split('/data/')[1]); });
  await p2.goto(BASE + '#/search?q=勉強', { waitUntil: 'networkidle2' });
  await p2.waitForSelector('.detail-card', { timeout: 15000 }).catch(() => {});
  const dup = {};
  for (const u of reqs) dup[u] = (dup[u] || 0) + 1;
  const hasExample = await p2.evaluate(() => !!document.querySelector('.detail-card .detail-example'));
  await p2.close();
  return { reqs, dupes: Object.entries(dup).filter(([, n]) => n > 1), hasExample };
})();
ok(idxReq.reqs.includes('search-index.json'), '搜尋改用精簡索引 search-index.json');
ok(idxReq.dupes.length === 0, '同一個 data 檔不會被並行重複請求',
  idxReq.dupes.map(([u, n]) => `${u}×${n}`).join(', '));
ok(idxReq.hasExample, '搜尋結果卡片會惰性補上例句');

const impMode = await p.evaluate(async () => {
  const s = await import('./js/store.js');
  const { idb } = await import('./js/db.js');
  await idb.clear('progress');
  await idb.put('progress', { itemId: 'n5-v-0001', level: 'N5', type: 'vocab', box: 1, due: 1, reps: 1, correct: 1, wrong: 0, updated: 1 });
  const backup = await s.exportAll({ dataVersion: 'test' });   // 只含 n5-v-0001
  await idb.put('progress', { itemId: 'n5-v-0002', level: 'N5', type: 'vocab', box: 1, due: 1, reps: 1, correct: 1, wrong: 0, updated: 1 });
  await s.importAll(backup, 'replace');
  const after = (await s.allProgress()).map((r) => r.itemId).sort();
  const info = s.inspectBackup(backup);
  let rejected = false;
  try { s.inspectBackup({ version: 3, idScheme: 'something-else' }); } catch { rejected = true; }
  await idb.clear('progress');
  return { after, ver: backup.version, idScheme: backup.idScheme, counts: info.progress, rejected };
});
ok(impMode.after.length === 1 && impMode.after[0] === 'n5-v-0001',
  `匯入是「取代」而非合併 (還原後只剩 ${impMode.after.join(',')})`);
ok(impMode.ver === 3 && impMode.idScheme === 'positional-v1',
  `備份檔帶版本與 id 方案 (v${impMode.ver} / ${impMode.idScheme})`);
ok(impMode.rejected, '拒絕 id 方案不同的備份檔');

/* ================= 13c. 聽力練習 ================= */
console.log('\n[13c] 聽力練習');
await go('#/listening?level=N5&scope=random');
await p.waitForSelector('.play-btn, .btn', { timeout: 15000 }).catch(() => {});
const li = await p.evaluate(() => ({
  play: !!document.querySelector('.play-btn'),
  opts: document.querySelectorAll('.opt').length,
  uniq: new Set([...document.querySelectorAll('.opt')].map((o) => o.innerText)).size
}));
ok(li.play && li.opts === 4 && li.uniq === 4, `聽力出題：播放鈕 + 4 個相異選項 (${li.opts}/${li.uniq})`);

// 播放時長要跟文字長度成正比（證明引擎真的在唸，不是空轉）
const spoke = await p.evaluate(async () => {
  const s = await import('./js/speech.js');
  await s.whenVoicesReady();
  if (!s.hasJapaneseVoice()) return { skipped: true };
  const short = await s.speakChecked('はい。');
  const long = await s.speakChecked('すみません、この電車は東京駅に止まりますか。');
  return { short, long };
});
ok(spoke.skipped || (spoke.short.ok && spoke.long.ok && spoke.long.ms > spoke.short.ms),
  spoke.skipped ? '（此環境無日文語音，跳過發聲檢查）'
    : `speakChecked 回報有效播放且長句較久 (${spoke.short.ms}ms → ${spoke.long.ms}ms)`);

// 沒有日文語音時，不能給死按鈕
const noVoice = await (async () => {
  const p2 = await b.newPage();
  await p2.evaluateOnNewDocument(() => {
    Object.defineProperty(window.speechSynthesis, 'getVoices', { value: () => [], configurable: true });
  });
  await p2.goto(BASE + '#/listening?level=N5', { waitUntil: 'networkidle2' });
  await sleep(2500);
  const r = await p2.evaluate(() => {
    const t = document.querySelector('#view')?.innerText || '';
    return {
      play: !!document.querySelector('.play-btn'),
      retry: [...document.querySelectorAll('button')].some((x) => /重新偵測/.test(x.textContent)),
      howto: /iPhone|Android|Windows/.test(t)
    };
  });
  await p2.close();
  return r;
})();
ok(!noVoice.play && noVoice.retry && noVoice.howto,
  '無日文語音時：不顯示播放鈕，改給安裝說明與「重新偵測」',
  JSON.stringify(noVoice));

/* ================= 13d. 漢字讀音 / 例句填空 ================= */
console.log('\n[13d] 漢字讀音與例句填空');
const qt = await p.evaluate(async () => {
  const q = await import('./js/qtypes.js');
  const d = await import('./js/data.js');
  const idx = await q.readingIndex();
  const bad = [];

  // 漢字讀音：500 題隨機，驗兩條關鍵不變量
  for (let i = 0; i < 500; i++) {
    const item = idx.all[Math.floor(Math.random() * idx.all.length)];
    const dir = i % 10 < 7 ? 'kanji2kana' : 'kana2kanji';
    const Q = q.makeReadingQuestion(item, idx, dir);
    if (!Q) { bad.push('reading:null'); continue; }
    if (Q.opts.filter((o) => o.correct).length !== 1) bad.push('reading:正解數≠1');
    if (new Set(Q.opts.map((o) => o.text)).size !== Q.opts.length) bad.push('reading:選項重複');
    if (dir === 'kanji2kana') {
      const valid = idx.byKanji.get(item.kanji) || new Set();
      for (const o of Q.opts) if (!o.correct && valid.has(o.text)) bad.push(`reading:同形異讀當干擾 ${item.kanji}`);
    } else {
      const same = idx.byKana.get(item.kana) || new Set();
      for (const o of Q.opts) if (!o.correct && same.has(o.text)) bad.push(`reading:同音異字當干擾 ${item.kana}`);
    }
  }

  // 例句填空：400 題隨機，驗挖空位置正確、四選項互異
  const [v, g] = await Promise.all([d.loadMany('vocab', d.LEVELS), d.loadMany('grammar', d.LEVELS)]);
  const pool = [...v, ...g].filter(q.canAskCloze);
  let hintLeak = 0;
  for (let i = 0; i < 400; i++) {
    const item = pool[Math.floor(Math.random() * pool.length)];
    const Q = q.makeClozeQuestion(item, pool);
    if (!Q) continue;
    if (Q.opts.filter((o) => o.correct).length !== 1) bad.push('cloze:正解數≠1');
    if (new Set(Q.opts.map((o) => o.text)).size !== 4) bad.push('cloze:選項重複');
    if (Q.prompt.replace('＿＿＿', Q.correctText) !== item.example) bad.push(`cloze:還原不符 ${item.example}`);
    if (Q.correctText.length < 2) bad.push(`cloze:空格過短 ${Q.correctText}`);
    if (Q.promptSub && Q.promptSub === item.exampleMeaning) hintLeak++;
  }
  return { bad: [...new Set(bad)].slice(0, 6), badCount: bad.length, poolSize: pool.length, readingPool: idx.all.length, hintLeak };
});
ok(qt.badCount === 0, `漢字讀音 500 題 + 填空 400 題，0 個正確性違規（候選 ${qt.readingPool} / ${qt.poolSize}）`, qt.bad.join('; '));
ok(qt.hintLeak === 0, '填空題目不外洩中譯（作答後才顯示）', `${qt.hintLeak} 題有洩題`);

// 注意：讀音題有兩個方向（漢字→讀音 70% / 讀音→漢字 30%，對應 JLPT 文字語彙
// 第 1 大題「漢字読み」與第 2 大題「表記」），所以題目文字要接受兩種寫法。
for (const [label, hash, markers] of [
  ['漢字讀音', '#/study?level=N3&mode=quiz&scope=random&qtype=reading', ['這個詞怎麼唸', '對應哪個漢字']],
  ['例句填空', '#/study?level=N3&mode=quiz&scope=random&qtype=cloze', ['填入空格']]
]) {
  await go(hash);
  await p.waitForSelector('.opt', { timeout: 15000 }).catch(() => {});
  const r = await p.evaluate(() => ({
    q: document.querySelector('.quiz-q')?.innerText || '',
    n: document.querySelectorAll('.opt').length,
    uniq: new Set([...document.querySelectorAll('.opt')].map((o) => o.innerText)).size
  }));
  ok(r.n === 4 && r.uniq === 4 && markers.some((m) => r.q.includes(m)),
    `${label} 出題正常（${r.n} 個相異選項）`, r.q);
}

/* ================= 15. 模擬考計時模式 ================= */
console.log('\n[15] 模擬考計時模式');
{
  const p2 = await b.newPage();
  await p2.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const e2 = [];
  p2.on('pageerror', (e) => e2.push('pageerror: ' + e.message));
  p2.on('console', (m) => { if (m.type() === 'error') e2.push('console: ' + m.text()); });
  p2.on('dialog', async (d) => { await d.accept(); });
  const click = (t) => p2.evaluate((s) => {
    const el = [...document.querySelectorAll('button')].find((x) => x.innerText.includes(s));
    if (el) el.click();
    return !!el;
  }, t);

  await p2.goto(BASE + '#/exam?level=N3', { waitUntil: 'networkidle2' });
  await sleep(700);

  // 時間不是隨便訂的：N3 每題 55 秒（真實考試總時間 ÷ 題數），快速版 10 題 = 9:10
  const planText = await p2.$$eval('.card .li-sub', (els) => els.map((e) => e.innerText));
  ok(planText[0] === '10 題・9:10', `科目時間依真實考試節奏換算（N3 10 題 = 9:10）`, planText.join(' / '));

  const before = await p2.evaluate(async () => (await (await import('./js/store.js')).allProgress()).length);

  await click('開始模擬考'); await sleep(3000);
  const introOk = await p2.evaluate(() => document.body.innerText.includes('第 1 科'));
  await click('開始作答'); await sleep(500);

  // 作答當下不可以揭曉對錯，否則就只是有計時的一般測驗
  await p2.evaluate(() => document.querySelectorAll('.opt')[0].click());
  await sleep(250);
  const noReveal = await p2.evaluate(() => ({
    graded: document.querySelectorAll('.opt.correct, .opt.wrong').length,
    fb: !!document.getElementById('fb'),
    done: document.querySelectorAll('.exam-no.done').length
  }));
  ok(introOk && noReveal.graded === 0 && !noReveal.fb && noReveal.done === 1,
    `作答中不揭曉對錯，只標記已作答`, JSON.stringify(noReveal));

  // 回頭改答案：跳回第 1 題，原本選的要還在，改掉後要換成新的
  const revisit = await p2.evaluate(async () => {
    document.querySelectorAll('.exam-no')[0].click();
    await new Promise((r) => setTimeout(r, 80));
    const keptAt = [...document.querySelectorAll('.opt')].findIndex((o) => o.classList.contains('picked'));
    document.querySelectorAll('.opt')[3].click();
    await new Promise((r) => setTimeout(r, 80));
    document.querySelectorAll('.exam-no')[0].click();
    await new Promise((r) => setTimeout(r, 80));
    const nowAt = [...document.querySelectorAll('.opt')].findIndex((o) => o.classList.contains('picked'));
    return { keptAt, nowAt };
  });
  ok(revisit.keptAt === 0 && revisit.nowAt === 3,
    `可跳題回頭改答案且保留選擇 (原 ${revisit.keptAt + 1} → 改成 ${revisit.nowAt + 1})`, JSON.stringify(revisit));

  // 計時器真的在倒數
  const t1 = await p2.evaluate(() => document.querySelector('.exam-timer').textContent);
  await sleep(2600);
  const t2 = await p2.evaluate(() => document.querySelector('.exam-timer').textContent);
  const secs = (s) => { const [m, x] = s.split(':').map(Number); return m * 60 + x; };
  ok(secs(t1) - secs(t2) >= 2, `計時器持續倒數 (${t1} → ${t2})`);
  await p2.close();
}
{
  // 時間到自動交卷：把 setInterval 加速 100 倍，讓整段計時真的跑完（不是模擬）
  const p3 = await b.newPage();
  await p3.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  p3.on('dialog', async (d) => { await d.accept(); });
  await p3.evaluateOnNewDocument(() => {
    const real = window.setInterval;
    window.setInterval = (fn, ms, ...a) => real(fn, ms >= 1000 ? ms / 100 : ms, ...a);
  });
  const click3 = (t) => p3.evaluate((s) => {
    const el = [...document.querySelectorAll('button')].find((x) => x.innerText.includes(s));
    if (el) el.click();
    return !!el;
  }, t);
  await p3.goto(BASE + '#/exam?level=N5', { waitUntil: 'networkidle2' });
  await sleep(700);
  const p0 = await p3.evaluate(async () => (await (await import('./js/store.js')).allProgress()).length);
  await click3('開始模擬考'); await sleep(3000);
  await click3('開始作答');
  // 只答 2 題就放著，其餘留白等時間到
  await sleep(300);
  await p3.evaluate(() => { document.querySelectorAll('.opt')[0].click(); });
  await sleep(150);
  await p3.evaluate(() => { document.querySelectorAll('.opt')[0].click(); });
  // 10 題 × 45 秒 = 450 秒，加速 100 倍 ≈ 4.5 秒
  await sleep(9000);
  const state = await p3.evaluate(() => document.body.innerText);
  const autoSubmitted = /第 2 科|各科表現/.test(state);
  ok(autoSubmitted, `時間到自動交卷並進入下一科`, state.slice(0, 80));
  // 未作答不該寫進 SRS（時間到來不及寫 ≠ 學錯了）
  const p1 = await p3.evaluate(async () => (await (await import('./js/store.js')).allProgress()).length);
  ok(p1 - p0 <= 2, `未作答的題目不寫入 SRS (新增 ${p1 - p0} 筆，實際作答 2 題)`,
    `寫了 ${p1 - p0} 筆，超過實際作答數 → 空白題被當成答錯記進進度`);
  await p3.close();
}

/* ================= 16. 複習預測日曆 ================= */
console.log('\n[16] 複習預測日曆');
{
  const p4 = await b.newPage();
  await p4.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const e4 = [];
  p4.on('pageerror', (e) => e4.push('pageerror: ' + e.message));
  await p4.goto(BASE + '#/home', { waitUntil: 'networkidle2' });
  // 種下已知的到期分佈：逾期 3、今天稍後 2、第 3 天 5、第 13 天 4、第 20 天（超出範圍）6
  const planted = await p4.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    for (const r of await idb.getAll('progress')) await idb.del('progress', r.itemId);
    const now = Date.now();
    const mid = new Date(); mid.setHours(23, 30, 0, 0);            // 今天稍晚
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(12, 0, 0, 0); return d.getTime(); };
    const spec = [[3, now - 3600000], [2, mid.getTime()], [5, day(3)], [4, day(13)], [6, day(20)]];
    let i = 0;
    for (const [n, due] of spec) {
      for (let k = 0; k < n; k++, i++) {
        await idb.put('progress', { itemId: `n5-v-${String(i + 1).padStart(4, '0')}`, level: 'N5', type: 'vocab', box: 2, due, reps: 2, correct: 2, wrong: 0, updated: now });
      }
    }
    return spec;
  });
  await p4.goto('about:blank');
  await p4.goto(BASE + '#/review', { waitUntil: 'networkidle2' });
  await sleep(800);
  const fc = await p4.evaluate(() => ({
    cols: document.querySelectorAll('.fc-col').length,
    nums: [...document.querySelectorAll('.fc-n')].map((e) => +(e.textContent || 0)),
    summary: document.querySelector('.fc-row')?.parentElement?.querySelector('.small.muted')?.textContent || '',
    aria: !!document.querySelector('.fc-row')?.getAttribute('aria-label'),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }));
  ok(fc.cols === 14 && fc.aria && !fc.overflow,
    `預測日曆 14 欄、有 aria 替代文字、390px 無橫向溢出`, JSON.stringify({ cols: fc.cols, aria: fc.aria, overflow: fc.overflow }));
  // 分桶必須落在正確的日子：今天 2、第 3 天 5、第 13 天 4，其餘 0
  const want = Array(14).fill(0);
  want[0] = 2; want[3] = 5; want[13] = 4;
  ok(JSON.stringify(fc.nums) === JSON.stringify(want),
    `到期量分到正確的日子 (今天 ${fc.nums[0]}／第3天 ${fc.nums[3]}／第13天 ${fc.nums[13]})`,
    `實際 ${JSON.stringify(fc.nums)} 期望 ${JSON.stringify(want)}`);
  // 逾期與超出 14 天的要另外計，不能混進當日長條
  ok(/已逾期 3 項/.test(fc.summary) && /14 天後還有 6 項/.test(fc.summary),
    `逾期 3 項與 14 天後 6 項另外標示，未混入當日長條`, fc.summary);
  await p4.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    for (const r of await idb.getAll('progress')) await idb.del('progress', r.itemId);
  });
  ok(e4.length === 0, '預測日曆頁面無 console 錯誤', e4.join(' | '));
  await p4.close();
}

/* ================= 17. 學習熱力圖 ================= */
console.log('\n[17] 學習熱力圖');
{
  const p5 = await b.newPage();
  await p5.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const e5 = [];
  p5.on('pageerror', (e) => e5.push('pageerror: ' + e.message));
  await p5.goto(BASE + '#/home', { waitUntil: 'networkidle2' });
  await p5.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    // 明確設定每日目標：色階是拿它當基準，前面的測試動過滑桿會讓這裡的期望值漂掉
    await (await import('./js/store.js')).setDailyGoal(20);
    for (const r of await idb.getAll('daily')) await idb.del('daily', r.date);
    const z = (n) => String(n).padStart(2, '0');
    const key = (d) => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
    for (let i = 0; i < 120; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      if (i % 7 === 3) continue;                      // 每週留一天空白
      await idb.put('daily', { date: key(d), studied: [3, 12, 25, 60][i % 4], correct: 1, wrong: 0, cards: 2 });
    }
  });
  await p5.goto('about:blank');
  await p5.goto(BASE + '#/stats', { waitUntil: 'networkidle2' });
  await sleep(900);
  const hm = await p5.evaluate(() => {
    const cells = [...document.querySelectorAll('.hm-grid .hm-c')];
    const titled = cells.filter((c) => c.title);
    const z = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const today = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
    return {
      cols: document.querySelectorAll('.hm-col').length,
      cells: cells.length,
      hasToday: titled.some((c) => c.title.startsWith(today)),
      levels: [1, 2, 3, 4].map((l) => document.querySelectorAll(`.hm-grid .hm-c.l${l}`).length),
      aria: document.querySelector('.hm-grid')?.getAttribute('aria-label') || '',
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
  // 對齊方式若寫錯（先退 N 週再對齊週日），格子會涵蓋不到今天——今天學了卻看不到
  ok(hm.hasToday, `熱力圖最後一欄含今天`, `今天的格子不在圖上（週對齊算錯）`);
  ok(hm.cells === hm.cols * 7 && !hm.overflow,
    `熱力圖 ${hm.cols} 欄 × 7 列、390px 無橫向溢出`, JSON.stringify(hm));
  // 深淺要對照每日目標而不是當期最大值：四種強度都要出現
  ok(hm.levels.every((n) => n > 0),
    `色階對照每日目標，四個強度都有出現 (${hm.levels.join('/')})`,
    '若用當期最大值上色，低強度的日子會被染深、圖失去意義');
  ok(/最長連續\s*\d+\s*天/.test(hm.aria), `熱力圖有 aria 替代文字`, hm.aria);
  ok(e5.length === 0, '熱力圖頁面無 console 錯誤', e5.join(' | '));
  await p5.close();
}

/* ================= 18. 弱點清單 ================= */
console.log('\n[18] 弱點清單');
{
  const p6 = await b.newPage();
  await p6.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const e6 = [];
  p6.on('pageerror', (e) => e6.push('pageerror: ' + e.message));
  await p6.goto(BASE + '#/home', { waitUntil: 'networkidle2' });
  await p6.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    for (const r of await idb.getAll('progress')) await idb.del('progress', r.itemId);
    const now = Date.now();
    // [id, box, reps, correct, wrong]
    const spec = [
      ['n5-v-0001', 1, 5, 4, 1],    // 錯得少
      ['n5-v-0002', 5, 12, 4, 8],   // 錯很多但已掌握
      ['n5-v-0003', 0, 2, 0, 2],    // 作答次數不足
      ['n5-v-0004', 1, 6, 3, 3],
      ['n5-v-0005', 0, 9, 2, 7],    // 最弱
      ['n5-v-0006', 6, 8, 8, 0]     // 全對
    ];
    for (const [itemId, box, reps, correct, wrong] of spec) {
      await idb.put('progress', { itemId, level: 'N5', type: 'vocab', box, due: now + 9e8, reps, correct, wrong, updated: now });
    }
  });
  await p6.goto('about:blank');
  await p6.goto(BASE + '#/weak', { waitUntil: 'networkidle2' });
  await sleep(1200);
  const wk = await p6.evaluate(() => [...document.querySelectorAll('.list-item')].map((e) => e.innerText.replace(/\n/g, ' ')));
  ok(wk.length === 4, `作答未滿 3 次與全對的項目不列入 (列出 ${wk.length} 項，種了 6 筆)`, wk.join(' || '));
  const order = wk.map((s) => (s.match(/錯 (\d+) \/ 共 (\d+)/) || []).slice(1).join('/'));
  ok(order[0] === '7/9' && order[1] === '3/6' && order[2] === '8/12' && order[3] === '1/5',
    `排序依困難度而非錯誤次數 (${order.join(' > ')})`,
    '錯 8 次但已掌握的應排在錯 3 次卻還沒掌握的後面');
  ok(/已掌握但錯過很多次/.test(wk[2]),
    `已掌握但錯很多次的項目仍會列出（錯題本會把它標成已解決而消失）`, wk[2]);
  // 「針對這些練一輪」要真的只出這些題
  await p6.goto('about:blank');
  await p6.goto(BASE + '#/study?mode=quiz&src=weak&level=ALL', { waitUntil: 'networkidle2' });
  await sleep(1200);
  const wq = await p6.evaluate(() => ({
    count: document.querySelector('.study-count')?.textContent?.trim(),
    back: (() => { document.querySelector('.study-head .icon-btn')?.click(); return location.hash; })()
  }));
  ok(wq.count === '1 / 4' && wq.back === '#/weak',
    `弱點測驗只出弱點題並可返回弱點清單 (${wq.count}, ${wq.back})`, JSON.stringify(wq));
  await p6.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    for (const r of await idb.getAll('progress')) await idb.del('progress', r.itemId);
  });
  ok(e6.length === 0, '弱點清單頁面無 console 錯誤', e6.join(' | '));
  await p6.close();
}

/* ================= 19. 入口參數傳遞 ================= */
console.log('\n[19] 入口參數傳遞');
{
  const p7 = await b.newPage();
  await p7.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const e7 = [];
  p7.on('pageerror', (e) => e7.push('pageerror: ' + e.message));

  // Layer A：畫面上的按鈕有沒有把級別帶進 URL
  await p7.goto(BASE + '#/home', { waitUntil: 'networkidle2' });
  await sleep(1200);
  const homeQuick = await p7.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('快速測驗'));
    if (!el) return null;
    el.click();
    return location.hash;
  });
  ok(/[?&]level=N5(&|$)/.test(homeQuick || ''),
    `首頁快速測驗的 URL 帶了級別 (${homeQuick})`, '按鈕沒把 level 帶進 query');

  // Layer B：buildSession 對每一種 src 都要尊重 o.level
  // 曾經有 `o.src === 'mix'` 無條件改載入全部五級，害首頁「N5 快速測驗」出 N1~N5
  await p7.goto('about:blank');
  await p7.goto(BASE + '#/home', { waitUntil: 'networkidle2' });
  await sleep(1000);
  const bySrc = await p7.evaluate(async () => {
    const { buildSession } = await import('./js/session.js');
    const out = {};
    for (const src of ['set', 'mix', undefined, 'anything']) {
      for (const level of ['N5', 'N1']) {
        const { items } = await buildSession({ type: 'vocab', level, scope: 'smart', src });
        out[`${src}/${level}`] = [...new Set(items.map((i) => i.level))].sort();
      }
    }
    const all = await buildSession({ type: 'vocab', level: 'ALL', scope: 'random', src: 'set' });
    out['set/ALL'] = [...new Set(all.items.map((i) => i.level))].sort();
    return out;
  });
  const leaks = Object.entries(bySrc).filter(([k, v]) => {
    const want = k.split('/')[1];
    return want === 'ALL' ? v.length < 2 : !(v.length === 1 && v[0] === want);
  });
  ok(leaks.length === 0,
    `buildSession 對任何 src 都只出指定級別（level='ALL' 才跨級）`,
    leaks.map(([k, v]) => `${k} → ${v.join(',')}`).join('; '));

  // 每個帶級別的實際入口 URL，出題級別都要相符
  const entries = [
    ['首頁快速測驗', '#/study?type=vocab&level=N5&mode=quiz', 'N5'],
    // 使用者實際點到的那個 URL：舊版帶 src=mix，會被無條件改成全五級
    ['舊版首頁 URL (src=mix)', '#/study?type=vocab&level=N5&mode=quiz&src=mix', 'N5'],
    ['學習頁 單字測驗', '#/study?type=vocab&level=N2&mode=quiz&scope=smart', 'N2'],
    ['學習頁 文法測驗', '#/study?type=grammar&level=N4&mode=quiz&scope=smart', 'N4'],
    ['學習頁 漢字讀音', '#/study?type=vocab&level=N3&mode=quiz&scope=smart&qtype=reading', 'N3'],
    ['學習頁 例句填空', '#/study?type=grammar&level=N3&mode=quiz&scope=smart&qtype=cloze', 'N3']
  ];
  const wrongLevel = [];
  for (const [name, hash, want] of entries) {
    await p7.goto('about:blank');
    await p7.goto(BASE + hash, { waitUntil: 'networkidle2' });
    await sleep(1100);
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      const lv = await p7.evaluate(() => document.querySelector('.quiz-q .pill')?.textContent?.trim());
      if (lv) seen.add(lv);
      await p7.evaluate(() => document.querySelector('.opt:not([disabled])')?.click());
      await sleep(120);
      await p7.evaluate(() => document.querySelector('.quiz-next')?.click());
      await sleep(160);
    }
    if (seen.size !== 1 || !seen.has(want)) wrongLevel.push(`${name} 期望 ${want} 卻出 ${[...seen].join(',')}`);
  }
  ok(wrongLevel.length === 0, `六個帶級別的測驗入口都只出該級別的題（含舊版 src=mix 的 URL）`, wrongLevel.join('; '));

  // 閃卡沒有級別標籤，改從組卷層驗
  await p7.goto('about:blank');
  await p7.goto(BASE + '#/home', { waitUntil: 'networkidle2' });
  await sleep(900);
  const flash = await p7.evaluate(async () => {
    const { buildSession } = await import('./js/session.js');
    const out = {};
    for (const [type, level] of [['vocab', 'N5'], ['grammar', 'N1']]) {
      const { items } = await buildSession({ type, level, scope: 'smart', src: 'set' });
      out[`${type}/${level}`] = [...new Set(items.map((i) => i.level))];
    }
    return out;
  });
  ok(Object.entries(flash).every(([k, v]) => v.length === 1 && v[0] === k.split('/')[1]),
    `閃卡組卷也只出指定級別`, JSON.stringify(flash));

  // 聽力的題池同樣要吃級別
  const listen = await p7.evaluate(async () => {
    const d = await import('./js/data.js');
    const { audioOf } = await import('./js/qtypes.js');
    const out = {};
    for (const lv of ['N5', 'N2']) {
      const [v, g] = await Promise.all([d.loadMany('vocab', [lv]), d.loadMany('grammar', [lv])]);
      out[lv] = [...new Set([...v, ...g].filter(audioOf).map((x) => x.level))];
    }
    return out;
  });
  ok(Object.entries(listen).every(([lv, v]) => v.length === 1 && v[0] === lv),
    `聽力題池只出指定級別`, JSON.stringify(listen));
  ok(e7.length === 0, '入口參數測試無 console 錯誤', e7.join(' | '));
  await p7.close();
}

/* ================= 20. 掌握度會前進 ================= */
console.log('\n[20] 掌握度會前進');
{
  const p8 = await b.newPage();
  await p8.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const e8 = [];
  p8.on('pageerror', (e) => e8.push('pageerror: ' + e.message));
  await p8.goto(BASE + '#/home', { waitUntil: 'networkidle2' });
  await sleep(1000);

  // smart 排程要把到期的複習題排進來。原本是「未學過優先」，
  // 題庫有三千多條，未學過的永遠填滿整輪 → 到期題永遠排不到 → 掌握度永遠 0
  const dueFirst = await p8.evaluate(async () => {
    const { buildSession } = await import('./js/session.js');
    const { idb } = await import('./js/db.js');
    const d = await import('./js/data.js');
    for (const r of await idb.getAll('progress')) await idb.del('progress', r.itemId);
    const pool = await d.loadSet('vocab', 'N5');
    const overdue = pool.slice(0, 30).map((x) => x.id);
    for (const id of overdue) {
      await idb.put('progress', { itemId: id, level: 'N5', type: 'vocab', box: 1, due: Date.now() - 3600000, reps: 1, correct: 1, wrong: 0, updated: Date.now() });
    }
    const { items } = await buildSession({ type: 'vocab', level: 'N5', scope: 'smart', src: 'set' });
    const set = new Set(overdue);
    return { total: items.length, due: items.filter((i) => set.has(i.id)).length };
  });
  ok(dueFirst.due >= 14,
    `smart 排程優先送出到期複習題 (${dueFirst.total} 題中有 ${dueFirst.due} 題是到期的)`,
    '到期題排不進來的話，沒有任何項目升得到 box 3，掌握度會永遠是 0');

  // 跑完整條路徑：連續 4 天各練一輪全對，已掌握必須 > 0
  const journey = await p8.evaluate(async () => {
    const { buildSession } = await import('./js/session.js');
    const { recordAnswer, allProgress } = await import('./js/store.js');
    const { stageOf } = await import('./js/srs.js');
    const { idb } = await import('./js/db.js');
    for (const r of await idb.getAll('progress')) await idb.del('progress', r.itemId);
    const days = [];
    for (let day = 1; day <= 4; day++) {
      const { items } = await buildSession({ type: 'vocab', level: 'N5', scope: 'smart', src: 'set' });
      for (const it of items) await recordAnswer({ item: it, level: it.level, type: it.type, grade: 'good' });
      const prog = await allProgress();
      days.push({
        day,
        learned: prog.filter((r) => stageOf(r) === 'learned').length,
        learning: prog.filter((r) => stageOf(r) === 'learning').length
      });
      for (const r of prog) { r.due -= 86400000; await idb.put('progress', r); }  // 時間快轉一天
    }
    return days;
  });
  ok(journey[0].learning === 20,
    `第 1 天練 20 題就看得到「學習中 20」（不是 0）`, JSON.stringify(journey[0]));
  ok(journey.at(-1).learned > 0,
    `連續 4 天各一輪全對後已掌握 ${journey.at(-1).learned} 項（>0）`,
    `修正前無論練幾輪都是 0：${JSON.stringify(journey)}`);

  // 畫面要講得出規則，不能只丟一個 0 給使用者
  await p8.goto('about:blank');
  await p8.goto(BASE + '#/stats', { waitUntil: 'networkidle2' });
  await sleep(900);
  const statsTxt = await p8.evaluate(() => document.getElementById('view').innerText);
  ok(/學習中/.test(statsTxt) && /答對\s*3\s*次/.test(statsTxt),
    `統計頁同時顯示「學習中」並說明已掌握的條件`, statsTxt.slice(0, 120));

  await p8.goto('about:blank');
  await p8.goto(BASE + '#/learn?type=vocab&level=N5', { waitUntil: 'networkidle2' });
  await sleep(900);
  const learnTxt = await p8.evaluate(() => document.getElementById('view').innerText);
  ok(/學習中\s*\d+/.test(learnTxt) && /最快要跨\s*3\s*天/.test(learnTxt),
    `學習頁顯示「學習中」數量並說明要跨 3 天`, learnTxt.slice(0, 160));

  // 第一天練完 due 全在明天，首頁不能只說「沒有待複習」讓人以為白練
  await p8.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    for (const r of await idb.getAll('progress')) {
      r.due = Date.now() + 86400000; await idb.put('progress', r);
    }
  });
  await p8.goto('about:blank');
  await p8.goto(BASE + '#/home', { waitUntil: 'networkidle2' });
  await sleep(900);
  const homeTxt = await p8.evaluate(() => document.getElementById('view').innerText);
  ok(/明天有\s*\d+\s*項到期/.test(homeTxt),
    `沒有到期項目時，首頁會說下一批什麼時候到`, homeTxt.split('\n').slice(0, 12).join(' | '));

  await p8.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    for (const r of await idb.getAll('progress')) await idb.del('progress', r.itemId);
  });
  ok(e8.length === 0, '掌握度流程測試無 console 錯誤', e8.join(' | '));
  await p8.close();
}

/* ================= 21. 備份提醒與持久儲存 ================= */
console.log('\n[21] 備份提醒與持久儲存');
{
  const DAY = 86400000;
  const p9 = await b.newPage();
  await p9.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const e9 = [];
  p9.on('pageerror', (e) => e9.push('pageerror: ' + e.message));
  p9.on('console', (m) => { if (m.type() === 'error') e9.push('console: ' + m.text()); });
  // 匯出會觸發真的下載；不設這個，headless 點下去會失敗
  const dl = await p9.createCDPSession();
  await dl.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: tmpdir() });
  // persist()／persisted() 的呼叫次數與回傳值都要能操控，且必須在頁面載入前就換掉
  await p9.evaluateOnNewDocument(() => {
    window.__persistCalls = 0;
    const real = navigator.storage;
    if (real) {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        get: () => ({
          persist: async () => { window.__persistCalls += 1; return true; },
          // 用 localStorage 而不是 window 上的變數：換頁後 window 會重置，旗標要跨頁存活
          persisted: async () => localStorage.getItem('__persisted') === '1',
          estimate: real.estimate ? real.estimate.bind(real) : undefined
        })
      });
    }
  });
  await p9.goto(BASE + '#/home', { waitUntil: 'networkidle2' });
  await sleep(800);

  const goP = async (hash) => {
    await p9.goto('about:blank');
    await p9.goto(BASE + hash, { waitUntil: 'networkidle2' });
    await p9.waitForFunction(() => document.querySelector('#view')?.children.length > 0, { timeout: 15000 }).catch(() => {});
    await sleep(400);
  };
  // 造情境：直接預置 IndexedDB（不需要釘時鐘），回傳值當前置斷言用
  const preset = (cfg) => p9.evaluate(async (c) => {
    const { idb } = await import('./js/db.js');
    for (const s of ['meta', 'daily', 'progress', 'mistakes', 'favorites']) await idb.clear(s);
    const day = 86400000;
    const z = (n) => String(n).padStart(2, '0');
    const key = (d) => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
    await idb.put('meta', { k: 'seenGuide', v: true });   // 引導卡會擋住要驗的文字
    if (c.exportedDaysAgo != null) {
      await idb.put('meta', { k: 'lastExportAt', v: new Date(Date.now() - c.exportedDaysAgo * day).toISOString() });
    }
    if (c.snoozeDaysFromNow != null) {
      await idb.put('meta', { k: 'backupSnoozeUntil', v: new Date(Date.now() + c.snoozeDaysFromNow * day).toISOString() });
    }
    for (const ago of (c.studiedDaysAgo || [])) {
      await idb.put('daily', { date: key(new Date(Date.now() - ago * day)), studied: 5, correct: 5, wrong: 0, cards: 0 });
    }
    return {
      lastExportAt: (await idb.get('meta', 'lastExportAt'))?.v || null,
      dailyRows: (await idb.getAll('daily')).length
    };
  }, cfg);
  const homeText = () => p9.evaluate(() => document.getElementById('view').innerText);
  const hasCard = async () => /該備份學習進度了/.test(await homeText());
  // 找不到按鈕就回 false，不要對 null 呼叫 click()——那會讓整節中斷、後面的檢查連跑都沒跑到
  const clickBtn = (src) => p9.evaluate((re) => {
    const btn = [...document.querySelectorAll('button')].find((x) => new RegExp(re).test(x.textContent));
    if (!btn) return false;
    btn.click();
    return true;
  }, src);

  // B1：15 天前匯出、之後有練 → 有卡，天數正確
  const s1 = await preset({ exportedDaysAgo: 15, studiedDaysAgo: [0, 1, 2] });
  ok(s1.lastExportAt !== null && s1.dailyRows === 3, '[B1 前置] 預置的 lastExportAt 與 daily 真的寫進 IndexedDB 了', JSON.stringify(s1));
  await goP('#/home');
  const t1 = await homeText();
  ok(/該備份學習進度了/.test(t1) && /上次匯出是 15 天前/.test(t1) && /又練了 3 天/.test(t1),
    '[B1] 15 天沒匯出、期間有練 → 首頁出現備份提醒卡，天數正確',
    t1.split('\n').slice(0, 8).join(' | '));

  // B2：13 天前匯出 → 還沒到 14 天，不提醒
  await preset({ exportedDaysAgo: 13, studiedDaysAgo: [0, 1] });
  await goP('#/home');
  ok(!(await hasCard()), '[B2] 13 天前才匯出過 → 不提醒（門檻 14 天）');

  // B3：15 天前匯出，但之後完全沒練 → 沒有新東西會丟，不提醒
  const s3 = await preset({ exportedDaysAgo: 15, studiedDaysAgo: [20, 18] });
  ok(s3.dailyRows === 2, '[B3 前置] daily 只有早於上次匯出的日子', JSON.stringify(s3));
  await goP('#/home');
  ok(!(await hasCard()), '[B3] 太久沒匯出但期間沒有新進度 → 不提醒');

  // B4：從沒匯出過 → 學 2 天不提醒、3 天才提醒
  await preset({ exportedDaysAgo: null, studiedDaysAgo: [0, 1] });
  await goP('#/home');
  const never2 = await hasCard();
  await preset({ exportedDaysAgo: null, studiedDaysAgo: [0, 1, 2] });
  await goP('#/home');
  const t4 = await homeText();
  ok(!never2 && /該備份學習進度了/.test(t4) && /還沒有匯出過備份/.test(t4),
    '[B4] 從沒匯出過：學 2 天不提醒、3 天才提醒且文字是「還沒有匯出過」',
    `2 天有卡=${never2} / ${t4.split('\n').slice(0, 6).join(' | ')}`);

  // B5：真實入口——按卡上的「現在匯出」
  const before5 = await preset({ exportedDaysAgo: 15, studiedDaysAgo: [0, 1, 2] });
  await p9.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    await idb.put('progress', { itemId: 'n5-v-0001', level: 'N5', type: 'vocab', box: 2, due: Date.now(), reps: 3, correct: 3, wrong: 0, updated: Date.now() });
    await idb.put('mistakes', { itemId: 'n5-v-0002', level: 'N5', type: 'vocab', count: 1, resolved: false, lastWrong: Date.now() });
    await idb.put('favorites', { itemId: 'n5-v-0003', level: 'N5', type: 'vocab', added: Date.now() });
  });
  const snap = () => p9.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    const out = {};
    for (const s of ['progress', 'mistakes', 'daily', 'favorites']) {
      out[s] = JSON.stringify((await idb.getAll(s)).sort((a, x) => String(a.itemId || a.date) < String(x.itemId || x.date) ? -1 : 1));
    }
    return out;
  });
  await goP('#/home');
  ok(before5.lastExportAt !== null && (await hasCard()), '[B5 前置] 按之前卡在畫面上');
  const learnBefore = await snap();
  const clicked5 = await clickBtn('現在匯出');
  await sleep(900);
  const after5 = await p9.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    return {
      lastExportAt: (await idb.get('meta', 'lastExportAt'))?.v || null,
      snooze: (await idb.get('meta', 'backupSnoozeUntil'))?.v || null,
      persistCalls: window.__persistCalls,
      cardGone: !/該備份學習進度了/.test(document.getElementById('view').innerText)
    };
  });
  const learnAfter = await snap();
  ok(clicked5 && after5.lastExportAt !== before5.lastExportAt && Date.parse(after5.lastExportAt) > Date.now() - 60000
     && after5.cardGone && after5.snooze === null,
    '[B5] 按「現在匯出」→ 走同一支匯出、寫入 lastExportAt、卡消失、snooze 被清掉', JSON.stringify(after5));
  ok(['progress', 'mistakes', 'daily', 'favorites'].every((s) => learnBefore[s] === learnAfter[s]),
    '[B5] 匯出前後 progress／mistakes／daily／favorites 逐筆相同（匯出不改學習資料）');
  ok(after5.persistCalls === 1, `[B10] 只有按匯出才呼叫 persist()，載入首頁時是 0、按完是 1（實際 ${after5.persistCalls}）`);

  // B6：「這週先不要」
  await preset({ exportedDaysAgo: 15, studiedDaysAgo: [0, 1, 2] });
  await goP('#/home');
  const clicked6 = await clickBtn('這週先不要');
  await sleep(400);
  const goneNow = await p9.evaluate(() => !/該備份學習進度了/.test(document.getElementById('view').innerText));
  await goP('#/home');
  const goneAfterReload = !(await hasCard());
  await p9.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    await idb.put('meta', { k: 'backupSnoozeUntil', v: new Date(Date.now() - 86400000).toISOString() });
  });
  await goP('#/home');
  ok(clicked6 && goneNow && goneAfterReload && (await hasCard()),
    '[B6] 「這週先不要」→ 卡消失、重新整理仍不出現；snooze 過期後卡回來',
    `按到按鈕=${clicked6} 當下=${goneNow} 重載=${goneAfterReload}`);

  // B7：匯出失敗就不能記 lastExportAt（否則提醒被錯誤地消掉）
  const before7 = await preset({ exportedDaysAgo: 15, studiedDaysAgo: [0, 1, 2] });
  await goP('#/home');
  const fail7 = await p9.evaluate(async () => {
    const real = URL.createObjectURL;
    URL.createObjectURL = () => { throw new Error('測試注入：下載失敗'); };
    const btn = [...document.querySelectorAll('button')].find((x) => /現在匯出/.test(x.textContent));
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 600));
    URL.createObjectURL = real;
    const { idb } = await import('./js/db.js');
    return {
      clicked: !!btn,
      lastExportAt: (await idb.get('meta', 'lastExportAt'))?.v || null,
      stillThere: /該備份學習進度了/.test(document.getElementById('view').innerText),
      toast: document.body.innerText.includes('匯出失敗')
    };
  });
  ok(fail7.clicked && fail7.lastExportAt === before7.lastExportAt && fail7.stillThere && fail7.toast,
    '[B7] 匯出失敗 → lastExportAt 不變、提醒卡還在、畫面說匯出失敗', JSON.stringify(fail7));

  // B8：匯入備份 → lastExportAt 變成那份備份的時間；resetAll 之後不提醒
  const imported = await p9.evaluate(async () => {
    const { importAll, resetAll } = await import('./js/store.js');
    const { idb } = await import('./js/db.js');
    const day = 86400000;
    const z = (n) => String(n).padStart(2, '0');
    const key = (d) => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
    const exportedAt = new Date(Date.now() - 20 * day).toISOString();
    await importAll({
      version: 3, exportedAt, idScheme: 'positional-v1',
      progress: [], mistakes: [], favorites: [], meta: [],
      daily: [0, 1].map((ago) => ({ date: key(new Date(Date.now() - ago * day)), studied: 4, correct: 4, wrong: 0, cards: 0 }))
    }, 'replace');
    const afterImport = (await idb.get('meta', 'lastExportAt'))?.v || null;
    return { exportedAt, afterImport };
  });
  await goP('#/home');
  const cardAfterImport = await hasCard();
  await p9.evaluate(async () => {
    const { resetAll } = await import('./js/store.js');
    await resetAll();
  });
  await goP('#/home');
  ok(imported.afterImport === imported.exportedAt && cardAfterImport && !(await hasCard()),
    '[B8] 匯入後 lastExportAt＝備份的 exportedAt；resetAll 清掉學習紀錄後不再提醒',
    JSON.stringify(imported));

  // B9：統計頁那一行照實寫 persisted() 的結果；navigator.storage 不存在也不能壞
  await p9.evaluate(() => localStorage.setItem('__persisted', '1'));
  await goP('#/stats');
  const yes9 = await p9.evaluate(() => document.getElementById('view').innerText);
  await p9.evaluate(() => localStorage.setItem('__persisted', '0'));
  await goP('#/stats');
  const no9 = await p9.evaluate(() => document.getElementById('view').innerText);
  ok(/已答應不會自動清掉/.test(yes9) && !/已答應不會自動清掉/.test(no9) && /可能在空間不足時清掉/.test(no9),
    '[B9] 持久儲存那一行：答應了與沒答應顯示不同且照實的句子');
  const p10 = await b.newPage();
  const e10 = [];
  p10.on('pageerror', (e) => e10.push('pageerror: ' + e.message));
  await p10.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'storage', { configurable: true, get: () => undefined });
  });
  await p10.goto(BASE + '#/stats', { waitUntil: 'networkidle2' });
  await p10.waitForFunction(() => document.querySelector('#view')?.children.length > 0, { timeout: 15000 }).catch(() => {});
  await sleep(500);
  const noApi = await p10.evaluate(() => document.getElementById('view').innerText);
  ok(/資料管理/.test(noApi) && /可能在空間不足時清掉/.test(noApi) && e10.length === 0,
    '[B9] 瀏覽器沒有 navigator.storage 時，統計頁照常畫出來且不報錯', e10.join(' | '));
  await p10.close();

  // 收尾：把這一節造出來的狀態清掉，避免污染後面的檢查
  await p9.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    for (const s of ['meta', 'daily', 'progress', 'mistakes', 'favorites']) await idb.clear(s);
  });
  ok(e9.length === 0, '備份提醒流程無 console 錯誤', e9.slice(0, 3).join(' | '));
  await p9.close();
}

/* ================= 22. 詞性篩選 ================= */
console.log('\n[22] 詞性篩選');
{
  const p11 = await b.newPage();
  await p11.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const e11 = [];
  p11.on('pageerror', (e) => e11.push('pageerror: ' + e.message));
  p11.on('console', (m) => { if (m.type() === 'error') e11.push('console: ' + m.text()); });
  const goQ = async (hash) => {
    await p11.goto('about:blank');
    await p11.goto(BASE + hash, { waitUntil: 'networkidle2' });
    await p11.waitForFunction(() => document.querySelector('#view')?.children.length > 0, { timeout: 15000 }).catch(() => {});
    await sleep(400);
  };
  // 換頁後等「這一頁特有的東西」出現；只等 #view 有子節點不夠——那在上一頁就已經成立
  const goWait = async (hash, pred, ...args) => {
    await p11.goto('about:blank');
    await p11.goto(BASE + hash, { waitUntil: 'networkidle2' });
    const found = await p11.waitForFunction(pred, { timeout: 15000 }, ...args).then(() => true).catch(() => false);
    await sleep(200);
    return found;
  };
  const idbReset = () => p11.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    for (const s of ['progress', 'mistakes', 'daily', 'favorites']) await idb.clear(s);
  });
  // 用 puppeteer 的滑鼠點畫面上的按鈕（不是改設定、也不是直接帶網址）
  const clickButton = async (src) => {
    const hd = await p11.evaluateHandle((s) => [...document.querySelectorAll('button')].find((x) => new RegExp(s).test(x.textContent.trim())) || null, src);
    const el = hd.asElement();
    if (!el) return false;
    // 先捲到畫面中央：按鈕若在下緣，會被固定的底部導覽列蓋住，滑鼠點到的是導覽列（實測點成了「複習」）
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(100);
    await el.click();
    return true;
  };
  const hasButton = (src) => [...document.querySelectorAll('button')].some((x) => new RegExp(src).test(x.textContent.trim()));
  await goQ('#/home');

  // S1 資料層：每一級每個選項的數字＝題庫實際數出來的筆數（T7：形容詞兩類雙向都不能互相命中）
  const s1 = await p11.evaluate(async () => {
    const d = await import('./js/data.js');
    const { countByPos, POS_OPTIONS } = await import('./js/pos.js');
    const iAdj = POS_OPTIONS.find((o) => o.key === 'i-adj');
    const naAdj = POS_OPTIONS.find((o) => o.key === 'na-adj');
    const out = { levels: {}, badMap: [], badMapRev: [], iPop: 0, naPop: 0 };
    for (const lv of d.LEVELS) {
      const list = await d.loadSet('vocab', lv);
      const counts = countByPos(list);
      // 各選項獨立數一次（不透過 countByPos），當對照
      const manual = {};
      for (const o of POS_OPTIONS) manual[o.key] = list.filter((x) => o.match(x.pos)).length;
      const dual = list.filter((x) => x.pos === '名詞・副詞').length;   // 名詞與副詞都會算到這一筆
      const sumMain = ['verb', 'i-adj', 'na-adj', 'noun', 'adv', 'other'].reduce((s, k) => s + counts[k], 0);
      out.levels[lv] = { total: list.length, counts, manual, dual, sumMain };
      // い形容詞不可以對到「形容動詞（な形）」
      if (list.some((x) => /形容動詞/.test(x.pos || '') && iAdj.match(x.pos))) out.badMap.push(lv);
      // 反向（T7）：「形容詞（い形）」不可以被な形容詞命中
      if (list.some((x) => /^形容詞/.test(x.pos || '') && naAdj.match(x.pos))) out.badMapRev.push(lv);
      out.iPop += list.filter((x) => /^形容詞/.test(x.pos || '')).length;
      out.naPop += list.filter((x) => /^形容動詞/.test(x.pos || '')).length;
    }
    return out;
  });
  const lvKeys = Object.keys(s1.levels);
  ok(lvKeys.length === 5 && lvKeys.every((lv) => s1.levels[lv].total > 0),
    '[S1 前置] 五級單字都載得到（母體非空）', JSON.stringify(lvKeys.map((lv) => s1.levels[lv].total)));
  ok(lvKeys.every((lv) => {
    const v = s1.levels[lv];
    return JSON.stringify(v.counts) === JSON.stringify(v.manual)   // 與逐項獨立數的結果一致
      && v.counts.all === v.total
      && v.sumMain === v.total + v.dual;                           // 「名詞・副詞」被名詞與副詞各算一次
  }) && s1.badMap.length === 0,
    '[S1] 各級各詞性的數字與題庫實際筆數相符；六類總和＝該級單字數＋「名詞・副詞」重複計數',
    JSON.stringify(lvKeys.map((lv) => ({ lv, total: s1.levels[lv].total, verb: s1.levels[lv].counts.verb, dual: s1.levels[lv].dual }))));
  ok(s1.iPop > 0 && s1.naPop > 0, `[T7 前置] 兩個方向的母體都非空：「形容詞（い形）」${s1.iPop} 個、「形容動詞（な形）」${s1.naPop} 個`);
  ok(s1.iPop > 0 && s1.naPop > 0 && s1.badMap.length === 0 && s1.badMapRev.length === 0,
    '[T7] い／な形容詞雙向不互相命中（「形容動詞」不算い形容詞、「形容詞（い形）」也不算な形容詞）',
    JSON.stringify({ badMap: s1.badMap, badMapRev: s1.badMapRev }));

  // 一般四選一的題幹是「單字」或「中文意思」兩種之一；對回題庫時只收唯一相符的，對不回來的不算進母體
  const bankN5 = await p11.evaluate(async () => {
    const d = await import('./js/data.js');
    return (await d.loadSet('vocab', 'N5')).map((x) => ({ id: x.id, kanji: x.kanji, kana: x.kana, meaning: x.meaning, pos: x.pos }));
  });
  const mapPrompt = (q) => {
    const hits = bankN5.filter((x) => (q.jp ? (x.kanji || x.kana) === q.text : x.meaning === q.text));
    return hits.length === 1 ? hits[0] : null;
  };
  const readPrompt = () => p11.evaluate(() => {
    const el = document.querySelector('.quiz-prompt > span');
    const cnt = document.querySelector('.study-count')?.textContent || '';
    return el ? { text: el.textContent, jp: el.classList.contains('jp'), cnt } : null;
  });
  const walkQuiz = async (hash, max = 20) => {
    const out = [];
    if (!(await goWait(hash, () => !!document.querySelector('.opt')))) return out;
    for (let i = 0; i < max; i++) {
      const q = await readPrompt();
      if (!q) break;
      out.push(q);
      const clicked = await p11.evaluate(() => {
        const o = document.querySelector('.opt:not([disabled])');
        if (!o) return false;
        o.click();
        return true;
      });
      if (!clicked) break;
      await p11.waitForSelector('.quiz-next', { timeout: 5000 }).catch(() => {});
      await p11.evaluate(() => document.querySelector('.quiz-next')?.click());
      // 等題號真的換了（或已經跑到結果頁）
      await p11.waitForFunction((prev) => {
        const c = document.querySelector('.study-count');
        return !c || c.textContent !== prev;
      }, { timeout: 5000 }, q.cnt).catch(() => {});
    }
    return out;
  };

  // S2 真實入口：閃卡帶 pos 只出該詞性
  const verbCount = s1.levels.N5.counts.verb;
  ok(verbCount >= 20, `[S2 前置] N5 動詞 ${verbCount} 個 ≥ 一輪 20 題`);
  // 閃卡：走真實畫面把整輪翻完，逐張讀卡片上的詞性標籤（閃卡以前根本沒傳 filter）
  await goQ('#/study?type=vocab&level=N5&mode=flash&scope=random&pos=verb');
  const flashKinds = [];
  for (let i = 0; i < 20; i++) {
    await p11.keyboard.press('Space');            // 翻卡（背面才有詞性標籤）
    await sleep(120);
    const pos = await p11.evaluate(() => document.querySelector('.flash-pos')?.textContent || null);
    if (pos === null) break;
    flashKinds.push(pos);
    await p11.keyboard.press('3');                // 「認得」→ 下一張
    await sleep(120);
  }
  ok(flashKinds.length >= 15, `[S2 前置] 閃卡這一輪真的翻到 ${flashKinds.length} 張卡（母體非空）`);
  ok(flashKinds.length >= 15 && flashKinds.every((k) => k === '動詞'),
    '[S2] 閃卡帶 pos=verb 時，整輪每一張都是動詞',
    JSON.stringify([...new Set(flashKinds)]));

  // T3 測驗那一半改走畫面（經過 quiz.js）：只帶詞性、不帶題型
  const t3Verb = (await walkQuiz('#/study?type=vocab&level=N5&mode=quiz&scope=random&pos=verb')).map(mapPrompt).filter(Boolean);
  const t3All = (await walkQuiz('#/study?type=vocab&level=N5&mode=quiz&scope=random')).map(mapPrompt).filter(Boolean);
  const t3AllKinds = [...new Set(t3All.map((x) => x.pos))];
  ok(t3Verb.length >= 10, `[T3 前置] 走真實入口、從畫面對回題庫的題目有 ${t3Verb.length} 題（≥ 10）`);
  ok(t3Verb.length >= 10 && t3Verb.every((x) => x.pos === '動詞'),
    '[T3] 一般四選一只帶 pos=verb（不帶題型）走 quiz.js：每一題都是動詞',
    JSON.stringify(t3Verb.filter((x) => x.pos !== '動詞').slice(0, 3).map((x) => `${x.kanji || x.kana}/${x.pos}`)));
  ok(t3AllKinds.length >= 2, `[T3 對照] 同一條路不帶 pos，一輪出現 ${t3AllKinds.length} 種詞性（≥ 2）`, JSON.stringify(t3AllKinds));

  // S3 與題型篩選並存——一定要走真實入口（quiz.js 才是組合兩個 filter 的地方）
  const s3pre = await p11.evaluate(async () => {
    const { canAskCloze } = await import('./js/qtypes.js');
    const d = await import('./js/data.js');
    const pool = await d.loadSet('vocab', 'N5');
    const verbs = pool.filter((x) => x.pos === '動詞');
    return {
      both: verbs.filter(canAskCloze).length,
      verbOnly: verbs.filter((x) => !canAskCloze(x)).length,   // 只套詞性、漏掉題型時會跑出來的那一批
      clozeOnly: pool.filter((x) => x.pos !== '動詞' && canAskCloze(x)).length
    };
  });
  ok(s3pre.both >= 4 && s3pre.verbOnly >= 10 && s3pre.clozeOnly >= 10,
    `[S3 前置] N5 交集 ${s3pre.both} 個非空，而且「只符合其中一個條件」的各有 ${s3pre.verbOnly}／${s3pre.clozeOnly} 個——兩種漏法都看得出來`);
  await goQ('#/study?type=vocab&level=N5&mode=quiz&scope=random&qtype=cloze&pos=verb');
  const prompts = [];
  for (let i = 0; i < 20; i++) {
    const t = await p11.evaluate(() => {
      const el = document.querySelector('.q-prompt') || document.querySelector('#view');
      return el ? el.textContent : '';
    });
    if (!t) break;
    prompts.push(t);
    const advanced = await p11.evaluate(() => {
      const opt = document.querySelector('.opt:not([disabled])');
      if (!opt) return false;
      opt.click();
      return true;
    });
    if (!advanced) break;
    await sleep(150);
    await p11.evaluate(() => document.querySelector('.quiz-next')?.click());
    await sleep(150);
  }
  const s3 = await p11.evaluate(async (texts) => {
    const { canAskCloze, findBlankSpan } = await import('./js/qtypes.js');
    const d = await import('./js/data.js');
    const pool = await d.loadSet('vocab', 'N5');
    // 題幹是「挖空後的例句」→ 用同一支 findBlankSpan 還原每個候選字的題幹，再比對回它是哪個字
    const byPrompt = [];
    for (const x of pool) {
      const sp = findBlankSpan(x);
      if (!sp) continue;
      byPrompt.push({ item: x, blanked: x.example.slice(0, sp.start) + '＿＿＿' + x.example.slice(sp.start + sp.text.length) });
    }
    const bad = [];
    let matched = 0;
    for (const t of texts) {
      // 短句可能是長句的後綴（「家を＿＿＿ます。」也出現在「毎朝七時に家を＿＿＿ます。」裡），
      // 所以取「相符之中最長的那一個」，不能用 find 拿第一個
      let hit = null;
      for (const e of byPrompt) {
        if (t.includes(e.blanked) && (!hit || e.blanked.length > hit.blanked.length)) hit = e;
      }
      if (!hit) continue;
      matched += 1;
      const x = hit.item;
      if (x.pos !== '動詞' || !canAskCloze(x)) bad.push({ w: x.kanji, pos: x.pos, cloze: canAskCloze(x) });
    }
    return { matched, bad };
  }, prompts);
  ok(s3.matched >= 5, `[S3 前置] 從畫面比對回題庫的題目有 ${s3.matched} 題（母體非空）`);
  ok(s3.matched >= 5 && s3.bad.length === 0,
    '[S3] 走真實入口「動詞＋例句填空」：每一題既是動詞、又適用填空題（不是後者蓋掉前者）',
    JSON.stringify(s3.bad.slice(0, 3)));

  // T2 點詞性按鈕（取代 S4 前半與 S5 的「記住」）：不預置 verb、不用網址帶 pos
  const VERB_BTN = '^動詞\\s+\\d+$';
  const posBtnState = () => p11.evaluate((vsrc) => {
    const btns = [...document.querySelectorAll('button')];
    const verb = btns.find((x) => new RegExp(vsrc).test(x.textContent.trim()));
    const all = btns.find((x) => x.textContent.trim() === '全部');
    return {
      hasVerb: !!verb, hasAll: !!all,
      verbOn: !!verb && !verb.classList.contains('secondary'),   // 沒有 secondary＝目前選中
      allOn: !!all && !all.classList.contains('secondary')
    };
  }, VERB_BTN);
  await p11.evaluate(async () => {
    const { setSetting } = await import('./js/store.js');
    await setSetting('lastPos', 'all');
  });
  await goWait('#/learn?type=vocab&level=N5', hasButton, VERB_BTN);
  const t2a = await posBtnState();
  ok(t2a.hasVerb && t2a.hasAll && t2a.allOn && !t2a.verbOn,
    '[T2 前置] lastPos 設回 all 後進學習頁，一進去選中的是「全部」', JSON.stringify(t2a));
  await clickButton(VERB_BTN);
  await sleep(300);
  const t2b = await posBtnState();
  ok(t2b.verbOn && !t2b.allOn, '[T2] 在畫面上點「動詞」→ 它變成選中、「全部」變成未選中', JSON.stringify(t2b));
  await clickButton('四選一測驗');
  await p11.waitForFunction(() => location.hash.startsWith('#/study'), { timeout: 5000 }).catch(() => {});
  const t2Hash = await p11.evaluate(() => location.hash);
  ok(/[?&]pos=verb(&|$)/.test(t2Hash), '[T2] 接著點「四選一測驗」→ 網址帶 pos=verb', t2Hash);
  await goWait('#/learn', hasButton, VERB_BTN);
  const t2c = await posBtnState();
  const t2Saved = await p11.evaluate(async () => {
    const { getSetting } = await import('./js/store.js');
    return getSetting('lastPos', null);
  });
  const learnHtml = await p11.evaluate(() => document.getElementById('view').innerText);
  ok(t2c.verbOn && !t2c.allOn && t2Saved === 'verb',
    '[T2] 回到不帶參數的學習頁仍選中動詞，且 lastPos 已存成 verb', JSON.stringify({ ...t2c, t2Saved }));

  // T6 畫面上的數字：逐顆讀詞性那一排的按鈕，跟題庫數出來的比；在畫面上切到 N1 後再比一次
  const SIX = ['verb', 'i-adj', 'na-adj', 'noun', 'adv', 'other'];
  const readPosNums = () => p11.evaluate(() => {
    const map = { '動詞': 'verb', 'い形容詞': 'i-adj', 'な形容詞': 'na-adj', '名詞': 'noun', '副詞': 'adv', '其他': 'other' };
    const out = {};
    for (const x of document.querySelectorAll('button')) {
      const m = /^(動詞|い形容詞|な形容詞|名詞|副詞|其他)\s+(\d+)$/.exec(x.textContent.trim());
      if (m) out[map[m[1]]] = Number(m[2]);
    }
    return out;
  });
  // 題庫 0 個的選項畫面上不顯示 → 那一格要「沒有按鈕」而不是「數字相等」
  const sameAsBank = (screen, bank) => SIX.every((k) => (bank[k] > 0 ? screen[k] === bank[k] : screen[k] === undefined));
  await goWait('#/learn?type=vocab&level=N5', hasButton, VERB_BTN);
  const n5Screen = await readPosNums();
  const n5Bank = s1.levels.N5.manual, n1Bank = s1.levels.N1.manual;
  ok(Object.keys(n5Screen).length === 6 && SIX.every((k) => n5Bank[k] > 0) && SIX.some((k) => n5Bank[k] !== n1Bank[k]),
    '[T6 前置] N5 畫面上除「全部」外有 6 顆詞性按鈕，且 N5 與 N1 至少一類筆數不同（不然看不出有沒有重算）',
    JSON.stringify({ n5Screen, n5Bank, n1Bank }));
  ok(sameAsBank(n5Screen, n5Bank), '[T6] N5 學習頁每顆詞性按鈕上的數字＝題庫實際筆數', JSON.stringify({ n5Screen, n5Bank }));
  await clickButton('^N1$');
  await p11.waitForFunction(() => {
    const x = [...document.querySelectorAll('button')].find((y) => y.textContent.trim() === 'N1');
    return x && !x.classList.contains('secondary');
  }, { timeout: 5000 }).catch(() => {});
  await sleep(200);
  const n1On = await p11.evaluate(() => {
    const x = [...document.querySelectorAll('button')].find((y) => y.textContent.trim() === 'N1');
    return !!x && !x.classList.contains('secondary');
  });
  const n1Screen = await readPosNums();
  ok(n1On && sameAsBank(n1Screen, n1Bank), '[T6] 在畫面上點 N1 之後，詞性按鈕的數字重算成 N1 題庫的筆數',
    JSON.stringify({ n1On, n1Screen, n1Bank }));

  // T4 其他入口不帶 pos（照 [19] 的做法：點下去看 location.hash）。lastPos＝verb 才是會漏的情境
  const t4pre = await p11.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    const st = await import('./js/store.js');
    const d = await import('./js/data.js');
    for (const s of ['progress', 'mistakes', 'daily', 'favorites']) await idb.clear(s);
    const items = (await d.loadSet('vocab', 'N5')).filter((x) => x.pos === '動詞').slice(0, 3);
    for (const it of items) {
      // 錯 3 次：進錯題本、作答次數也夠格上弱點清單
      for (let i = 0; i < 3; i++) await st.recordAnswer({ item: it, level: 'N5', type: 'vocab', grade: 'again' });
      await st.addFavorite(it);
      const r = await idb.get('progress', it.id);
      r.due = Date.now() - 60000;   // 讓它現在就到期 → 複習頁才有「測驗複習」
      await idb.put('progress', r);
    }
    await st.setSetting('lastPos', 'verb');
    return { n: items.length, lastPos: await st.getSetting('lastPos', null) };
  });
  const t4 = [];
  for (const [name, hash, src] of [
    ['複習', '#/review', '測驗複習'],
    ['錯題本', '#/mistakes', '^測驗這些題$'],
    ['收藏', '#/favorites', '^📝 測驗$'],
    ['弱點', '#/weak', '針對這'],
    ['旅行', '#/travel', '全部混合測驗']
  ]) {
    const found = await goWait(hash, hasButton, src);
    let hash2 = null;
    if (found && await clickButton(src)) {
      await p11.waitForFunction(() => location.hash.startsWith('#/study'), { timeout: 5000 }).catch(() => {});
      hash2 = await p11.evaluate(() => location.hash);
    }
    t4.push({ name, found, hash: hash2 });
  }
  ok(t4pre.n === 3 && t4pre.lastPos === 'verb' && t4.every((x) => x.found && /^#\/study/.test(x.hash || '')),
    '[T4 前置] lastPos＝verb；五個入口都真的點到開始練習的按鈕、真的進了 #/study', JSON.stringify({ t4pre, t4 }));
  ok(t4.every((x) => /^#\/study/.test(x.hash || '') && !/[?&]pos=/.test(x.hash)),
    '[T4] 複習／錯題本／收藏／弱點／旅行：點下去進 #/study，網址都不含 pos',
    t4.filter((x) => /[?&]pos=/.test(x.hash || '')).map((x) => `${x.name}: ${x.hash}`).join('; '));

  // T5 使用者真的走得到的空池：N3「其他」× 漢字讀音
  const t5pre = await p11.evaluate(async () => {
    const d = await import('./js/data.js');
    const { canAskReading } = await import('./js/qtypes.js');
    const { POS_OPTIONS } = await import('./js/pos.js');
    const other = POS_OPTIONS.find((o) => o.key === 'other');
    const list = (await d.loadSet('vocab', 'N3')).filter((x) => other.match(x.pos));
    return { other: list.length, both: list.filter(canAskReading).length };
  });
  ok(t5pre.other > 0 && t5pre.both === 0,
    `[T5 前置] N3「其他」有 ${t5pre.other} 個（畫面上選得到），其中適用漢字讀音題的是 ${t5pre.both} 個——必須是 0；題庫補了字這條會紅，提醒換一個情境`);
  const e5 = e11.length;
  const t5found = await goWait('#/study?type=vocab&level=N3&mode=quiz&qtype=reading&pos=other',
    () => !!document.querySelector('#view .empty, #view .opt'));
  const t5 = await p11.evaluate(() => {
    const e = document.querySelector('#view .empty');
    const back = e && [...e.querySelectorAll('button')].some((x) => /返回選擇/.test(x.textContent));
    return { empty: !!e, back: !!back, opts: document.querySelectorAll('#view .opt').length };
  });
  let t5Hash = null;
  if (t5.back && await clickButton('返回選擇')) {
    await p11.waitForFunction(() => location.hash.startsWith('#/learn'), { timeout: 5000 }).catch(() => {});
    t5Hash = await p11.evaluate(() => location.hash);
  }
  ok(t5found && t5.empty && t5.back && t5.opts === 0 && /^#\/learn/.test(t5Hash || '') && e11.length === e5,
    '[T5] 走得到的空池（N3 其他×漢字讀音）→ 空池畫面、「返回選擇」點了回學習頁、沒有 console 錯誤',
    JSON.stringify({ t5found, ...t5, t5Hash, newErrors: e11.slice(e5, e5 + 3) }));

  // S4 網址硬加 pos 給非一般題庫的來源 → 不理它，也不能壞
  await goQ('#/study?src=mistakes&mode=quiz&level=ALL&pos=verb');
  const posIgnored = await p11.evaluate(() => !/pageerror/i.test(document.body.innerText) && document.getElementById('view').children.length > 0);
  ok(posIgnored, '[S4] 非一般題庫的入口就算網址被加上 pos 也照常運作');

  // S5 該詞性為 0 時退回全部
  // 「這個詞性在這一級是 0 個」目前五級都不會發生（六類都 > 0，見 S1 的數字），
  // 所以退回「全部」這條路徑只能用合成的 counts 驗——這是學習頁實際呼叫的同一支函式。
  const zeroFallback = await p11.evaluate(async () => {
    const { resolvePos, countByPos } = await import('./js/pos.js');
    const d = await import('./js/data.js');
    let natural = 0;
    for (const lv of d.LEVELS) {
      const c = countByPos(await d.loadSet('vocab', lv));
      natural += ['verb', 'i-adj', 'na-adj', 'noun', 'adv', 'other'].filter((k) => c[k] === 0).length;
    }
    return {
      naturalZeros: natural,
      zeroGoesAll: resolvePos('other', { other: 0, verb: 5 }),   // 合成樣本：這一級沒有「其他」
      keepsWhenPresent: resolvePos('other', { other: 3, verb: 5 }),
      unknownGoesAll: resolvePos('nope', { verb: 5 })
    };
  });
  ok(zeroFallback.zeroGoesAll === 'all' && zeroFallback.keepsWhenPresent === 'other' && zeroFallback.unknownGoesAll === 'all',
    `[S5] 詞性在該級是 0 個就退回「全部」、還有字就保留（目前五級自然發生的 0 有 ${zeroFallback.naturalZeros} 個，所以用合成 counts 驗）`,
    JSON.stringify(zeroFallback));

  // S6 池子比一輪小：有幾題出幾題、不重複（0 題的空池改由 T5 從畫面守）
  const s6 = await p11.evaluate(async () => {
    const { buildSession } = await import('./js/session.js');
    const d = await import('./js/data.js');
    const { countByPos } = await import('./js/pos.js');
    // 找一個非 0 但小於 20 的詞性，當作「池子比題數小」的情境
    for (const lv of d.LEVELS) {
      const list = await d.loadSet('vocab', lv);
      const c = countByPos(list);
      const k = ['other', 'adv', 'na-adj', 'i-adj', 'verb'].find((x) => c[x] > 0 && c[x] < 20);
      if (k) {
        const { posFilter } = await import('./js/pos.js');
        const { items } = await buildSession({ type: 'vocab', level: lv, scope: 'random', src: 'set', filter: posFilter(k) });
        return { lv, k, pool: c[k], n: items.length, uniq: new Set(items.map((i) => i.id)).size };
      }
    }
    return null;
  });
  ok(s6 && s6.pool > 0 && s6.pool < 20, `[S6 前置] 找到比一輪 20 題小的池子：${JSON.stringify(s6)}`);
  ok(s6 && s6.n === s6.pool && s6.uniq === s6.n,
    '[S6] 池子比題數小 → 有幾題出幾題、沒有重複的 id', JSON.stringify(s6));
  await goQ('#/study?type=grammar&level=N5&mode=quiz&scope=random&pos=verb');
  const grammarWithPos = await p11.evaluate(() => document.getElementById('view').innerText.slice(0, 40));
  ok(grammarWithPos.length > 0,
    '[S6] 文法帶著 pos 也照常出題（文法沒有 pos，不會被篩成 0）', grammarWithPos);

  // S7 干擾選項優先同詞性
  const s7 = await p11.evaluate(async () => {
    const { buildDistractors } = await import('./js/session.js');
    const d = await import('./js/data.js');
    const pool = (await d.loadSet('vocab', 'N5')).filter((x) => x.pos === '動詞');
    let same = 0, total = 0, uniq = true;
    for (const item of pool.slice(0, 100)) {
      const ds = await buildDistractors(item, 'vocab', 'N5', 3, 'meaning');
      const vals = new Set([item.meaning, ...ds.map((x) => x.meaning)]);
      if (vals.size !== ds.length + 1) uniq = false;
      for (const x of ds) { total += 1; if (x.pos === item.pos) same += 1; }
    }
    return { poolVerbs: pool.length, same, total, ratio: total ? same / total : 0, uniq };
  });
  ok(s7.poolVerbs >= 4, `[S7 前置] N5 動詞 ${s7.poolVerbs} 個 ≥ 4`);
  ok(s7.ratio >= 0.95 && s7.uniq,
    `[S7] 動詞的干擾選項同詞性比例 ${(s7.ratio * 100).toFixed(1)}%（門檻 95%），且四個選項互異`,
    JSON.stringify(s7));

  // T1 SRS 不變（取代舊 S8）：從真實入口答對第一題，帶 pos 與不帶 pos 的進度變化要完全相同
  const firstCorrect = async (hash) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await idbReset();
      const before = await p11.evaluate(async () => (await (await import('./js/store.js')).allProgress()).length);
      if (!(await goWait(hash, () => !!document.querySelector('.opt')))) continue;
      const q = await readPrompt();
      const item = q && mapPrompt(q);
      if (!item) continue;   // 題幹對不回唯一一個字 → 重來一次（隨機出題，會換一題）
      const want = q.jp ? item.meaning : (item.kanji || item.kana);
      const clicked = await p11.evaluate((w) => {
        const o = [...document.querySelectorAll('.opt')].find((btn) => {
          const c = btn.cloneNode(true);
          c.querySelector('.opt-num')?.remove();
          return c.textContent.trim() === w;
        });
        if (!o) return false;
        o.click();
        return true;
      }, want);
      if (!clicked) continue;
      await p11.waitForSelector('.quiz-next', { timeout: 5000 }).catch(() => {});
      await sleep(200);
      const res = await p11.evaluate(async () => {
        const recs = await (await import('./js/store.js')).allProgress();
        return {
          gotCorrect: !!document.querySelector('.opt.correct') && !document.querySelector('.opt.wrong'),
          recs: recs.map((r) => ({ itemId: r.itemId, box: r.box, reps: r.reps, correct: r.correct, wrong: r.wrong }))
        };
      });
      return { attempt, before, item, ...res };
    }
    return null;
  };
  const t1a = await firstCorrect('#/study?type=vocab&level=N5&mode=quiz&scope=random&pos=verb');
  const t1b = await firstCorrect('#/study?type=vocab&level=N5&mode=quiz&scope=random');
  const only = (r) => (r && r.recs.length === 1 && r.recs[0].itemId === r.item.id ? r.recs[0] : null);
  const strip = (r) => (r ? JSON.stringify({ box: r.box, reps: r.reps, correct: r.correct, wrong: r.wrong }) : null);
  const brief = (r) => r && { w: r.item.kanji || r.item.kana, pos: r.item.pos, before: r.before, attempt: r.attempt, gotCorrect: r.gotCorrect, recs: r.recs.length };
  ok(t1a && t1b && t1a.before === 0 && t1b.before === 0 && t1a.gotCorrect && t1b.gotCorrect && t1a.item.pos === '動詞',
    '[T1 前置] 兩次都從畫面答對第一題；帶 pos=verb 那次答的確實是動詞；答題前都沒有任何進度紀錄',
    JSON.stringify({ a: brief(t1a), b: brief(t1b) }));
  ok(strip(only(t1a)) !== null && strip(only(t1a)) === strip(only(t1b))
    && strip(only(t1a)) === JSON.stringify({ box: 1, reps: 1, correct: 1, wrong: 0 }),
    '[T1] 從真實入口答對：帶 pos 與不帶 pos 的進度變化完全相同，都是新字第一次答對該有的值（box 1／reps 1／對 1／錯 0）',
    JSON.stringify({ a: strip(only(t1a)), b: strip(only(t1b)), recsA: t1a?.recs, recsB: t1b?.recs }));
  await idbReset();

  ok(e11.length === 0 && /詞性/.test(learnHtml), '[S2] 學習頁出現「詞性」那一排且全程無 console 錯誤', e11.slice(0, 3).join(' | '));
  await p11.close();
}

/* ================= 23. 拼寫練習（排假名方塊） ================= */
console.log('\n[23] 拼寫練習');
{
  const p12 = await b.newPage();
  await p12.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const e12 = [];
  p12.on('pageerror', (e) => e12.push('pageerror: ' + e.message));
  p12.on('console', (m) => { if (m.type() === 'error') e12.push('console: ' + m.text()); });
  const goWait = async (hash, pred, ...args) => {
    await p12.goto('about:blank');
    await p12.goto(BASE + hash, { waitUntil: 'networkidle2' });
    const found = await p12.waitForFunction(pred, { timeout: 15000 }, ...args).then(() => true).catch(() => false);
    await sleep(200);
    return found;
  };
  const idbReset = () => p12.evaluate(async () => {
    const { idb } = await import('./js/db.js');
    for (const s of ['progress', 'mistakes', 'daily', 'favorites']) await idb.clear(s);
  });
  // 真的用滑鼠點；先捲到畫面中央，免得被底部導覽列蓋住
  const clickEl = async (hd) => {
    const el = hd && hd.asElement();
    if (!el) return false;
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(60);
    await el.click();
    return true;
  };
  // 點一顆「還沒用過、字是 text」的方塊
  const clickTile = (text) => p12.evaluateHandle((t) => [...document.querySelectorAll('.spell-tile')].find((x) => !x.disabled && x.textContent === t) || null, text).then(clickEl);
  const clickSlot = (i) => p12.evaluateHandle((k) => document.querySelectorAll('.spell-slot')[k] || null, i).then(clickEl);
  const spellState = () => p12.evaluate(() => ({
    slots: [...document.querySelectorAll('.spell-slot')].map((x) => ({ t: x.textContent, cls: x.className })),
    tiles: [...document.querySelectorAll('.spell-tile')].map((x) => ({ t: x.textContent, used: x.disabled })),
    prompt: document.querySelector('.quiz-prompt > span')?.textContent || '',
    fb: document.querySelector('#fb')?.className || '',
    fbText: document.querySelector('#fb')?.textContent || '',
    next: !!document.querySelector('.quiz-next')
  }));
  await goWait('#/home', () => document.querySelector('#view')?.children.length > 0);

  // 題庫：每一級的單字（題幹是中文意思 → 對回題庫時只收唯一相符的）
  const bank = await p12.evaluate(async () => {
    const d = await import('./js/data.js');
    const k = await import('./js/kana.js');
    const out = {};
    for (const lv of d.LEVELS) {
      out[lv] = (await d.loadSet('vocab', lv)).map((x) => ({
        id: x.id, kanji: x.kanji, kana: x.kana, meaning: x.meaning, pos: x.pos, level: x.level,
        spell: k.canAskSpell(x), units: k.splitKana(x.kana)
      }));
    }
    return out;
  });
  const byMeaning = (lv, meaning) => {
    const hits = bank[lv].filter((x) => x.meaning === meaning);
    return hits.length === 1 ? hits[0] : null;
  };

  // P1 拆假名：期望值是手寫的
  const p1 = await p12.evaluate(async () => {
    const { splitKana } = await import('./js/kana.js');
    const cases = {
      'きょう': ['きょ', 'う'],
      'がっこう': ['が', 'っ', 'こ', 'う'],
      'コーヒー': ['コ', 'ー', 'ヒ', 'ー'],
      'しんぶん': ['し', 'ん', 'ぶ', 'ん'],
      'チョコレート': ['チョ', 'コ', 'レ', 'ー', 'ト'],
      'ファイル': ['ファ', 'イ', 'ル']
    };
    const bad = [];
    for (const [w, want] of Object.entries(cases)) {
      const got = splitKana(w);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ w, got, want });
    }
    // 含非假名字元 → 不適用（回 null），不要清掉再出
    for (const w of ['あ・い', 'かみ（紙）', '～ながら', 'あ い', 'ゃあ']) if (splitKana(w) !== null) bad.push({ w, got: splitKana(w), want: null });
    return bad;
  });
  ok(p1.length === 0, '[P1] 拆假名：拗音黏前字、促音／長音／撥音各一格；含「・」「（」「～」空白或小字開頭的回報不適用', JSON.stringify(p1.slice(0, 3)));

  // P2 全題庫掃一遍
  const p2 = (() => {
    const SMALL = /^[ゃゅょャュョァィゥェォぁぃぅぇぉゎヮ]$/;
    let total = 0, applicable = 0, independent = 0;
    const bad = [];
    const perLevel = {};
    for (const lv of Object.keys(bank)) {
      perLevel[lv] = 0;
      for (const x of bank[lv]) {
        total += 1;
        // 對照：不透過 splitKana，另外用「去掉小字後的字數」數一次拍數
        const pureKana = /^[ぁ-ゖゝゞァ-ヺーヽヾ]+$/.test(x.kana || '') && !SMALL.test((x.kana || '')[0] || '');
        const beats = (x.kana || '').replace(/[ゃゅょャュョァィゥェォぁぃぅぇぉゎヮ]/g, '').length;
        if (pureKana && beats >= 2 && beats <= 8) independent += 1;
        if (!x.spell) continue;
        applicable += 1; perLevel[lv] += 1;
        if (x.units.join('') !== x.kana) bad.push({ kana: x.kana, units: x.units, why: '接回去不等於原讀音' });
        if (x.units.some((u) => SMALL.test(u))) bad.push({ kana: x.kana, units: x.units, why: '有單獨的小字' });
      }
    }
    return { total, applicable, independent, perLevel, bad };
  })();
  ok(p2.total > 2000 && p2.applicable > 0, `[P2 前置] 全題庫 ${p2.total} 筆單字（母體非空），適用 ${p2.applicable} 筆`, JSON.stringify(p2.perLevel));
  ok(p2.bad.length === 0 && p2.applicable === p2.independent,
    `[P2] 每一筆適用的字拆完接回去＝原讀音、沒有單獨的小字；適用筆數與另一種數法相同（${JSON.stringify(p2.perLevel)}）`,
    JSON.stringify({ bad: p2.bad.slice(0, 3), applicable: p2.applicable, independent: p2.independent }));

  // P3 出題抽樣 400 題
  const p3 = await p12.evaluate(async () => {
    const d = await import('./js/data.js');
    const k = await import('./js/kana.js');
    const bad = [];
    let n = 0, confusedShare = 0, distractors = 0;
    for (const lv of d.LEVELS) {
      const pool = await d.loadSet('vocab', lv);
      const ok = pool.filter(k.canAskSpell);
      for (let i = 0; i < 80; i++) {
        const item = ok[(i * 37) % ok.length];
        const q = k.makeSpellQuestion(item, pool);
        if (!q) { bad.push({ kana: item.kana, why: '適用卻出不了題' }); continue; }
        n += 1;
        const count = (arr) => arr.reduce((m, u) => m.set(u, (m.get(u) || 0) + 1), new Map());
        const tileCount = count(q.tiles.map((t) => t.text));
        const unitCount = count(q.units);
        for (const [u, c] of unitCount) if ((tileCount.get(u) || 0) < c) bad.push({ kana: item.kana, why: `少了方塊 ${u}` });
        const extra = [];
        for (const [u, c] of tileCount) {
          const e = c - (unitCount.get(u) || 0);
          for (let j = 0; j < e; j++) extra.push(u);
        }
        const unitSet = new Set(q.units);
        if (extra.some((u) => unitSet.has(u))) bad.push({ kana: item.kana, why: '干擾方塊出現在正確答案裡', extra });
        if (new Set(extra).size !== extra.length) bad.push({ kana: item.kana, why: '干擾方塊重複', extra });
        if (q.tiles.length > 12) bad.push({ kana: item.kana, why: `方塊 ${q.tiles.length} 個 > 12` });
        if (extra.length !== k.distractorCount(q.units.length)) bad.push({ kana: item.kana, why: `干擾 ${extra.length} 個 ≠ ${k.distractorCount(q.units.length)}` });
        const conf = new Set(q.units.flatMap((u) => k.confusablesOf(u)));
        distractors += extra.length;
        confusedShare += extra.filter((u) => conf.has(u)).length;
      }
    }
    return { n, bad, confusedRatio: distractors ? confusedShare / distractors : 0 };
  });
  ok(p3.n === 400, `[P3 前置] 抽到的 ${p3.n} 題都適用、都出得了題`, JSON.stringify(p3.bad.filter((x) => x.why === '適用卻出不了題').slice(0, 3)));
  ok(p3.n === 400 && p3.bad.length === 0,
    `[P3] 方塊涵蓋正確答案的每一格（含重複次數）；干擾方塊都不在正確答案裡、不重複、數量＝max(3, ⌈n/2⌉)、總數 ≤ 12（干擾裡屬於混淆表的佔 ${(p3.confusedRatio * 100).toFixed(0)}%）`,
    JSON.stringify(p3.bad.slice(0, 3)));

  // P4 真實入口：學習頁點「拼寫練習」
  await idbReset();
  await p12.evaluate(async () => {
    const { setSetting } = await import('./js/store.js');
    await setSetting('lastPos', 'all');
  });
  await goWait('#/learn?type=vocab&level=N5', () => [...document.querySelectorAll('button')].some((x) => /拼寫練習/.test(x.textContent)));
  await p12.evaluateHandle(() => [...document.querySelectorAll('button')].find((x) => /拼寫練習/.test(x.textContent)) || null).then(clickEl);
  await p12.waitForFunction(() => location.hash.startsWith('#/study') && document.querySelector('.spell-slot'), { timeout: 15000 }).catch(() => {});
  const p4Hash = await p12.evaluate(() => location.hash);
  const p4a = await spellState();
  ok(/[?&]qtype=spell(&|$)/.test(p4Hash) && p4a.slots.length >= 2 && p4a.tiles.length > p4a.slots.length,
    '[P4] 學習頁點「拼寫練習」→ 網址帶 qtype=spell，出現答案列與方塊', JSON.stringify({ p4Hash, slots: p4a.slots.length, tiles: p4a.tiles.length }));

  // 從網址開一題、而且題幹對得回唯一一個字（隨機出題，對不回來就再開一次）
  const openMapped = async (hash, lv, want = () => true) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!(await goWait(hash, () => !!document.querySelector('.spell-slot')))) continue;
      const st = await spellState();
      const item = byMeaning(lv, st.prompt);
      if (item && item.spell && want(item)) return { st, item };
    }
    return null;
  };
  const SPELL_N5 = '#/study?type=vocab&level=N5&mode=quiz&scope=random&qtype=spell';
  // P4 答對
  await idbReset();
  const r4 = await openMapped(SPELL_N5, 'N5');
  let p4ok = null;
  if (r4) {
    for (const u of r4.item.units) await clickTile(u);
    await p12.waitForSelector('.quiz-next', { timeout: 5000 }).catch(() => {});
    const st = await spellState();
    const rec = await p12.evaluate(async (id) => (await (await import('./js/store.js')).getProgress(id)) || null, r4.item.id);
    p4ok = { st, rec };
  }
  ok(!!r4 && r4.st.slots.length === r4.item.units.length,
    '[P4 前置] 空格數＝正確單位數', JSON.stringify(r4 && { kana: r4.item.kana, slots: r4.st.slots.length, units: r4.item.units }));
  ok(!!p4ok && /\bok\b/.test(p4ok.st.fb) && p4ok.st.slots.every((s) => /correct/.test(s.cls)) && p4ok.rec && p4ok.rec.correct === 1 && p4ok.rec.wrong === 0,
    '[P4] 照正確順序點完 → 自動判定答對、每格標對、進度寫入（對 1／錯 0）',
    JSON.stringify(p4ok && { fb: p4ok.st.fb, rec: p4ok.rec }));
  // P4 答錯：第一格故意放一個干擾方塊，其餘照正確順序
  await idbReset();
  const r4w = await openMapped(SPELL_N5, 'N5');
  let p4bad = null;
  if (r4w) {
    const unitSet = new Set(r4w.item.units);
    const decoy = r4w.st.tiles.find((t) => !unitSet.has(t.t));
    await clickTile(decoy.t);
    for (const u of r4w.item.units.slice(1)) await clickTile(u);
    await p12.waitForSelector('.quiz-next', { timeout: 5000 }).catch(() => {});
    const st = await spellState();
    const rec = await p12.evaluate(async (id) => (await (await import('./js/store.js')).getProgress(id)) || null, r4w.item.id);
    p4bad = { st, rec, kana: r4w.item.kana };
  }
  ok(!!p4bad && /\bno\b/.test(p4bad.st.fb) && /wrong/.test(p4bad.st.slots[0].cls)
    && p4bad.st.slots.slice(1).every((s) => /correct/.test(s.cls))
    && p4bad.st.fbText.includes(`正確讀音：${p4bad.kana}`) && p4bad.rec && p4bad.rec.wrong === 1,
    '[P4] 故意點錯第一格 → 判定答錯、只標出錯的那一格、顯示正確讀音、進度記一次錯',
    JSON.stringify(p4bad && { fb: p4bad.st.fb, slots: p4bad.st.slots.map((s) => s.cls), rec: p4bad.rec }));

  // P5 退回：中間那格退回、其餘不動；填滿前不判定
  const r5 = await openMapped(SPELL_N5, 'N5', (x) => x.units.length >= 4);
  let p5 = null;
  if (r5) {
    const u = r5.item.units;
    for (const x of u.slice(0, 3)) await clickTile(x);
    const before = await spellState();
    await clickSlot(1);
    const after = await spellState();
    await clickTile(u[1]);   // 退回的方塊可以再用，而且填回第一個空格
    const again = await spellState();
    p5 = { u, before, after, again };
  }
  ok(!!r5, '[P5 前置] 找到 4 格以上的字（填 3 格還不會滿）', r5 ? r5.item.kana : '');
  ok(!!p5
    && p5.after.slots[1].t === '' && p5.after.slots[0].t === p5.u[0] && p5.after.slots[2].t === p5.u[2]
    && p5.after.tiles.filter((t) => t.t === p5.u[1] && !t.used).length >= 1
    && p5.again.slots[1].t === p5.u[1]
    && !p5.before.next && !p5.after.next && !p5.again.next && p5.again.fb === '',
    '[P5] 點答案列中間那格 → 它回到方塊區可再用、其他格不動；填滿前不判定',
    JSON.stringify(p5 && { after: p5.after.slots.map((s) => s.t), again: p5.again.slots.map((s) => s.t), next: p5.again.next }));

  // P6 判定前畫面上沒有漢字與讀音（方塊與答案格本來就是假名，排除掉再看）。
  // 中文意思本身就含有這個漢字寫法的字（例如「風」的意思就是「風」）不能拿來驗：題幹一定會出現它，
  // 那是中日共用漢字的本質、不是洩漏（2026-09-23 隨機抽到「風」時這條誤紅過）
  const r6 = await openMapped(SPELL_N5, 'N5',
    (x) => /[一-鿿]/.test(x.kanji || '') && x.kanji !== x.kana && !String(x.meaning || '').includes(x.kanji));
  const visibleText = () => p12.evaluate(() => {
    const c = document.getElementById('view').cloneNode(true);
    c.querySelectorAll('.spell-tiles, .spell-slots').forEach((x) => x.remove());
    return c.textContent;
  });
  let p6 = null;
  if (r6) {
    const pre = await visibleText();
    for (const u of r6.item.units) await clickTile(u);
    await p12.waitForSelector('.quiz-next', { timeout: 5000 }).catch(() => {});
    const post = await visibleText();
    p6 = { kanji: r6.item.kanji, kana: r6.item.kana, pre, post };
  }
  ok(!!p6, '[P6 前置] 找到有漢字寫法（且漢字≠讀音）的字', p6 ? p6.kanji : '');
  ok(!!p6 && !p6.pre.includes(p6.kanji) && !p6.pre.includes(p6.kana) && p6.post.includes(p6.kanji) && p6.post.includes(p6.kana),
    '[P6] 判定前題目畫面沒有該字的漢字與讀音；判定後（對照）兩者都出現',
    JSON.stringify(p6 && { kanji: p6.kanji, kana: p6.kana, pre: p6.pre.slice(0, 60) }));

  // P7 與詞性篩選並存：動詞＋拼寫
  const p7pre = bank.N5.filter((x) => x.pos === '動詞' && x.spell).length;
  const p7seen = [];
  if (await goWait('#/study?type=vocab&level=N5&mode=quiz&scope=random&qtype=spell&pos=verb', () => !!document.querySelector('.spell-slot'))) {
    for (let i = 0; i < 20; i++) {
      const st = await spellState();
      if (!st.slots.length) break;
      p7seen.push(st.prompt);
      const n = st.slots.length;
      for (let j = 0; j < n; j++) {
        await p12.evaluateHandle(() => document.querySelector('.spell-tile:not([disabled])')).then(clickEl);
      }
      await p12.waitForSelector('.quiz-next', { timeout: 5000 }).catch(() => {});
      const cnt = await p12.evaluate(() => document.querySelector('.study-count')?.textContent || '');
      await p12.evaluate(() => document.querySelector('.quiz-next')?.click());
      await p12.waitForFunction((prev) => { const c = document.querySelector('.study-count'); return !c || c.textContent !== prev; }, { timeout: 5000 }, cnt).catch(() => {});
    }
  }
  const p7mapped = p7seen.map((m) => byMeaning('N5', m)).filter(Boolean);
  ok(p7pre >= 20 && p7mapped.length >= 10, `[P7 前置] N5 動詞∩適用拼寫 ${p7pre} 個；從畫面對回題庫的有 ${p7mapped.length} 題`);
  ok(p7mapped.length >= 10 && p7mapped.every((x) => x.pos === '動詞' && x.spell),
    '[P7] 選「動詞」＋拼寫：每一題都是動詞、而且適用拼寫',
    JSON.stringify(p7mapped.filter((x) => !(x.pos === '動詞' && x.spell)).slice(0, 3).map((x) => x.kana)));

  // P8 版面：最長的適用字（8 格＋干擾）在 375、360 寬不溢出、點擊區 ≥ 44
  const longest = Object.values(bank).flat().filter((x) => x.spell && x.units.length === 8)[0];
  const p8 = [];
  if (longest) {
    for (const w of [375, 360]) {
      await p12.setViewport({ width: w, height: 800, isMobile: true, hasTouch: true });
      await idbReset();
      await p12.evaluate(async (id) => {
        const { findItem } = await import('./js/data.js');
        const { addFavorite } = await import('./js/store.js');
        await addFavorite((await findItem(id)).item);
      }, longest.id);
      // 收藏裡只有這一個字 → 從收藏開拼寫，保證挑到它
      await goWait('#/study?src=favorites&mode=quiz&qtype=spell', () => !!document.querySelector('.spell-slot'));
      p8.push(await p12.evaluate((width) => {
        const els = [...document.querySelectorAll('.spell-slot, .spell-tile')];
        const small = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width < 44 || r.height < 44).length;
        const out = els.filter((e) => { const r = e.getBoundingClientRect(); return r.left < 0 || r.right > width; }).length;
        return {
          width, slots: document.querySelectorAll('.spell-slot').length, tiles: document.querySelectorAll('.spell-tile').length,
          small, out, scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      }, w));
    }
    await p12.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  }
  ok(!!longest && p8.length === 2 && p8.every((r) => r.slots === 8 && r.tiles === 12),
    `[P8 前置] 真的挑到 8 格的字（${longest ? longest.kana : '無'}），畫面上 8 格＋12 顆方塊`, JSON.stringify(p8));
  ok(p8.length === 2 && p8.every((r) => r.small === 0 && r.out === 0 && !r.scroll),
    '[P8] 375px 與 360px：答案格與方塊的點擊區都 ≥ 44×44、沒有超出畫面、沒有橫向捲動', JSON.stringify(p8));

  // P9 SRS：拼寫答對／答錯對進度的影響，與漢字讀音題相同（都從真實畫面答）
  const answerReading = async (correct) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await idbReset();
      if (!(await goWait('#/study?type=vocab&level=N5&mode=quiz&scope=random&qtype=reading', () => !!document.querySelector('.opt')))) continue;
      const q = await p12.evaluate(() => ({
        prompt: document.querySelector('.quiz-prompt > span')?.textContent || '',
        opts: [...document.querySelectorAll('.opt')].map((b) => { const c = b.cloneNode(true); c.querySelector('.opt-num')?.remove(); return c.textContent.trim(); })
      }));
      // 題幹是漢字 → 正解是讀音；題幹是讀音 → 正解是漢字。只收唯一對得回的
      const hits = bank.N5.filter((x) => x.kanji === q.prompt || x.kana === q.prompt);
      if (hits.length !== 1) continue;
      const it = hits[0];
      const right = it.kanji === q.prompt ? it.kana : it.kanji;
      const target = correct ? right : q.opts.find((o) => o !== right);
      if (!q.opts.includes(right) || !target) continue;
      await p12.evaluateHandle((t) => [...document.querySelectorAll('.opt')].find((b) => { const c = b.cloneNode(true); c.querySelector('.opt-num')?.remove(); return c.textContent.trim() === t; }) || null, target).then(clickEl);
      await p12.waitForSelector('.quiz-next', { timeout: 5000 }).catch(() => {});
      return p12.evaluate(async (id) => (await (await import('./js/store.js')).getProgress(id)) || null, it.id);
    }
    return null;
  };
  const answerSpell = async (correct) => {
    await idbReset();
    const r = await openMapped(SPELL_N5, 'N5');
    if (!r) return null;
    const unitSet = new Set(r.item.units);
    if (correct) for (const u of r.item.units) await clickTile(u);
    else {
      await clickTile(r.st.tiles.find((t) => !unitSet.has(t.t)).t);
      for (const u of r.item.units.slice(1)) await clickTile(u);
    }
    await p12.waitForSelector('.quiz-next', { timeout: 5000 }).catch(() => {});
    return p12.evaluate(async (id) => (await (await import('./js/store.js')).getProgress(id)) || null, r.item.id);
  };
  const shape = (r) => (r ? JSON.stringify({ box: r.box, reps: r.reps, correct: r.correct, wrong: r.wrong, lapses: r.lapses }) : null);
  const p9 = {
    spellOk: shape(await answerSpell(true)), readOk: shape(await answerReading(true)),
    spellNo: shape(await answerSpell(false)), readNo: shape(await answerReading(false))
  };
  ok(Object.values(p9).every(Boolean), '[P9 前置] 拼寫與漢字讀音各答對、答錯一次，四筆進度都寫進去了', JSON.stringify(p9));
  ok(Object.values(p9).every(Boolean) && p9.spellOk === p9.readOk && p9.spellNo === p9.readNo && p9.spellOk !== p9.spellNo,
    '[P9] 拼寫答對／答錯對進度的影響與漢字讀音題相同', JSON.stringify(p9));
  await idbReset();

  ok(e12.length === 0, '[23] 拼寫練習全程無 console 錯誤', e12.slice(0, 3).join(' | '));
  await p12.close();
}

/* ================= 14. console ================= */
console.log('\n[14] Console');
ok(errs.length === 0, `全程 console 無錯誤`, errs.slice(0, 5).join(' | '));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (issues.length) {
  console.log('\n--- 需處理清單 ---');
  issues.forEach((i, n) => console.log(`${n + 1}. ${i}`));
}
await b.close();
