/* 鍵盤快捷鍵綁定，會在畫面切換時自動解除 */

/**
 * @param {HTMLElement} viewRoot  此畫面的根節點（用來判斷是否還在畫面上）
 * @param {(e: KeyboardEvent) => void} handler
 */
export function bindKeys(viewRoot, handler) {
  const onKey = (e) => {
    // 忽略輸入框內的按鍵
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // 畫面已被換掉就自我解除
    if (!document.body.contains(viewRoot)) {
      teardown();
      return;
    }
    handler(e);
  };
  const teardown = () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', teardown);
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', teardown);
  return teardown;
}
