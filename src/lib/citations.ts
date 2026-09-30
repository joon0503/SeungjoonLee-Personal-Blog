/**
 * Client-side behaviour for citations produced by lib/remark-citations.mjs:
 *
 *   - Hovering (or focusing) a citation shows the full reference in a small
 *     popover, so readers don't have to leave the paragraph.
 *   - On touch screens, the first tap opens the popover (with a link to the
 *     reference list); a second tap follows the link.
 *   - After jumping to the reference list, the entry's ↩ link returns to the
 *     exact citation the reader came from, not just the first one.
 */

const OPEN_DELAY = 120;
const CLOSE_DELAY = 180;

export function initCitations(root: ParentNode = document): void {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a.cite-link')];
  if (links.length === 0) return;

  const popover = document.createElement('div');
  popover.className = 'cite-popover';
  popover.setAttribute('role', 'tooltip');
  popover.id = 'cite-popover';
  document.body.append(popover);

  let current: HTMLAnchorElement | null = null;
  let openTimer = 0;
  let closeTimer = 0;

  const entryFor = (link: HTMLAnchorElement) => document.getElementById(`ref-${link.dataset.ref}`);

  function show(link: HTMLAnchorElement, withJump = false) {
    const entry = entryFor(link);
    if (!entry) return;
    clearTimeout(closeTimer);

    const label = entry.querySelector('.ref-label')?.cloneNode(true);
    const body = entry.querySelector('.ref-body')?.cloneNode(true);
    popover.replaceChildren(...[label, body].filter((n): n is Node => !!n));
    if (withJump) {
      const jump = document.createElement('a');
      jump.className = 'popover-jump';
      jump.href = link.getAttribute('href')!;
      jump.textContent = 'Go to references ↓';
      jump.addEventListener('click', () => rememberOrigin(link));
      popover.append(jump);
    }

    // Position below the citation, or above it when there is no room.
    popover.style.left = '0px';
    popover.style.top = '0px';
    popover.setAttribute('data-open', '');
    const r = link.getBoundingClientRect();
    const p = popover.getBoundingClientRect();
    const margin = 12;
    const left = Math.min(Math.max(margin, r.left + r.width / 2 - p.width / 2), window.innerWidth - p.width - margin);
    const below = r.bottom + 8;
    const top = below + p.height > window.innerHeight - margin && r.top - p.height - 8 > margin ? r.top - p.height - 8 : below;
    popover.style.left = `${left + window.scrollX}px`;
    popover.style.top = `${top + window.scrollY}px`;

    current?.removeAttribute('aria-describedby');
    link.setAttribute('aria-describedby', popover.id);
    current = link;
  }

  function hide() {
    clearTimeout(openTimer);
    popover.removeAttribute('data-open');
    current?.removeAttribute('aria-describedby');
    current = null;
  }

  const scheduleHide = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(hide, CLOSE_DELAY);
  };

  /** Point the reference's ↩ link back at the citation the reader used. */
  function rememberOrigin(link: HTMLAnchorElement) {
    const back = entryFor(link)?.querySelector<HTMLAnchorElement>('.ref-back');
    if (back) back.href = `#${link.id}`;
  }

  let lastPointer = '';
  for (const link of links) {
    link.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      clearTimeout(closeTimer);
      clearTimeout(openTimer);
      openTimer = window.setTimeout(() => show(link), OPEN_DELAY);
    });
    link.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch') scheduleHide();
    });
    link.addEventListener('pointerdown', (e) => {
      lastPointer = e.pointerType;
    });
    link.addEventListener('focus', () => show(link));
    link.addEventListener('blur', scheduleHide);
    link.addEventListener('click', (e) => {
      if (lastPointer === 'touch' && current !== link) {
        e.preventDefault();
        show(link, true);
        return;
      }
      rememberOrigin(link);
      hide();
    });
  }

  popover.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  popover.addEventListener('pointerleave', scheduleHide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  document.addEventListener('pointerdown', (e) => {
    if (current && !popover.contains(e.target as Node) && !(e.target as Element).closest?.('a.cite-link')) hide();
  });
  window.addEventListener('resize', hide);
}
