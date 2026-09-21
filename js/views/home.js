import { h, progressBar, pct, spinner } from '../ui.js';
import { getManifest, getTravelManifest, LEVELS } from '../data.js';
import { progressMap, dailyFor, streak, getDailyGoal, allFavorites, getSetting, setSetting,
  backupReminder, snoozeBackupReminder } from '../store.js';
import { downloadBackup } from '../backup.js';
import { toast } from '../ui.js';
import { idb } from '../db.js';
import { LEARNED_BOX, stageOf, forecast } from '../srs.js';
import { navigate } from '../router.js';

export default async function homeView() {
  const wrap = h('div');
  wrap.append(spinner());

  const [man, tm, pmap, today, st, due, goal, favs, seenGuide, backup] = await Promise.all([
    getManifest(),
    getTravelManifest(),
    progressMap(),
    dailyFor(),
    streak(),
    idb.dueProgress(),
    getDailyGoal(),
    allFavorites(),
    getSetting('seenGuide', false),
    backupReminder()
  ]);
  wrap.replaceChildren();

  // ---- 首次使用引導（也可從「統計 → 設定 → 重看引導」叫回來）----
  if (!seenGuide) {
    const guide = h('div', { class: 'card guide-card' }, [
      h('div', { class: 'row spread' }, [
        h('div', { class: 'tile-title', text: '👋 歡迎使用 JLPT 練習' }),
        h('button', { class: 'icon-btn', 'aria-label': '關閉', onclick: async () => { await setSetting('seenGuide', true); guide.remove(); } }, '✕')
      ]),
      h('ol', { class: 'guide-list' }, [
        h('li', {}, '「學習」挑級別與範圍，用閃卡或四選一測驗練習'),
        h('li', {}, '答錯的會進「錯題本」，並依間隔重複在「複習」提醒你'),
        h('li', {}, '點 ☆ 收藏重點單字、🔍 搜尋、🔊 朗讀日文'),
        h('li', {}, '「統計」看每日學習量與各級掌握度，可設定每日目標')
      ]),
      h('button', { class: 'btn', onclick: () => navigate('/learn') }, '開始第一輪練習')
    ]);
    wrap.append(guide);
  }

  // ---- 今日概況 ----
  const doneToday = today.studied;
  wrap.append(h('div', { class: 'card' }, [
    h('div', { class: 'row spread' }, [
      h('div', {}, [
        h('div', { class: 'small muted', text: '今日學習' }),
        h('div', { class: 'big-num', text: String(doneToday) }),
        h('button', { class: 'linklike small muted', onclick: () => navigate('/stats'), text: `目標 ${goal} 題 ·調整` })
      ]),
      h('div', { style: 'text-align:right' }, [
        h('div', { class: 'small muted', text: '連續天數' }),
        h('div', { class: 'big-num', text: `🔥 ${st}` })
      ])
    ]),
    h('div', { style: 'margin-top:12px' }, [progressBar(Math.min(doneToday, goal), goal, doneToday >= goal)]),
    doneToday >= goal ? h('div', { class: 'small', style: 'color:var(--good);margin-top:6px', text: '🎯 今日目標達成！' }) : null
  ]));

  // ---- 備份提醒 ----
  // 學習進度只存在這一個瀏覽器，沒有後端也沒有第二份。太久沒匯出、而且這段期間真的有練，
  // 才提醒一次；放在今日概況之後、待複習之前，不擋主要動線。
  if (backup.show) {
    const card = h('div', { class: 'card guide-card' }, [
      h('div', { class: 'tile-title', text: '💾 該備份學習進度了' }),
      h('p', { class: 'small', style: 'margin:6px 0 10px' }, backup.never
        ? `你已經學了 ${backup.studyDays} 天，但還沒有匯出過備份。學習進度只存在這台裝置的這個瀏覽器裡，沒有別的副本；換裝置、清除瀏覽資料或移除 App 都會一起消失。`
        : `上次匯出是 ${backup.days} 天前，之後你又練了 ${backup.studyDaysSince} 天。學習進度只存在這台裝置的這個瀏覽器裡，沒有別的副本；建議現在匯出一份存起來。`),
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [
        h('button', {
          class: 'btn', onclick: async () => {
            try { await downloadBackup(); } catch (err) { toast('匯出失敗：' + err.message); return; }
            toast('已匯出');
            card.remove();
          }
        }, '⬇️ 現在匯出'),
        h('button', {
          class: 'btn ghost', onclick: async () => {
            await snoozeBackupReminder();
            card.remove();
          }
        }, '這週先不要')
      ])
    ]);
    wrap.append(card);
  }

  // ---- 待複習 ----
  // 第一天練完，所有項目的 due 都在 1 天後 → 這裡一定是 0。
  // 只說「目前沒有待複習項目」會讓人以為練了等於沒練，所以要講下一批何時到。
  const fc = forecast([...pmap.values()], 7);
  const nextDay = fc.buckets.findIndex((b, i) => i > 0 && b.n > 0);
  const soonText = fc.buckets[0].n > 0
    ? `今天稍晚還有 ${fc.buckets[0].n} 項會到期`
    : nextDay > 0
      ? `${nextDay === 1 ? '明天' : `${nextDay} 天後`}有 ${fc.buckets[nextDay].n} 項到期，到時回來複習`
      : '學習後系統會自動安排複習';
  wrap.append(h('button', { class: 'tile', onclick: () => navigate('/review') }, [
    h('span', { style: 'font-size:26px' }, due.length ? '🔔' : '✅'),
    h('div', { class: 'tile-main' }, [
      h('div', { class: 'tile-title', text: due.length ? `有 ${due.length} 項待複習` : '目前沒有待複習項目' }),
      h('div', { class: 'tile-sub', text: due.length ? '點擊開始間隔重複複習' : soonText })
    ]),
    h('span', { class: 'chev', text: '›' })
  ]));

  // ---- 重點複習 ----
  if (favs.length) {
    wrap.append(h('button', { class: 'tile', onclick: () => navigate('/favorites') }, [
      h('span', { style: 'font-size:24px' }, '★'),
      h('div', { class: 'tile-main' }, [
        h('div', { class: 'tile-title', text: `重點複習 ${favs.length} 項` }),
        h('div', { class: 'tile-sub', text: '你收藏的單字與文法' })
      ]),
      h('span', { class: 'chev', text: '›' })
    ]));
  }

  // ---- 聽力練習 ----
  wrap.append(h('button', { class: 'tile', onclick: () => navigate('/listening', { level: 'ALL', scope: 'random' }) }, [
    h('span', { style: 'font-size:24px' }, '🎧'),
    h('div', { class: 'tile-main' }, [
      h('div', { class: 'tile-title', text: '聽力練習' }),
      h('div', { class: 'tile-sub', text: '聽日文句子選出中文意思（用裝置內建語音，可離線）' })
    ]),
    h('span', { class: 'chev', text: '›' })
  ]));

  wrap.append(h('button', { class: 'tile', onclick: () => navigate('/exam') }, [
    h('span', { style: 'font-size:24px' }, '⏱️'),
    h('div', { class: 'tile-main' }, [
      h('div', { class: 'tile-title', text: '模擬考' }),
      h('div', { class: 'tile-sub', text: '照真實考試節奏計時分科，作答中不給答案，最後一次結算' })
    ]),
    h('span', { class: 'chev', text: '›' })
  ]));

  // ---- 快速開始 ----
  wrap.append(h('div', { class: 'section-title', text: '快速開始' }));
  wrap.append(h('div', { class: 'btn-grid' }, [
    h('button', { class: 'btn', onclick: () => navigate('/learn') }, '📚 JLPT 練習'),
    h('button', { class: 'btn secondary', onclick: () => navigate('/study', { type: 'vocab', level: 'N5', mode: 'quiz' }) }, '⚡ N5 快速測驗')
  ]));

  // ---- 生活旅行 ----
  if (tm.sets && tm.sets.length) {
    let tvLearned = 0;
    for (const r of pmap.values()) if (r.type === 'travel' && r.box >= LEARNED_BOX) tvLearned += 1;
    wrap.append(h('button', { class: 'tile', style: 'margin-top:10px', onclick: () => navigate('/travel') }, [
      h('span', { style: 'font-size:24px' }, '🧳'),
      h('div', { class: 'tile-main' }, [
        h('div', { class: 'tile-title', text: '生活旅行用語' }),
        h('div', { class: 'tile-sub', text: `情境會話・日本人這樣說・中日漢字大不同（共 ${tm.total} 條，已掌握 ${tvLearned}）` })
      ]),
      h('span', { class: 'chev', text: '›' })
    ]));
  }

  // ---- 各級別完成度 ----
  wrap.append(h('div', { class: 'section-title', text: '各級別掌握度' }));
  const totals = {};
  for (const s of man.sets) {
    totals[s.level] = totals[s.level] || { total: 0, learned: 0, learning: 0 };
    totals[s.level].total += (s.activeCount ?? s.count); // 扣掉跨級別重複隱藏的條目
  }
  const dupSet = new Set(man.dupIds || []);
  for (const r of pmap.values()) {
    if (dupSet.has(r.itemId)) continue; // 舊版本練過、現已隱藏的重複詞不計入
    if (!totals[r.level]) continue;
    if (stageOf(r) === 'learned') totals[r.level].learned += 1;
    else totals[r.level].learning += 1;
  }
  for (const lv of LEVELS) {
    const t = totals[lv] || { total: 0, learned: 0, learning: 0 };
    wrap.append(h('div', { class: 'card', style: 'padding:12px 14px' }, [
      h('div', { class: 'row spread', style: 'margin-bottom:6px' }, [
        h('div', { class: 'row', style: 'gap:8px' }, [
          h('span', { class: `pill ${lv.toLowerCase()}`, text: lv }),
          h('span', { class: 'small muted', text: `${t.learned} / ${t.total} 已掌握` + (t.learning ? `・${t.learning} 學習中` : '') })
        ]),
        h('span', { class: 'small muted', text: `${pct(t.learned, t.total)}%` })
      ]),
      progressBar(t.learned, t.total, t.learned === t.total && t.total > 0, undefined, t.learning)
    ]));
  }

  wrap.append(h('button', {
    class: 'btn ghost', style: 'margin-top:8px',
    onclick: () => navigate('/stats')
  }, '查看完整統計 →'));

  return wrap;
}
