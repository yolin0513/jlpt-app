/* 單字／文法項目的共用呈現元件：最愛星號、朗讀鈕、詳細卡片 */
import { h } from './ui.js';
import { toggleFavorite } from './store.js';
import { speakButton, hasJapaneseVoice } from './speech.js';

/** 朗讀某項目日文的字串 */
export function speakText(item) {
  if (!item) return '';
  if (item.type === 'vocab') return item.example || item.kana || item.kanji;
  if (item.type === 'travel') {
    if (item.cat === 'kanji') return item.example || item.kanji;
    return item.jp || item.kana;
  }
  return item.example || item.pattern;
}

/**
 * 一列操作鈕：⭐ 最愛 + 🔊 朗讀
 * @param {object} item
 * @param {Set<string>} favSet  目前的最愛 id 集合（會就地更新）
 * @param {function} [onChange] 切換後回呼 (nowFav)
 */
export function actionRow(item, favSet, onChange) {
  const row = h('div', { class: 'action-row' });

  const star = h('button', {
    class: 'icon-btn star-btn',
    type: 'button',
    'aria-label': '加入重點複習',
    onclick: async (e) => {
      e.stopPropagation();
      const now = await toggleFavorite(item);
      if (now) favSet.add(item.id); else favSet.delete(item.id);
      paint();
      onChange && onChange(now);
    }
  });
  const paint = () => {
    const on = favSet.has(item.id);
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('on', on);
    star.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  paint();
  row.append(star);

  if (hasJapaneseVoice()) {
    row.append(speakButton(() => speakText(item)));
  }
  return row;
}

/** 搜尋結果 / 詳細用的卡片 */
export function detailCard(item, favSet) {
  const lv = String(item.level).toLowerCase();

  if (item.type === 'travel') {
    if (item.cat === 'kanji') {
      return h('div', { class: 'card detail-card' }, [
        h('div', { class: 'row spread' }, [
          h('div', { class: 'row', style: 'gap:8px;align-items:baseline;flex-wrap:wrap' }, [
            h('span', { class: 'pill travel', text: '漢字' }),
            h('span', { class: 'detail-main jp', text: item.kanji }),
            item.reading ? h('span', { class: 'muted', text: item.reading }) : null
          ]),
          actionRow(item, favSet)
        ]),
        h('div', { class: 'detail-meaning', text: `日文意思：${item.jpMeaning}` }),
        item.zhMisread ? h('div', { class: 'small', style: 'color:var(--bad);margin-top:4px', text: `台灣人常誤解：${item.zhMisread}` }) : null,
        item.example ? h('div', { class: 'detail-example' }, [
          h('div', {}, [h('b', { text: item.example })]),
          item.exampleKana ? h('div', { class: 'small muted', text: item.exampleKana }) : null,
          item.exampleMeaning ? h('div', { class: 'small muted', text: item.exampleMeaning }) : null
        ]) : null
      ]);
    }
    return h('div', { class: 'card detail-card' }, [
      h('div', { class: 'row spread' }, [
        h('div', { class: 'row', style: 'gap:8px;align-items:baseline;flex-wrap:wrap' }, [
          h('span', { class: 'pill travel', text: item.cat === 'usage' ? '日本人這樣說' : '會話' }),
          item.scene ? h('span', { class: 'small muted', text: item.scene }) : null
        ]),
        actionRow(item, favSet)
      ]),
      h('div', { class: 'detail-main jp', style: 'font-size:18px;margin-top:6px', text: item.jp }),
      item.kana ? h('div', { class: 'small muted', text: item.kana }) : null,
      h('div', { class: 'detail-meaning', style: 'font-size:16px', text: item.zh }),
      item.note ? h('div', { class: 'small', style: 'margin-top:6px;color:var(--accent)', text: item.cat === 'usage' ? `💡 ${item.note}` : item.note }) : null
    ]);
  }

  if (item.type === 'vocab') {
    const showKana = item.kanji && item.kana && item.kanji !== item.kana;
    return h('div', { class: 'card detail-card' }, [
      h('div', { class: 'row spread' }, [
        h('div', { class: 'row', style: 'gap:8px;align-items:baseline;flex-wrap:wrap' }, [
          h('span', { class: `pill ${lv}`, text: item.level }),
          h('span', { class: 'detail-main jp', text: item.kanji || item.kana }),
          showKana ? h('span', { class: 'muted', text: item.kana }) : null,
          item.pos ? h('span', { class: 'pill', text: item.pos }) : null
        ]),
        actionRow(item, favSet)
      ]),
      h('div', { class: 'detail-meaning', text: item.meaning }),
      item.example ? h('div', { class: 'detail-example' }, [
        h('div', {}, [h('b', { text: item.example })]),
        item.exampleKana ? h('div', { class: 'small muted', text: item.exampleKana }) : null,
        item.exampleMeaning ? h('div', { class: 'small muted', text: item.exampleMeaning }) : null
      ]) : null
    ]);
  }
  return h('div', { class: 'card detail-card' }, [
    h('div', { class: 'row spread' }, [
      h('div', { class: 'row', style: 'gap:8px;align-items:baseline;flex-wrap:wrap' }, [
        h('span', { class: `pill ${lv}`, text: item.level }),
        h('span', { class: 'detail-main jp', style: 'font-size:20px', text: item.pattern })
      ]),
      actionRow(item, favSet)
    ]),
    h('div', { class: 'detail-meaning', style: 'font-size:16px', text: item.meaning }),
    item.structure ? h('div', { class: 'small pill', text: item.structure }) : null,
    item.explanation ? h('div', { class: 'small muted', style: 'margin-top:4px', text: item.explanation }) : null,
    item.example ? h('div', { class: 'detail-example' }, [
      h('div', {}, [h('b', { text: item.example })]),
      item.exampleKana ? h('div', { class: 'small muted', text: item.exampleKana }) : null,
      item.exampleMeaning ? h('div', { class: 'small muted', text: item.exampleMeaning }) : null
    ]) : null
  ]);
}
