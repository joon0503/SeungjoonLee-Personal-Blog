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
```

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
  (or plain Markdown `![alt](/figures/...)`).
- In MDX, `{` `}` and `<` outside math and code are JSX syntax — escape them (`\{`) in prose.

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
│   ├── Header, Footer, TableOfContents, ArticleList, TopicTags, Figure
│   ├── mdx.ts                # components available in every article
│   └── interactive/          # interactive figures
├── layouts/                  # BaseLayout (SEO, fonts), ArticleLayout (TOC, prev/next, related)
├── lib/                      # articles.ts (queries), topics.ts (topic registry), when-visible.ts
├── pages/                    # /, /articles/, /articles/[slug]/, /topics/, /topics/[topic]/, /about/, 404
└── styles/global.css         # tokens, typography, prose, code and math styles
public/                       # favicon, robots.txt, _headers (Cloudflare cache rules), figures/, images/
```

## Deployment (Cloudflare Workers)

The site is deployed as a static-assets-only Cloudflare Worker, configured in `wrangler.jsonc`
(serves `dist/`, trailing-slash URLs, `404.html` for unknown paths, headers from `public/_headers`).

Connect the GitHub repository under **Workers & Pages → Create → Import a repository** with:

| Setting         | Value               |
| --------------- | ------------------- |
| Production branch | `main`            |
| Build command   | `npm run build`     |
| Deploy command  | `npx wrangler deploy` |

Every push to `main` deploys; pushes to other branches get preview URLs (if enabled).

Manual deploy from this machine: `npm run build && npx wrangler login && npx wrangler deploy`.

After the first deploy (or once a custom domain is attached), update `site` in
`astro.config.mjs` and the sitemap URL in `public/robots.txt`.
