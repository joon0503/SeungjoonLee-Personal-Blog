import { playIntro } from './figure-intro';

/** Dispatched on a <figure> to draw it now; the hover preview of a figure reference needs it drawn. */
export const DRAW_EVENT = 'figure:draw';

/**
 * Put every control back to the value in the markup. Browsers restore form
 * state on reload and back/forward navigation, which would start a figure
 * (and its Reset button) from stale values, or from old values clamped to a
 * changed range.
 */
function restoreDefaults(element: Element): void {
  element.querySelectorAll('input').forEach((el) => {
    el.value = el.defaultValue;
    el.checked = el.defaultChecked;
  });
  element.querySelectorAll('select').forEach((el) => {
    for (const option of el.options) option.selected = option.defaultSelected;
  });
}

/**
 * Run `callback` once, the first time `element` comes near the viewport.
 * Interactive figures use this to defer loading their (possibly heavy)
 * implementation until the reader actually scrolls to them. A DRAW_EVENT on
 * the enclosing <figure> runs it early. Controls inside `element` start from
 * their markup defaults, and once `callback` (which may be async) has drawn
 * the figure, it plays its entrance animation on coming into view.
 */
export function whenVisible(element: HTMLElement, callback: () => void | Promise<void>, rootMargin = '200px'): void {
  if (!('IntersectionObserver' in window)) {
    restoreDefaults(element);
    callback();
    return;
  }
  const run = () => {
    observer.disconnect();
    element.closest('figure')?.removeEventListener(DRAW_EVENT, run);
    restoreDefaults(element);
    Promise.resolve(callback()).then(() => playIntro(element));
  };
  const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && run(), { rootMargin });
  observer.observe(element);
  element.closest('figure')?.addEventListener(DRAW_EVENT, run);
}
