/** Dispatched on a <figure> to draw it now; the hover preview of a figure reference needs it drawn. */
export const DRAW_EVENT = 'figure:draw';

/**
 * Run `callback` once, the first time `element` comes near the viewport.
 * Interactive figures use this to defer loading their (possibly heavy)
 * implementation until the reader actually scrolls to them. A DRAW_EVENT on
 * the enclosing <figure> runs it early.
 */
export function whenVisible(element: Element, callback: () => void, rootMargin = '200px'): void {
  if (!('IntersectionObserver' in window)) {
    callback();
    return;
  }
  const run = () => {
    observer.disconnect();
    element.closest('figure')?.removeEventListener(DRAW_EVENT, run);
    callback();
  };
  const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && run(), { rootMargin });
  observer.observe(element);
  element.closest('figure')?.addEventListener(DRAW_EVENT, run);
}
