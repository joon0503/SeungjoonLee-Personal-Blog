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
 * Figure references also work inside a `caption` attribute, where they
 * become plain text ("Fig. 2"), since a caption string cannot hold a link.
 *
 * (A component added to components/interactive/ is picked up on the next
 * dev-server start.)
 *
 * Equations are numbered as in LaTeX. `$$ ... $$` is unnumbered like \[ \],
 * unless it holds a \label; the equation, align, gather and alignat
 * environments number every row, unless the row has \notag or \nonumber.
 * \tag{...} sets a custom tag. Refer to a labelled equation with
 *
 *   $$ x_{k+1} = A x_k + B u_k \label{dynamics} $$
 *   ... substituting [@eq:dynamics] ...                   → Eq. (1)
 *   ... from [@eq:a; @eq:b] ...                           → Eqs. (1) and (2)
 *   $$ y \overset{\eqref{dynamics}}{=} z $$               → (1), inside math
 *
 * A leading `eq:` in a label is dropped: \label{eq:dynamics} is [@eq:dynamics].
 *
 * Numbers are written into the math as \tag{\htmlId{eq-<label>}{N}}, so KaTeX
 * draws them and each labelled row gets an anchor; \eqref{x} and \ref{x}
 * inside math become \href{#eq-x}{(N)} and \href{#eq-x}{N}. Both need the
 * KaTeX `trust` setting in astro.config.mjs.
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

/**
 * Split an environment body into rows at top-level `\\`, ignoring those inside
 * braces or a nested \begin...\end (cases, matrices, aligned, ...).
 * @param {string} body
 */
function splitRows(body) {
  const rows = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '\\') {
      if (body[i + 1] === '\\' && depth === 0) {
        rows.push(body.slice(start, i));
        start = i;
        i += 1;
      } else if (body.startsWith('begin{', i + 1)) depth += 1;
      else if (body.startsWith('end{', i + 1)) depth -= 1;
      else i += 1; // \{, \}, or the first letter of a command
    }
  }
  rows.push(body.slice(start));
  return rows;
}

/**
 * Replace the LaTeX of a `math` or `inlineMath` node. remark-math also copies
 * it into the node's hast (`data.hChildren`) while parsing, so update both.
 */
function setMath(node, value) {
  node.value = value;
  const text = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.type === 'text') n.value = value;
      else text(n.children);
    }
  };
  text(node.data?.hChildren);
}

const LABEL = /\\label\s*\{([^{}]*)\}/g;
const NOTAG = /\\(?:notag|nonumber)\b/g;
const TAG = /\\tag(\*?)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/;
const NUMBERED_ENV = /\\begin\{(equation|align|gather|alignat)(\*?)\}/g;
const MATH_REF = /\\(eqref|ref)\s*\{([^{}]*)\}/g;
/** Equation label; a LaTeX-habit `eq:` prefix is dropped, so \label{eq:x} is [@eq:x]. */
const eqLabel = (label) => label.trim().replace(/^eq:/, '');

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

    // Pass 1b: number the display equations, rewriting their LaTeX in place.
    /** @type {Map<string, string>} equation label \u2192 tag ("3", or a custom \tag) */
    const equations = new Map();
    let equationCount = 0;
    /** Number one row (or a whole equation); `auto` for rows of a numbered environment. */
    const numberRow = (row, auto) => {
      const labels = [...row.matchAll(LABEL)].map((m) => eqLabel(m[1]));
      row = row.replace(LABEL, '');
      const notag = row.search(NOTAG) >= 0;
      row = row.replace(NOTAG, '');
      const anchor = labels[0] ? `eq-${labels[0]}` : undefined;
      const tagged = row.match(TAG);
      let tag;
      if (tagged) {
        tag = tagged[2];
        if (anchor) row = row.replace(TAG, `\\tag${tagged[1]}{\\htmlId{${anchor}}{${tagged[2]}}}`);
      } else if ((auto && !notag) || labels.length > 0) {
        equationCount += 1;
        tag = String(equationCount);
        row = `${row.trimEnd()} \\tag{${anchor ? `\\htmlId{${anchor}}{${tag}}` : tag}}`;
      }
      for (const label of labels) {
        if (equations.has(label)) console.warn(`[citations] ${file.path ?? ''}: duplicate equation label "${label}"`);
        equations.set(label, tag ?? '?');
      }
      return row;
    };
    /** Number the rows of each environment, and labels outside them. */
    const numberMath = (value) => {
      let out = '';
      let last = 0;
      for (const match of value.matchAll(NUMBERED_ENV)) {
        if (match.index < last) continue;
        const [begin, env, star] = match;
        const end = `\\end{${env}${star}}`;
        const close = value.indexOf(end, match.index + begin.length);
        if (close < 0) continue;
        const body = value.slice(match.index + begin.length, close);
        const auto = star === '';
        const rows = env === 'equation' ? [body] : splitRows(body);
        out += numberRow(value.slice(last, match.index), false);
        out += `\\begin{${env}*}${rows.map((row) => numberRow(row, auto)).join('')}\\end{${env}*}`;
        last = close + end.length;
      }
      return out + numberRow(value.slice(last), false);
    };
    const numberEquations = (node) => {
      for (const child of node.children ?? []) {
        if (child.type === 'math') setMath(child, numberMath(child.value));
        else numberEquations(child);
      }
    };
    numberEquations(tree);

    // \eqref{x} and \ref{x} inside math (inline or display) link to the equation.
    const resolveMathRefs = (node) => {
      for (const child of node.children ?? []) {
        if (child.type === 'math' || child.type === 'inlineMath') {
          const value = child.value.replace(MATH_REF, (_, command, label) => {
            label = eqLabel(label);
            const tag = equations.get(label);
            if (tag === undefined) console.warn(`[citations] ${file.path ?? ''}: unknown equation "\\${command}{${label}}"`);
            const text = command === 'eqref' ? `(${tag ?? '?'})` : (tag ?? '?');
            return tag === undefined ? `\\text{${text}}` : `\\href{#eq-${label}}{\\text{${text}}}`;
          });
          if (value !== child.value) setMath(child, value);
        } else resolveMathRefs(child);
      }
    };
    resolveMathRefs(tree);

    /** Cross-reference kinds: [@fig:label] and [@eq:label]. */
    const XREF = {
      fig: { numbers: figures, noun: 'figure', one: 'Fig.', many: 'Figs.', wrap: (n) => n },
      eq: { numbers: equations, noun: 'equation', one: 'Eq.', many: 'Eqs.', wrap: (n) => `(${n})` },
    };

    /** "Fig. 1", "Figs. 1 and 2", "Eq. (1)", ... as plain text, for caption strings. */
    const xrefText = (kind, labels) => {
      const { numbers, noun, one, many, wrap } = XREF[kind];
      const ns = labels.map((label) => {
        if (numbers.has(label)) return wrap(String(numbers.get(label)));
        console.warn(`[citations] ${file.path ?? ''}: unknown ${noun} "@${kind}:${label}" in a caption`);
        return wrap('?');
      });
      if (ns.length === 1) return `${one}\u00a0${ns[0]}`;
      const last = ns.pop();
      return `${many}\u00a0${ns.join(', ')}${ns.length > 1 ? ',' : ''} and ${last}`;
    };
    const resolveCaptions = (node) => {
      for (const child of node.children ?? []) {
        if (child.type === 'mdxJsxFlowElement' && FIGURES.has(child.name)) {
          for (const attr of child.attributes) {
            if (attr.name !== 'caption' || typeof attr.value !== 'string') continue;
            attr.value = attr.value.replace(CITE, (match, list) => {
              const keys = list.split(/[;,]/).map((k) => k.trim().replace(/^@/, ''));
              for (const kind of Object.keys(XREF)) {
                if (keys.every((k) => k.startsWith(`${kind}:`))) return xrefText(kind, keys.map((k) => k.slice(kind.length + 1)));
              }
              return match;
            });
          }
        }
        resolveCaptions(child);
      }
    };
    resolveCaptions(tree);

    /** "Fig. 1", "Figs. 1 and 2", "Eqs. (1), (2), and (3)"; each number links to its figure or equation. */
    const xrefNode = (kind, labels) => {
      const { numbers, noun, one, many, wrap } = XREF[kind];
      const links = labels.map((label) => {
        const n = numbers.get(label);
        if (n === undefined) {
          console.warn(`[citations] ${file.path ?? ''}: unknown ${noun} "@${kind}:${label}"`);
          return h('span', { className: ['cite-missing'], title: `Unknown ${noun}: ${label}` }, [t(wrap('?'))]);
        }
        const use = (uses.get(`${kind}:${label}`) ?? 0) + 1;
        uses.set(`${kind}:${label}`, use);
        return h(
          'a',
          { href: `#${kind}-${label}`, id: `${kind}ref-${label}-${use}`, className: [`${kind}-link`], [`data${kind[0].toUpperCase()}${kind.slice(1)}`]: label },
          [t(wrap(String(n)))],
        );
      });
      const children = [];
      if (links.length === 1) {
        // A single reference links the whole "Fig. N".
        const [link] = links;
        if (link.tagName === 'a') link.children = [t(`${one}\u00a0${link.children[0].value}`)];
        else children.push(t(`${one}\u00a0`));
        children.push(link);
      } else {
        children.push(t(`${many}\u00a0`));
        links.forEach((link, i) => {
          if (i > 0) children.push(t(i === links.length - 1 ? (links.length > 2 ? ', and ' : ' and ') : ', '));
          children.push(link);
        });
      }
      return { type: 'crossReference', data: { hName: 'span', hProperties: { className: ['xref'] }, hChildren: children } };
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
          const parts = [];
          for (const kind of Object.keys(XREF)) {
            const labels = keys.filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1));
            if (labels.length > 0) parts.push(xrefNode(kind, labels));
          }
          const works = keys.filter((k) => !Object.keys(XREF).some((kind) => k.startsWith(`${kind}:`)));
          if (works.length > 0) parts.push(citeNode(works));
          parts.forEach((part, i) => next.push(...(i > 0 ? [t(' '), part] : [part])));
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
