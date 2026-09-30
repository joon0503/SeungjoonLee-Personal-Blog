// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkCitations from './src/lib/remark-citations.mjs';

export default defineConfig({
  // Production URL. Used for canonical links, Open Graph URLs and the sitemap.
  // Update this once the Cloudflare Pages project / custom domain is known.
  site: 'https://seungjoonlee.pages.dev',

  integrations: [mdx(), sitemap()],

  markdown: {
    // remark-math parses $...$ and $$...$$; rehype-katex renders them to HTML at build time,
    // so no math JavaScript is shipped to the browser. remark-citations turns [@key] into
    // numbered citations and appends the References section. MDX inherits this processor.
    processor: unified({
      remarkPlugins: [remarkMath, remarkCitations],
      rehypePlugins: [rehypeKatex],
    }),
    shikiConfig: {
      // Dual themes: colors switch with the light/dark toggle (see styles/global.css).
      themes: { light: 'github-light', dark: 'github-dark' },
    },
  },

  // Fonts are downloaded at build time and self-hosted from /_astro.
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: 'Source Serif 4',
      cssVariable: '--font-serif',
      weights: ['400 700'],
      styles: ['normal', 'italic'],
      fallbacks: ['Georgia', 'serif'],
    },
    {
      provider: fontProviders.fontsource(),
      name: 'Inter',
      cssVariable: '--font-sans',
      weights: ['400 700'],
      styles: ['normal', 'italic'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
    {
      provider: fontProviders.fontsource(),
      name: 'JetBrains Mono',
      cssVariable: '--font-mono',
      weights: ['400 600'],
      styles: ['normal'],
      fallbacks: ['ui-monospace', 'monospace'],
    },
  ],
});
