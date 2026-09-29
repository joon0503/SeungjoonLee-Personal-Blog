/**
 * Run `callback` once, the first time `element` comes near the viewport.
 * Interactive figures use this to defer loading their (possibly heavy)
 * implementation until the reader actually scrolls to them.
 */
export function whenVisible(element: Element, callback: () => void, rootMargin = '200px'): void {
  if (!('IntersectionObserver' in window)) {
    callback();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        callback();
      }
    },
    { rootMargin },
  );
  observer.observe(element);
}
