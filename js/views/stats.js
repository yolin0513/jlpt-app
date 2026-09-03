import { h, spinner, pct, progressBar, toast } from '../ui.js';
import { getManifest, getTravelManifest, TRAVEL_CATS, LEVELS } from '../data.js';
import { allProgress, allDaily, streak, todayKey, exportAll, importAll, resetAll,
  getDailyGoal, setDailyGoal, allFavorites } from '../store.js';
import { LEARNED_BOX } from '../srs.js';
import { navigate } from '../router.js';
import { isSupported as ttsSupported, getAutoSpeak, setAutoSpeak, hasJapaneseVoice } from '../speech.js';

export default async function statsView() {
  const wrap = h('div');
  wrap.append(spinner());

  const [man, tm, prog, daily, st, goal, favs, autoSpeak] = await Promise.all([
    getManifest(), getTravelManifest(), allProgress(), allDaily(), streak(),
    getDailyGoal(), allFavorites(), getAutoSpeak()
  ]);
  wrap.replaceChildren();

  // ---- 總覽（JLPT + 生活旅行 合計）----
  const learned = prog.filter((r) => r.box >= LEARNED_BOX).length;
  const seen = prog.length;
  const totalCorrect = prog.reduce((s, r) => s + (r.correct || 0), 0);
  const totalWrong = prog.reduce((s, r) => s + (r.wrong || 0), 0);
  const acc = pct(totalCorrect, totalCorrect + totalWrong);
  const totalItems = man.sets.reduce((s, x) => s + x.count, 0) + (tm.total || 0);

  wrap.append(h('div', { class: 'stat-grid' }, [
    statCard('已掌握', learned, `題庫共 ${totalItems}`),
    statCard('學習過', seen, `涵蓋 ${pct(seen, totalItems)}%`),
    statCard('總正確率', acc + '%', `${totalCorrect} 對 / ${totalWrong} 錯`),
    statCard('連續天數', '🔥 ' + st, '每天學習就會累積')
  ]));

  // ---- 每日學習量（近 14 天）----
  wrap.append(h('div', { class: 'section-title', text: '每日學習量（近 14 天）' }));
  const days = last14();
  const map = new Map(daily.map((d) => [d.date, d]));
  const maxV = Math.max(1, ...days.map((k) => (map.get(k)?.studied || 0) + (map.get(k)?.cards || 0)));
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'chart-bars' }, days.map((k) => {
      const d = map.get(k) || { studied: 0, cards: 0 };
      const v = d.studied + d.cards;
      return h('div', {}, [
        h('div', { class: 'cbwrap' }, [
          h('div', { class: 'cb', style: `height:${v ? Math.max(4, Math.round((v / maxV) * 100)) : 0}%`, title: `${k}：${v}` })
        ]),
        h('div', { class: 'cl', text: k.slice(8) })
      ]);
    })),
    h('div', { class: 'small muted', style: 'margin-top:8px', text: `今日 ${(map.get(todayKey())?.studied || 0)} 題作答、${(map.get(todayKey())?.cards || 0)} 次翻卡` })
  ]));

  // ---- 各級別完成度 ----
  wrap.append(h('div', { class: 'section-title', text: '各級別掌握度' }));
  const totals = {};
  for (const s of man.sets) {
    totals[s.level] = totals[s.level] || { total: 0, learned: 0, seen: 0, vocab: 0, grammar: 0 };
    totals[s.level].total += s.count;
    totals[s.level][s.type] += s.count;
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
  } else {
    settings.append(h('p', { class: 'small muted', style: 'margin:6px 0 0', text: '此瀏覽器不支援語音朗讀。' }));
  }

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
  wrap.append(mgmt);

  wrap.append(h('p', { class: 'small muted', style: 'text-align:center;margin-top:16px' }, 'JLPT 練習 v1.2.0・資料僅儲存在此瀏覽器'));

  async function doExport() {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jlpt-progress-${todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已匯出');
  }
  async function doImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      await importAll(obj);
      toast('匯入完成');
      navigate('/stats');
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

function last14() {
  const out = [];
  const d = new Date();
  for (let i = 13; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push(todayKey(x));
  }
  return out;
}
