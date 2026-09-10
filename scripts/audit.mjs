/* 全面功能檢測回歸套件（45 項）
 * 用法：先跑 python scripts/serve.py，再 node scripts/audit.mjs [baseUrl]
 * 涵蓋 verify-full 沒測到的：資料層一致性、掌握度分母、路由健壯性、
 * 匯出匯入、孤兒紀錄、搜尋、收藏即時性、重置、SRS 邊界。
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
const go = async (h) => { await p.goto('about:blank'); await p.goto(BASE + h, { waitUntil: 'networkidle2' }); await sleep(500); };

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
  await s.resetAll();
  const after = {
    prog: (await s.allProgress()).length,
    mis: (await s.allMistakes()).length,
    fav: (await s.allFavorites()).length,
    daily: (await s.allDaily()).length,
    seenGuide: await s.getSetting('seenGuide', false),
    goal: await s.getDailyGoal()
  };
  return after;
});
ok(reset.prog === 0 && reset.mis === 0 && reset.fav === 0 && reset.daily === 0, '重置清空進度/錯題/最愛/每日');
ok(reset.seenGuide === true, '重置保留設定（seenGuide/目標/主題）', '副作用：重置後首次引導不會再出現');

await go('#/home');
const guideAfterReset = await p.evaluate(() => !!document.querySelector('.guide-card'));
ok(!guideAfterReset, '重置後首頁不再顯示引導（已知行為）', guideAfterReset ? '有顯示' : '未顯示 — 新手引導無法重看');

/* ================= 14. console ================= */
console.log('\n[14] Console');
ok(errs.length === 0, `全程 console 無錯誤`, errs.slice(0, 5).join(' | '));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (issues.length) {
  console.log('\n--- 需處理清單 ---');
  issues.forEach((i, n) => console.log(`${n + 1}. ${i}`));
}
await b.close();
