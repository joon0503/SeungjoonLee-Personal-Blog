# SeungjoonLee-Personal-Blog

Personal technical site: long-form notes on control, linear algebra, computer vision,
machine learning and robotics. Built with [Astro](https://astro.build), MDX and KaTeX,
deployed as a static site to Cloudflare Pages.

## Development

Requires Node 22.12+ (`.nvmrc` pins 24).

```bash
npm install
npm run dev       # http://localhost:4321, drafts visible
npm run build     # type-check (astro check) + static build into dist/
npm run preview   # serve dist/ locally
npm run ci        # what CI runs: build + internal link check
```

Math is rendered by KaTeX at build time with the stylesheet from the `katex` package. `overrides` in
`package.json` makes `rehype-katex` render with that same version (otherwise it bundles its own, and
the HTML and CSS disagree: misplaced subscripts and equation numbers). To upgrade KaTeX, bump `katex`.

## Writing an article

Create `src/content/blog/<slug>.mdx`. The file name becomes the URL: `/articles/<slug>/`.

```mdx
---
title: 'Understanding LQR Geometrically'
description: 'One or two sentences; used as subtitle and meta description.'
date: 2026-09-29
updated: 2026-10-05 # optional
topics: [control, optimization]
draft: false # drafts show in `npm run dev` only
---

Inline math $Ax = b$ and display math:

$$
x_{k+1} = Ax_k + Bu_k
$$

<PhasePortrait zeta={0.7} />
```

- Don't add an `# H1` — the layout renders the title. Start sections at `##`; `##`/`###` feed the table of contents.
- `topics` must be ids from `src/lib/topics.ts`. Add a topic there (id, title, description) and its page appears automatically.
- Images/figures go in `public/figures/<article>/` and are used via `<Figure src="/figures/..." alt="..." caption="..." />`
  (plain Markdown `![alt](/figures/...)` also works, but is not numbered).
- In MDX, `{` `}` and `<` outside math and code are JSX syntax — escape them (`\{`) in prose.

## Writing reference

Everything below works in any `.mdx` article without an import.

| Want                          | Write                                                        | Renders as                             |
| ----------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| Highlight a phrase            | `<mark>key phrase</mark>`                                    | amber highlighter stroke               |
| Key idea / definition block   | `<Callout label="Definition" title="…">…</Callout>`          | tinted block with a small label        |
| Aside in the margin           | `text<Sidenote>note</Sidenote> more text`                    | numbered note in the right margin      |
| Numbered figure               | `<Figure id="arch" src="…" alt="…" caption="…" />`           | "Figure 1." caption                    |
| Refer to a figure             | `[@fig:arch]`, `[@fig:a; @fig:b]`                            | linked "Fig. 1", "Figs. 1 and 2"       |
| Numbered equation             | `$$ … \label{dyn} $$`, or `\begin{equation}`/`align`         | "(1)" at the right margin              |
| Refer to an equation          | `[@eq:dyn]`, `[@eq:a; @eq:b]`; in math `\eqref{dyn}`         | linked "Eq. (1)", "Eqs. (1) and (2)"   |
| Cite a work                   | `[@vaswani2017]`, `[@ba2016; @zhang2019]`                    | linked `[1]`, `[2, 3]` + References    |

Applied automatically, nothing to write: numbered section headings (`##` → 1, `###` → 1.2, also in the
table of contents), justified and hyphenated paragraphs, and an end mark (∎) after the final paragraph
when the article ends with one (References and footnotes may follow; a closing figure or list gets no mark).

### Emphasis

Use `<mark>` for a phrase inside a sentence, `<Callout>` for a statement that should stand on its own.
Both use the same amber accent (`--mark`, `--mark-rule`, `--mark-ink` in `global.css`), kept apart from
the blue used for links.

```mdx
Hence, we arrive at the <mark>maximum likelihood estimation problem</mark>.

<Callout>
Maximizing the likelihood and the log-likelihood give the same parameters, because the logarithm is
strictly increasing.
</Callout>

<Callout label="Definition" title="Likelihood function">
For an observed event $x$, the likelihood is the density viewed as a function of the parameter:

$$
\mathcal{L}_x(\theta) = p_\theta(x).
$$
</Callout>
```

- `label` is the small uppercase tag (default `Key idea`); use `Definition`, `Result`, `Note`, … as fits.
  `title` is optional and names the thing being defined.
- A callout holds normal Markdown: paragraphs, lists, math. Use emphasis sparingly; a few per article.

### Side notes

```mdx
The Transformer normalizes after every residual block.<Sidenote>This is the "Post-LN" arrangement.</Sidenote> Layer …
```

- Place it right after the word or sentence it comments on, inside the paragraph (no blank lines around it).
- Notes are numbered automatically. On screens ≥ 1280px they sit in the right margin, level with the line;
  on narrower screens readers tap the number to expand the note in place.
- Keep notes short (a sentence or two) and inline-only: no paragraphs, lists or display math inside.

### Figures and cross-references

Every `<Figure>` and every interactive figure (any component in `src/components/interactive/`) is numbered
in document order and captioned "Figure N.". Give a figure an `id` to refer to it:

```mdx
The architecture is shown in [@fig:transformer].

<Figure id="transformer" src="/figures/layer-norm/transformer.png" alt="…" caption="The Transformer." />
<PhasePortrait id="damped" caption="Trajectories of the system in [@fig:transformer]." />
```

- `[@fig:id]` renders a linked "Fig. N"; `[@fig:a; @fig:b]` renders "Figs. 1 and 2". References may
  point forward to later figures. Hovering previews the figure; after jumping, its caption shows ↩ back.
- Inside a `caption` string, `[@fig:id]` becomes plain text "Fig. N" (a caption string can't hold a link).
- A wrong id renders "Fig. ?" and prints a `[citations]` warning during the build.
- Short captions are centered; longer ones are set as a left-aligned block.
- A new component added to `src/components/interactive/` is numbered after restarting `npm run dev`.

### Equations and cross-references

Equations are numbered as in LaTeX, in document order. Plain `$$ … $$` is unnumbered (like `\[ \]`)
unless it contains a `\label`; the `equation`, `align`, `gather` and `alignat` environments number
every row:

```mdx
The system evolves as

$$
x_{k+1} = A x_k + B u_k \label{dynamics}
$$

$$
\begin{align}
J &= \sum_k x_k^\top Q x_k + u_k^\top R u_k \label{cost} \\
  &= \ldots \nonumber \\
P &= Q + A^\top P A - A^\top P B (R + B^\top P B)^{-1} B^\top P A \label{dare}
\end{align}
$$

Substituting [@eq:dynamics] into [@eq:cost] gives [@eq:dare], so

$$
J \overset{\eqref{dare}}{=} x_0^\top P x_0.
$$
```

- `[@eq:label]` renders a linked "Eq. (1)"; `[@eq:a; @eq:b]` renders "Eqs. (1) and (2)", and may point
  forward. It can share brackets with figures and citations: `[@fig:a; @eq:b; @ba2016]`. Use this form
  in prose, since MDX reads `{…}` outside math as JSX.
- Hovering a reference previews the whole equation (every row of an `align`, with its numbers); on
  touch screens the first tap previews and a second follows the link. After jumping, the equation is
  highlighted.
- Inside math, `\eqref{label}` gives a linked "(1)" and `\ref{label}` a linked "1". These preview
  on hover too.
- Inside a figure `caption` string, `[@eq:label]` becomes plain text "Eq. (1)".
- `\notag` / `\nonumber` skips a row of a numbered environment; `\tag{A}` sets a custom tag (refer to it
  as usual). `equation*`, `align*`, … are unnumbered, except for rows with a `\label`.
- `\label{eq:dynamics}` works too: a leading `eq:` is dropped, so refer to it as `[@eq:dynamics]`.
- A wrong label renders "Eq. (?)" and prints a `[citations]` warning during the build; so does a label
  used twice.
- Numbering is done at build time by `src/lib/remark-citations.mjs`, which rewrites each number into
  the math as `\tag{\htmlId{eq-label}{N}}` (an anchor KaTeX draws). `astro.config.mjs` lets KaTeX
  render `\htmlId` and same-page `\href` links only.

### Citations and references

Cite in the text with `[@key]` and describe each work in the frontmatter under `references`.
Field names follow BibTeX where possible:

```mdx
---
title: 'Layer Normalization & RMS Normalization'
references:
  vaswani2017:
    author: [A. Vaswani, N. Shazeer, N. Parmar]   # a list, or a single string
    title: Attention Is All You Need               # required
    venue: Advances in Neural Information Processing Systems   # journal, conference, site, …
    year: 2017
    url: https://arxiv.org/abs/1706.03762          # optional: links the title
    doi: 10.48550/arXiv.1706.03762                 # optional
    note: Extended version.                        # optional
  karpathy-llmc-layernorm:
    author: A. Karpathy
    title: LayerNorm
    venue: llm.c documentation, GitHub
    url: https://github.com/karpathy/llm.c/blob/master/doc/layernorm/layernorm.md
nocite: [karpathy-llmc-layernorm]   # further reading: listed without an in-text citation
---

The Transformer [@vaswani2017] uses layer normalization [@ba2016; @zhang2019].
```

- Works are numbered `[1]`, `[2]`, … in order of first citation, and only cited works (plus `nocite`) are
  listed. A **References** section (unnumbered, in the table of contents) is appended automatically,
  so don't write one by hand.
- Hovering a citation shows the full reference; each entry's ↩ returns to the citation the reader clicked.
- Figures and works can share a bracket: `[@fig:arch; @vaswani2017]` → "Fig. 1 [1]".
- An unknown key renders `[?]` and prints a `[citations]` warning during the build.
- YAML: quote values containing `#` or `: ` (e.g. `venue: "GitHub issue #1292"`), or they get cut off.
- Changes to the citation plugin (`src/lib/remark-citations.mjs`) need a dev-server restart.

## Interactive figures

Interactive components live in `src/components/interactive/`. The pattern (see `PhasePortrait`):

1. **`Name.astro`** renders the static markup (controls, empty `<svg>`/`<canvas>`, caption) at build time
   and defines a tiny custom element that calls `whenVisible()`.
2. **`name.ts`** holds the actual implementation. It is `import()`ed only when the figure scrolls near the
   viewport, so heavy libraries (Three.js, Plotly, D3) never load on pages — or parts of pages — that don't need them.
3. Register it in `src/components/mdx.ts` to use it in any article without an import, or import it directly in one `.mdx` file.

Pages without interactive figures ship no component JavaScript. Style dynamically created SVG through CSS
variables (`var(--accent)`, `var(--text-faint)`, …) so figures follow light/dark mode.

If a component is easier to write in React, add `npx astro add react` and use it with `client:visible`;
the rest of the site is unaffected.

## Structure

```text
src/
├── content.config.ts         # article schema (content collection)
├── site.config.ts            # site name, tagline, nav, links
├── content/blog/             # articles (.mdx / .md)
├── components/
│   ├── Header, Footer, TableOfContents, ArticleList, TopicTags
│   ├── Figure, Callout, Sidenote   # article elements (see Writing reference)
│   ├── mdx.ts                # components available in every article
│   └── interactive/          # interactive figures
├── layouts/                  # BaseLayout (SEO, fonts), ArticleLayout (TOC, prev/next, related)
├── lib/                      # articles.ts (queries), topics.ts (topic registry), when-visible.ts,
│                             # remark-citations.mjs (citations, figure numbers, References),
│                             # citations.ts (hover previews and back links)
├── pages/                    # /, /articles/, /articles/[slug]/, /topics/, /topics/[topic]/, /about/, 404
└── styles/global.css         # tokens, typography, prose, code and math styles
public/                       # favicon, robots.txt, _headers (Cloudflare cache rules), figures/, images/
```

## CI / CD

- **CI** (`.github/workflows/ci.yml`, GitHub Actions): on every push to `main` and every pull request,
  runs `npm ci`, `npm run build` (type-check + content schema validation + build) and
  `npm run check:links` (every internal link, image and `#anchor` in `dist/` must resolve).
- **CD** (Cloudflare Workers Builds): every push to `main` builds and deploys. CI does not deploy.

Recommended flow for bigger changes: work on a branch → open a PR → CI runs (and Cloudflare posts a
preview URL if non-production branch builds are enabled) → merge → Cloudflare deploys `main`.

## Deployment (Cloudflare Workers)

The site is deployed as a static-assets-only Cloudflare Worker, configured in `wrangler.jsonc`
(serves `dist/`, trailing-slash URLs, `404.html` for unknown paths, headers from `public/_headers`).

Connect the GitHub repository under **Workers & Pages → Create → Import a repository** with:

| Setting         | Value               |
| --------------- | ------------------- |
| Production branch | `main`            |
| Build command   | `npm run build`     |
| Deploy command  | `npx wrangler deploy` |

Every push to `main` deploys; pushes to other branches get preview URLs (if enabled). Preview
builds run `npx wrangler preview`, which needs the (empty) `previews` block in `wrangler.jsonc`.
The build command must be set too: without it the deploy step finds no `dist/`.

Manual deploy from this machine: `npm run build && npx wrangler login && npx wrangler deploy`.

After the first deploy (or once a custom domain is attached), update `site` in
`astro.config.mjs` and the sitemap URL in `public/robots.txt`.
