/**
 * Numbered citations, LaTeX style.
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
 */

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
          next.push(citeNode(keys));
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
