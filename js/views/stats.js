import { h, spinner, pct, progressBar, toast } from '../ui.js';
import { getManifest, getTravelManifest, TRAVEL_CATS, LEVELS } from '../data.js';
import { allProgress, allDaily, streak, todayKey, importAll, inspectBackup,
  resetAll, setSetting, getDailyGoal, setDailyGoal, allFavorites } from '../store.js';
import { downloadBackup, persistedState } from '../backup.js';
import { LEARNED_BOX, stageOf, tallyStages } from '../srs.js';
import { navigate } from '../router.js';
import { isSupported as ttsSupported, getAutoSpeak, setAutoSpeak, hasJapaneseVoice,
  getRatePref, setSpeechRate, speak } from '../speech.js';

export default async function statsView() {
  const wrap = h('div');
  wrap.append(spinner());

  const [man, tm, progAll, daily, st, goal, favs, autoSpeak] = await Promise.all([
    getManifest(), getTravelManifest(), allProgress(), allDaily(), streak(),
    getDailyGoal(), allFavorites(), getAutoSpeak()
  ]);
  wrap.replaceChildren();

  // 舊版本練過、現已隱藏的跨級別重複詞：不計入掌握度，否則會超過分母
  const dupSet = new Set(man.dupIds || []);
  const prog = progAll.filter((r) => !dupSet.has(r.itemId));

  // ---- 總覽（JLPT + 生活旅行 合計）----
  const stages = tallyStages(prog);
  const learned = stages.learned;
  const seen = prog.length;
  const totalCorrect = progAll.reduce((s, r) => s + (r.correct || 0), 0);
  const totalWrong = progAll.reduce((s, r) => s + (r.wrong || 0), 0);
  const acc = pct(totalCorrect, totalCorrect + totalWrong);
  const setCount = (s) => (s.activeCount ?? s.count); // 扣掉跨級別重複隱藏的條目
  const totalItems = man.sets.reduce((s, x) => s + setCount(x), 0) + (tm.total || 0);

  wrap.append(h('div', { class: 'stat-grid' }, [
    statCard('已掌握', learned, `答對 3 次以上`),
    statCard('學習中', stages.learning + stages.relearn, '正在往已掌握前進'),
    statCard('總正確率', acc + '%', `${totalCorrect} 對 / ${totalWrong} 錯`),
    statCard('連續天數', '🔥 ' + st, '每天學習就會累積')
  ]));
  // 「已掌握 0」最常見的原因不是沒學，是還沒隔天回來複習 → 直接把規則寫在這裡
  wrap.append(h('div', { class: 'card', style: 'padding:12px 14px' }, [
    h('div', { class: 'small muted', style: 'line-height:1.7' }, [
      h('b', { text: '「已掌握」怎麼算：' }),
      '同一個項目要答對 3 次。答對一次進「學習中」，' +
      '隔 1 天後再答對一次，再隔 2 天答對第三次才算已掌握——最快要跨 3 天。',
      h('br'),
      `目前學習過 ${seen} 項，涵蓋題庫 ${pct(seen, totalItems)}%（共 ${totalItems} 項）。` +
      (stages.relearn ? `其中 ${stages.relearn} 項答錯過、已重新排入複習。` : '')
    ])
  ]));

  // ---- 學習熱力圖 ----
  // 取代原本的 14 天長條圖：長條圖只看得到最近兩週，看不出「有沒有養成習慣」，
  // 而習慣才是語言學習的關鍵變數。顏色深淺對照使用者自己設的每日目標。
  wrap.append(h('div', { class: 'section-title', text: '學習熱力圖' }));
  wrap.append(heatmapCard(daily, goal));

  // ---- 各級別完成度 ----
  wrap.append(h('div', { class: 'section-title', text: '各級別掌握度' }));
  const totals = {};
  for (const s of man.sets) {
    totals[s.level] = totals[s.level] || { total: 0, learned: 0, seen: 0, vocab: 0, grammar: 0 };
    totals[s.level].total += setCount(s);
    totals[s.level][s.type] += setCount(s);
  }
  for (const r of prog) {
    if (!totals[r.level]) continue;
    totals[r.level].seen += 1;
    if (r.box >= LEARNED_BOX) totals[r.level].learned += 1;
  }
  for (const lv of LEVELS) {
    const t = totals[lv] || { total: 0, learned: 0, seen: 0 };
    wrap.append(h('div', { class: 'card', style: 'padding:12px 14px' }, [
      h('div', { class: 'row spread', style: 'margin-bottom:6px' }, [
        h('div', { class: 'row', style: 'gap:8px' }, [
          h('span', { class: `pill ${lv.toLowerCase()}`, text: lv }),
          h('span', { class: 'small muted', text: `${t.learned}/${t.total} 掌握・${t.seen} 學過` })
        ]),
        h('span', { class: 'small muted', text: `${pct(t.learned, t.total)}%` })
      ]),
      progressBar(t.learned, t.total, t.total > 0 && t.learned === t.total)
    ]));
  }

  // ---- 生活旅行掌握度（與 JLPT 分開顯示）----
  if (tm.sets && tm.sets.length) {
    const tvStat = {};
    for (const s of tm.sets) tvStat[s.cat] = { total: s.count, learned: 0, seen: 0 };
    for (const r of prog) {
      if (r.type !== 'travel') continue;
      const m = /^tv-([puk])-/.exec(r.itemId);
      const cat = m ? { p: 'phrases', u: 'usage', k: 'kanji' }[m[1]] : null;
      if (!tvStat[cat]) continue;
      tvStat[cat].seen += 1;
      if (r.box >= LEARNED_BOX) tvStat[cat].learned += 1;
    }
    wrap.append(h('div', { class: 'section-title', text: '生活旅行掌握度' }));
    for (const c of TRAVEL_CATS) {
      const t = tvStat[c.key] || { total: 0, learned: 0, seen: 0 };
      wrap.append(h('div', { class: 'card', style: 'padding:12px 14px' }, [
        h('div', { class: 'row spread', style: 'margin-bottom:6px' }, [
          h('div', { class: 'row', style: 'gap:8px' }, [
            h('span', { class: 'pill travel', text: c.icon }),
            h('span', { class: 'small muted', text: `${c.label}　${t.learned}/${t.total} 掌握・${t.seen} 學過` })
          ]),
          h('span', { class: 'small muted', text: `${pct(t.learned, t.total)}%` })
        ]),
        progressBar(t.learned, t.total, t.total > 0 && t.learned === t.total)
      ]));
    }
    wrap.append(h('button', { class: 'btn ghost', style: 'margin-top:8px', onclick: () => navigate('/travel') }, '前往生活旅行 →'));
  }

  // ---- 設定 ----
  wrap.append(h('div', { class: 'section-title', text: '設定' }));
  const settings = h('div', { class: 'card' });

  // 每日目標
  const goalVal = h('span', { class: 'small', style: 'font-variant-numeric:tabular-nums', text: `${goal} 題` });
  const goalRange = h('input', {
    type: 'range', min: '5', max: '100', step: '5', value: String(goal),
    class: 'range', 'aria-label': '每日目標題數'
  });
  goalRange.addEventListener('input', () => { goalVal.textContent = `${goalRange.value} 題`; });
  goalRange.addEventListener('change', async () => {
    await setDailyGoal(Number(goalRange.value));
    toast('已更新每日目標');
  });
  settings.append(h('div', { class: 'toggle-line' }, [
    h('span', {}, '每日學習目標'), goalVal
  ]));
  settings.append(goalRange);

  // 朗讀
  if (ttsSupported()) {
    const cb = h('input', { type: 'checkbox', class: 'switch', ...(autoSpeak ? { checked: 'checked' } : {}) });
    cb.addEventListener('change', async () => { await setAutoSpeak(cb.checked); });
    settings.append(h('label', { class: 'toggle-line', style: 'margin-top:6px' }, [
      h('span', {}, [
        '翻開閃卡時自動朗讀日文',
        hasJapaneseVoice() ? null : h('div', { class: 'small muted', text: '（此裝置未偵測到日文語音，可能無法發音）' })
      ]),
      cb
    ]));

    // 朗讀語速
    const rateVal = h('span', { class: 'small', style: 'font-variant-numeric:tabular-nums', text: `${getRatePref().toFixed(2)}×` });
    const rateRange = h('input', {
      type: 'range', min: '0.6', max: '1.1', step: '0.05', value: String(getRatePref()),
      class: 'range', 'aria-label': '朗讀語速'
    });
    rateRange.addEventListener('input', () => { rateVal.textContent = `${Number(rateRange.value).toFixed(2)}×`; });
    rateRange.addEventListener('change', async () => {
      await setSpeechRate(Number(rateRange.value));
      speak('日本語の発音、これくらいの速さです');
      toast('已更新朗讀語速');
    });
    settings.append(h('div', { class: 'toggle-line', style: 'margin-top:6px' }, [
      h('span', {}, '朗讀語速'), rateVal
    ]));
    settings.append(rateRange);
  } else {
    settings.append(h('p', { class: 'small muted', style: 'margin:6px 0 0', text: '此瀏覽器不支援語音朗讀。' }));
  }

  settings.append(h('div', { class: 'toggle-line', style: 'margin-top:6px' }, [
    h('span', {}, '使用說明'),
    h('button', {
      class: 'btn sm secondary',
      onclick: async () => { await setSetting('seenGuide', false); navigate('/home'); }
    }, '重看引導 →')
  ]));

  settings.append(h('div', { class: 'toggle-line', style: 'margin-top:6px' }, [
    h('span', {}, '弱點清單'),
    h('button', { class: 'btn sm secondary', onclick: () => navigate('/weak') }, '看最學不起來的 →')
  ]));

  settings.append(h('div', { class: 'toggle-line', style: 'margin-top:6px' }, [
    h('span', {}, '重點複習項目'),
    h('button', { class: 'btn sm secondary', onclick: () => navigate('/favorites'), text: `${favs.length} 項 →` })
  ]));
  wrap.append(settings);

  // ---- 資料管理 ----
  wrap.append(h('div', { class: 'section-title', text: '資料管理' }));
  const mgmt = h('div', { class: 'card' });
  mgmt.append(h('button', { class: 'btn secondary', style: 'margin-bottom:10px', onclick: doExport }, '⬇️ 匯出學習資料（JSON）'));

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: doImport });
  mgmt.append(fileInput);
  mgmt.append(h('button', { class: 'btn secondary', style: 'margin-bottom:10px', onclick: () => fileInput.click() }, '⬆️ 匯入學習資料'));
  mgmt.append(h('button', { class: 'btn ghost', style: 'color:var(--bad);border-color:var(--bad)', onclick: doReset }, '🗑 重置所有進度'));
  // 持久儲存：照實寫瀏覽器答應了什麼，不要講成「資料安全了」
  const persistLine = h('div', { class: 'small muted', style: 'margin-top:10px' }, '　');
  mgmt.append(persistLine);
  refreshPersistLine();
  wrap.append(mgmt);

  wrap.append(h('p', { class: 'small muted', style: 'text-align:center;margin-top:16px' }, 'JLPT 練習 v1.14.0・資料僅儲存在此瀏覽器'));

  async function doExport() {
    try {
      await downloadBackup();
    } catch (err) {
      toast('匯出失敗：' + err.message);   // 失敗就不會記 lastExportAt，提醒卡會留著
      return;
    }
    toast('已匯出');
    refreshPersistLine();
  }
  function refreshPersistLine() {
    persistedState().then((v) => {
      persistLine.textContent = v
        ? '💾 這個瀏覽器已答應不會自動清掉這裡的資料（你自己清除瀏覽資料或移除 App 時仍然會清掉）'
        : '⚠️ 這個瀏覽器可能在空間不足時清掉這裡的資料，請定期匯出備份';
    });
  }
  async function doImport(e) {
    const file = e.target.files[0];
    e.target.value = ''; // 讓同一個檔案可以再選一次
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      const info = inspectBackup(obj); // 先驗格式，過了才問使用者
      const when = info.exportedAt ? new Date(info.exportedAt).toLocaleString('zh-TW') : '時間不明';
      const okGo = confirm(
        `要還原這份備份嗎？\n\n` +
        `備份時間：${when}\n` +
        `進度 ${info.progress} 筆・錯題 ${info.mistakes} 筆・最愛 ${info.favorites} 筆・每日紀錄 ${info.daily} 天\n\n` +
        `⚠️ 目前裝置上的學習資料會被這份備份「取代」，不是合併。`
      );
      if (!okGo) return;
      await importAll(obj, 'replace');
      toast('已還原備份');
      statsView().then((n) => document.getElementById('view').replaceChildren(n));
    } catch (err) {
      toast('匯入失敗：' + err.message);
    }
  }
  async function doReset() {
    if (!confirm('確定要清除所有學習進度、錯題與統計嗎？此動作無法復原。')) return;
    await resetAll();
    toast('已重置');
    statsView().then((n) => document.getElementById('view').replaceChildren(n));
  }

  return wrap;
}

function statCard(label, value, sub) {
  return h('div', { class: 'card', style: 'margin-bottom:0' }, [
    h('div', { class: 'small muted', text: label }),
    h('div', { class: 'big-num', style: 'font-size:24px', text: String(value) }),
    h('div', { class: 'small muted', text: sub })
  ]);
}

/* ---------- 學習熱力圖 ----------
 * 深淺對照使用者自己設的每日目標，而不是「當期最大值」——
 * 用相對最大值上色的話，今天只答 3 題但那是本週最多，就會變成最深色，
 * 看起來像很認真，其實沒達標，圖就失去意義了。
 */
const HM_LEVELS = 4;

export function heatmapData(daily, goal, now = Date.now()) {
  const DAY = 86400000;
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  // 新使用者不必看一整年的空格：有資料的最早一天決定要畫多久（12～53 週）
  const firstKey = daily.length ? daily[0].date : todayKey(today);
  const first = new Date(`${firstKey}T00:00:00`);
  const spanDays = Math.max(1, Math.round((today - first) / DAY) + 1);
  const weeks = Math.min(53, Math.max(12, Math.ceil(spanDays / 7) + 1));

  // 先把最後一欄對到「本週」，再往前數 weeks 週。
  // 反過來做（先退 weeks 週再對齊週日）會讓起點又往前移最多 6 天，
  // 結果格子涵蓋不到今天——今天學了卻看不到，圖就是壞的。
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));   // 本週週六
  const start = new Date(end);
  start.setDate(start.getDate() - (weeks * 7 - 1));  // 必落在週日

  const cols = [];
  let totalQ = 0, activeDays = 0, best = 0, run = 0;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + dow);
      if (d > today) { col.push(null); continue; }   // 未來的格子留白
      const key = todayKey(d);
      const rec = byDate.get(key);
      const q = rec?.studied || 0;
      const cards = rec?.cards || 0;
      // streak() 把「只翻閃卡」也算學習，熱力圖跟著算，兩處才不會對不上
      const level = q <= 0 ? (cards > 0 ? 1 : 0)
        : q < goal * 0.5 ? 1 : q < goal ? 2 : q < goal * 2 ? 3 : HM_LEVELS;
      col.push({ key, q, cards, level });
      totalQ += q;
      if (level > 0) { activeDays += 1; run += 1; if (run > best) best = run; } else run = 0;
    }
    cols.push(col);
  }
  return { cols, weeks, totalQ, activeDays, bestStreak: best };
}

function heatmapCard(daily, goal) {
  const hm = heatmapData(daily, goal);
  const td = daily.find((d) => d.date === todayKey()) || {};

  // 月份標籤：只在該欄是某個月的第一週時標出來
  const months = h('div', { class: 'hm-months' });
  let lastM = -1;
  hm.cols.forEach((col) => {
    const firstReal = col.find(Boolean);
    let label = '';
    if (firstReal) {
      const m = new Date(`${firstReal.key}T00:00:00`).getMonth();
      if (m !== lastM) { label = `${m + 1}月`; lastM = m; }
    }
    months.append(h('div', { class: 'hm-mcol', text: label }));
  });

  const grid = h('div', {
    class: 'hm-grid', role: 'img',
    'aria-label': `學習熱力圖：近 ${hm.weeks} 週有 ${hm.activeDays} 天學習，` +
      `共作答 ${hm.totalQ} 題，最長連續 ${hm.bestStreak} 天`
  });
  hm.cols.forEach((col) => {
    const c = h('div', { class: 'hm-col' });
    col.forEach((cell) => {
      c.append(h('i', {
        class: 'hm-c l' + (cell ? cell.level : 0) + (cell ? '' : ' none'),
        title: cell ? `${cell.key}：作答 ${cell.q} 題${cell.cards ? `・閃卡 ${cell.cards} 次` : ''}` : ''
      }));
    });
    grid.append(c);
  });

  const legend = h('div', { class: 'hm-legend small muted' }, [
    h('span', { text: '少' }),
    ...[0, 1, 2, 3, 4].map((l) => h('i', { class: 'hm-c l' + l })),
    h('span', { text: '多' }),
    h('span', { style: 'margin-left:auto', text: `每格深淺對照每日目標 ${goal} 題` })
  ]);

  return h('div', { class: 'card' }, [
    months, grid, legend,
    h('div', { class: 'small muted', style: 'margin-top:8px' },
      `今日作答 ${td.studied || 0} 題・閃卡翻看 ${td.cards || 0} 次　|　` +
      `近 ${hm.weeks} 週學習 ${hm.activeDays} 天・最長連續 ${hm.bestStreak} 天・累計 ${hm.totalQ} 題`)
  ]);
}
