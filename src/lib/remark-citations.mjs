/**
 * Numbered citations and figure cross-references, LaTeX style.
 *
 * In the article body, cite with pandoc-like keys:
 *
 *   ... as shown in the original paper [@vaswani2017].
 *   ... several works [@ba2016; @zhang2019].
 *
 * and describe the works in the frontmatter:
 *
 *   references:
 *     vaswani2017:
 *       author: [A. Vaswani, N. Shazeer, N. Parmar]
 *       title: Attention Is All You Need
 *       venue: Advances in Neural Information Processing Systems
 *       year: 2017
 *       url: https://arxiv.org/abs/1706.03762
 *
 * Works are numbered in order of first citation, and only cited works are
 * listed. Like LaTeX's \nocite, `nocite: [key, ...]` in the frontmatter adds
 * works that are not cited in the text (e.g. further reading); they are
 * numbered after the cited ones. A "References" section is appended to the end of the article, with
 * a back link from each entry to the citation. The hover preview and the
 * "back to where I was" behaviour are added client-side (lib/citations.ts).
 *
 * Figures are numbered in document order: every <Figure> and every component
 * in components/interactive/ (each renders a Figure) gets a `number` prop,
 * which Figure.astro shows as "Figure 1." in the caption. Give a figure an
 * `id` to refer to it, pandoc-crossref style:
 *
 *   <Figure id="transformer" src="..." alt="..." caption="..." />
 *   ... the architecture in [@fig:transformer] ...       → Fig. 1
 *   ... compare [@fig:a; @fig:b] ...                       → Figs. 1 and 2
 *
 * (A component added to components/interactive/ is picked up on the next
 * dev-server start.)
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Names of the MDX components that render a numbered figure. */
const FIGURES = new Set([
  'Figure',
  ...readdirSync(fileURLToPath(new URL('../components/interactive/', import.meta.url)), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.astro'))
    .map((f) => basename(f, '.astro')),
]);

const CITE = /\[(@[\w:.-]+(?:\s*[;,]\s*@[\w:.-]+)*)\]/g;
const SKIP = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'link', 'linkReference', 'heading', 'html']);

/** @param {string} text */
const t = (text) => ({ type: 'text', value: text });
/** @param {string} tagName @param {Record<string, unknown>} properties @param {any[]} children */
const h = (tagName, properties, children = []) => ({ type: 'element', tagName, properties, children });

/** "A", "A and B", "A, B, and C" */
function formatAuthors(author) {
  const list = Array.isArray(author) ? author : author ? [author] : [];
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, -1).join(', ')}, and ${list.at(-1)}`;
}

/** IEEE-like: A. Author and B. Author, "Title," Venue, Year. doi */
function formatReference(ref) {
  const out = [];
  const authors = formatAuthors(ref.author);
  if (authors) out.push(t(`${authors}, `));
  if (ref.title) {
    const title = `“${ref.title},”`;
    out.push(ref.url ? h('a', { href: ref.url, className: ['ref-title'] }, [t(title)]) : h('span', { className: ['ref-title'] }, [t(title)]));
    out.push(t(' '));
  }
  const tail = [ref.venue && h('em', {}, [t(String(ref.venue))]), ref.year && t(String(ref.year))].filter(Boolean);
  tail.forEach((node, i) => {
    if (i > 0) out.push(t(', '));
    out.push(node);
  });
  out.push(t('.'));
  if (ref.note) out.push(t(` ${ref.note}.`));
  if (ref.doi) {
    out.push(t(' '));
    out.push(h('a', { href: `https://doi.org/${ref.doi}`, className: ['ref-doi'] }, [t(`doi:${ref.doi}`)]));
  }
  return out;
}

export default function remarkCitations() {
  return (tree, file) => {
    const frontmatter = file.data?.astro?.frontmatter ?? {};
    const references = frontmatter.references ?? {};
    const nocite = frontmatter.nocite ?? [];
    /** @type {Map<string, number>} key → citation number */
    const numbers = new Map();
    /** @type {Map<string, number>} key → how many times cited so far */
    const uses = new Map();

    // Pass 1: number the figures, so references to later figures resolve too.
    /** @type {Map<string, number>} figure id → figure number */
    const figures = new Map();
    let figureCount = 0;
    const numberFigures = (node) => {
      for (const child of node.children ?? []) {
        if (child.type === 'mdxJsxFlowElement' && FIGURES.has(child.name)) {
          figureCount += 1;
          child.attributes.push({ type: 'mdxJsxAttribute', name: 'number', value: String(figureCount) });
          const id = child.attributes.find((a) => a.name === 'id' && typeof a.value === 'string')?.value;
          if (id) figures.set(id, figureCount);
        } else {
          numberFigures(child);
        }
      }
    };
    numberFigures(tree);

    /** "Fig. 1", "Figs. 1 and 2", "Figs. 1, 2, and 3"; each number links to its figure. */
    const figureRef = (labels) => {
      const links = labels.map((label) => {
        const n = figures.get(label);
        if (n === undefined) {
          console.warn(`[citations] ${file.path ?? ''}: unknown figure "@fig:${label}"`);
          return h('span', { className: ['cite-missing'], title: `Unknown figure: ${label}` }, [t('?')]);
        }
        const use = (uses.get(`fig:${label}`) ?? 0) + 1;
        uses.set(`fig:${label}`, use);
        return h('a', { href: `#fig-${label}`, id: `figref-${label}-${use}`, className: ['fig-link'], dataFig: label }, [
          t(String(n)),
        ]);
      });
      const children = [];
      if (links.length === 1) {
        // A single reference links the whole "Fig. N".
        const [link] = links;
        if (link.tagName === 'a') link.children = [t(`Fig.\u00a0${link.children[0].value}`)];
        else children.push(t('Fig.\u00a0'));
        children.push(link);
      } else {
        children.push(t('Figs.\u00a0'));
        links.forEach((link, i) => {
          if (i > 0) children.push(t(i === links.length - 1 ? (links.length > 2 ? ', and ' : ' and ') : ', '));
          children.push(link);
        });
      }
      return { type: 'figureRef', data: { hName: 'span', hProperties: { className: ['xref'] }, hChildren: children } };
    };

    const citeNode = (keys) => {
      const children = [t('[')];
      keys.forEach((key, i) => {
        if (i > 0) children.push(t(', '));
        if (!(key in references)) {
          console.warn(`[citations] ${file.path ?? ''}: unknown reference "@${key}"`);
          children.push(h('span', { className: ['cite-missing'], title: `Unknown reference: ${key}` }, [t('?')]));
          return;
        }
        if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
        const use = (uses.get(key) ?? 0) + 1;
        uses.set(key, use);
        children.push(
          h('a', { href: `#ref-${key}`, id: `cite-${key}-${use}`, className: ['cite-link'], dataRef: key }, [
            t(String(numbers.get(key))),
          ]),
        );
      });
      children.push(t(']'));
      return { type: 'citation', data: { hName: 'span', hProperties: { className: ['cite'] }, hChildren: children } };
    };

    const walk = (node) => {
      if (!node.children || SKIP.has(node.type)) return;
      const next = [];
      for (const child of node.children) {
        if (child.type !== 'text' || !child.value.includes('[@')) {
          walk(child);
          next.push(child);
          continue;
        }
        let last = 0;
        for (const match of child.value.matchAll(CITE)) {
          if (match.index > last) next.push(t(child.value.slice(last, match.index)));
          const keys = match[1].split(/[;,]/).map((k) => k.trim().replace(/^@/, ''));
          const figs = keys.filter((k) => k.startsWith('fig:')).map((k) => k.slice(4));
          const works = keys.filter((k) => !k.startsWith('fig:'));
          if (figs.length > 0) next.push(figureRef(figs));
          if (figs.length > 0 && works.length > 0) next.push(t(' '));
          if (works.length > 0) next.push(citeNode(works));
          last = match.index + match[0].length;
        }
        if (last < child.value.length) next.push(t(child.value.slice(last)));
      }
      node.children = next;
    };
    walk(tree);

    for (const key of nocite) {
      if (!(key in references)) console.warn(`[citations] ${file.path ?? ''}: unknown nocite reference "${key}"`);
      else if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    }
    if (numbers.size === 0) return;

    const items = [...numbers].map(([key, n]) =>
      h('li', { id: `ref-${key}` }, [
        h('span', { className: ['ref-label'] }, [t(`[${n}]`)]),
        h('span', { className: ['ref-body'] }, formatReference(references[key])),
        uses.has(key)
          ? h('a', { href: `#cite-${key}-1`, className: ['ref-back'], ariaLabel: 'Back to the text' }, [t('↩')])
          : h('span', { className: ['ref-back'] }),
      ]),
    );

    tree.children.push(
      {
        type: 'heading',
        depth: 2,
        children: [t('References')],
        data: { hProperties: { className: ['unnumbered'] } },
      },
      { type: 'referenceList', data: { hName: 'ol', hProperties: { className: ['references'] }, hChildren: items } },
    );
  };
}
