import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { TOPIC_IDS } from './lib/topics';

/** A cited work; see lib/remark-citations.mjs. Field names follow BibTeX where possible. */
const reference = z.object({
  author: z.union([z.string(), z.array(z.string())]).optional(),
  title: z.string(),
  venue: z.string().optional(), // journal, conference, publisher, or website
  year: z.union([z.number(), z.string()]).optional(),
  url: z.url().optional(),
  doi: z.string().optional(),
  note: z.string().optional(),
});

const blog = defineCollection({
  // The file name (minus extension) becomes the article id and URL: /articles/<id>/
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    topics: z.array(z.enum(TOPIC_IDS)).default([]),
    draft: z.boolean().default(false),
    /** Works cited in the body as [@key]. */
    references: z.record(z.string(), reference).default({}),
    /** Keys listed in References without being cited in the text (LaTeX \nocite). */
    nocite: z.array(z.string()).default([]),
  }),
});

export const collections = { blog };
