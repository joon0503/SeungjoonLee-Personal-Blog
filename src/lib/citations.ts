/**
 * Client-side behaviour for citations produced by lib/remark-citations.mjs:
 *
 *   - Hovering (or focusing) a citation shows the full reference in a small
 *     popover, so readers don't have to leave the paragraph.
 *   - On touch screens, the first tap opens the popover (with a link to the
 *     reference list); a second tap follows the link.
 *   - After jumping to the reference list, the entry's ↩ link returns to the
 *     exact citation the reader came from, not just the first one.
 *
 * Figure references ("Fig. 1") behave the same way: the popover previews the
 * figure (image and caption), and after jumping to a figure its caption shows
 * a ↩ link back to the text.
 *
 * Equation references ("Eq. (1)", and \eqref links KaTeX draws inside math)
 * preview the whole displayed equation.
 */

const OPEN_DELAY = 120;
const CLOSE_DELAY = 180;
const LINKS = 'a.cite-link, a.fig-link, a.eq-link, .katex a[href^="#eq-"]';

type Kind = 'ref' | 'fig' | 'eq';

export function initCitations(root: ParentNode = document): void {
  const links = [...root.querySelectorAll<HTMLAnchorElement>(LINKS)];
  if (links.length === 0) return;

  const popover = document.createElement('div');
  popover.className = 'cite-popover';
  popover.setAttribute('role', 'tooltip');
  popover.id = 'cite-popover';
  document.body.append(popover);

  let current: HTMLAnchorElement | null = null;
  let openTimer = 0;
  let closeTimer = 0;

  const kindOf = (link: HTMLAnchorElement): Kind =>
    link.classList.contains('fig-link') ? 'fig' : link.classList.contains('cite-link') ? 'ref' : 'eq';
  /** The reference entry, the figure, or the displayed equation a link points to. */
  const entryFor = (link: HTMLAnchorElement): HTMLElement | null => {
    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    return kindOf(link) === 'eq' ? (target?.closest<HTMLElement>('.katex-display') ?? null) : target;
  };

  /** Popover content: the reference entry, a figure's image and caption, or an equation. */
  function previewOf(link: HTMLAnchorElement, entry: HTMLElement): Node[] {
    const kind = kindOf(link);
    if (kind === 'eq') {
      const equation = entry.cloneNode(true) as HTMLElement;
      equation.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      equation.classList.add('popover-eq');
      return [equation];
    }
    if (kind === 'ref') {
      return [entry.querySelector('.ref-label'), entry.querySelector('.ref-body')]
        .filter((n): n is Element => !!n)
        .map((n) => n.cloneNode(true));
    }
    const nodes: Node[] = [];
    const img = entry.querySelector(':scope > img');
    if (img) {
      const thumb = img.cloneNode(true) as HTMLImageElement;
      thumb.className = 'popover-img';
      thumb.removeAttribute('loading');
      nodes.push(thumb);
    }
    const caption = entry.querySelector('figcaption')?.cloneNode(true) as HTMLElement | undefined;
    if (caption) {
      caption.querySelector('.fig-back')?.remove();
      caption.className = 'popover-caption';
      nodes.push(caption);
    }
    return nodes;
  }

  function show(link: HTMLAnchorElement, withJump = false) {
    const entry = entryFor(link);
    if (!entry) return;
    clearTimeout(closeTimer);

    popover.replaceChildren(...previewOf(link, entry));
    if (withJump) {
      const jump = document.createElement('a');
      jump.className = 'popover-jump';
      jump.href = link.getAttribute('href')!;
      jump.textContent = { ref: 'Go to references ↓', fig: 'Go to figure ↓', eq: 'Go to equation ↓' }[kindOf(link)];
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

  /** Point the reference's (or figure's) ↩ link back at the citation the reader used. */
  function rememberOrigin(link: HTMLAnchorElement) {
    const back = entryFor(link)?.querySelector<HTMLAnchorElement>('.ref-back, .fig-back');
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
    if (current && !popover.contains(e.target as Node) && !(e.target as Element).closest?.(LINKS)) hide();
  });
  window.addEventListener('resize', hide);
}
