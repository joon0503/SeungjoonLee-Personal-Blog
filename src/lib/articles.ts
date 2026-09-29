import { getCollection, type CollectionEntry } from 'astro:content';
import type { TopicId } from './topics';

export type Article = CollectionEntry<'blog'>;

/** Published articles, newest first. Drafts are visible in `npm run dev` only. */
export async function getArticles(): Promise<Article[]> {
  const entries = await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft);
  return entries.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export function articleHref(article: Article): string {
  return `/articles/${article.id}/`;
}

export function articlesByTopic(articles: Article[], topic: TopicId): Article[] {
  return articles.filter((a) => a.data.topics.includes(topic));
}

/** Chronological neighbours: `previous` is older, `next` is newer. */
export function adjacentArticles(articles: Article[], current: Article) {
  const i = articles.findIndex((a) => a.id === current.id);
  return {
    previous: articles[i + 1],
    next: i > 0 ? articles[i - 1] : undefined,
  };
}

/** Articles sharing the most topics with `current`, ties broken by recency. */
export function relatedArticles(articles: Article[], current: Article, limit = 3): Article[] {
  const topics = new Set(current.data.topics);
  return articles
    .filter((a) => a.id !== current.id)
    .map((a) => ({ a, score: a.data.topics.filter((t) => topics.has(t)).length }))
    .filter(({ score }) => score > 0)
    .sort((x, y) => y.score - x.score || y.a.data.date.valueOf() - x.a.data.date.valueOf())
    .slice(0, limit)
    .map(({ a }) => a);
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatDate(date: Date): string {
  return dateFormat.format(date);
}

/** Plain-text summary of an article body (~160 chars), for meta descriptions. */
export function summarize(body: string | undefined, maxLength = 160): string | undefined {
  if (!body) return undefined;
  const text = body
    .replace(/^import .*$/gm, '')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#+ .*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  if (text.length <= maxLength) return text;
  return text.slice(0, text.lastIndexOf(' ', maxLength)) + '…';
}
