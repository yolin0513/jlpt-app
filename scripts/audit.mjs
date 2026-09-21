/* 全面功能檢測回歸套件（113 項）
 * 用法：先跑 python scripts/serve.py，再 node scripts/audit.mjs [baseUrl]
 * 涵蓋 verify-full 沒測到的：資料層一致性、掌握度分母、路由健壯性、
 * 匯出匯入、孤兒紀錄、搜尋、收藏即時性、重置、SRS 邊界、聽力、特殊題型、模擬考、備份提醒。
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

const b = await puppeteer.launch({ headless: true, userDataDir: path.join(tmpdir(), 'audit-' + Date.now()), args: ['--no-sandbox'] });
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
const d1 = await p.evaluate(async () => {
  const d = await import('./js/data.js');
  const man = await d.getManifest();
  const out = { levels: {} };
  for (const lv of d.LEVELS) {
    for (const t of ['vocab', 'grammar']) {
      const set = man.sets.find((s) => s.type === t && s.level === lv);
      const list = await d.loadSet(t, lv);
      out.levels[`${lv}-${t}`] = {
        manCount: set.count, manActive: set.activeCount,
        loadSetLen: list.length, loadSetDup: list.filter((x) => x.dup).length
      };
    }
  }
  const many = await d.loadMany('vocab', d.LEVELS);
  out.loadManyDup = many.filter((x) => x.dup).length;
  out.totalItems = man.totalItems; out.activeItems = man.activeItems;
  return out;
});
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

/* ================= 14. console ================= */
console.log('\n[14] Console');
ok(errs.length === 0, `全程 console 無錯誤`, errs.slice(0, 5).join(' | '));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (issues.length) {
  console.log('\n--- 需處理清單 ---');
  issues.forEach((i, n) => console.log(`${n + 1}. ${i}`));
}
await b.close();
