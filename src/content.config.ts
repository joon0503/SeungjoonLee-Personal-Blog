import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { TOPIC_IDS } from './lib/topics';

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
  }),
});

export const collections = { blog };
