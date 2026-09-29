// Verify that every internal link, image and #anchor in the built site resolves.
// Usage: node scripts/check-links.mjs [dist]   (run after `astro build`)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ?? 'dist';

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? htmlFiles(p) : e.name.endsWith('.html') ? [p] : [];
  });
}

/** Map a URL path to the file the static host would serve, or null. */
function resolve(path) {
  const p = join(root, decodeURIComponent(path));
  if (existsSync(p) && statSync(p).isFile()) return p;
  if (existsSync(join(p, 'index.html'))) return join(p, 'index.html');
  if (existsSync(`${p}.html`)) return `${p}.html`;
  return null;
}

const idCache = new Map();
function ids(file) {
  if (!idCache.has(file)) {
    const html = readFileSync(file, 'utf8');
    idCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return idCache.get(file);
}

const errors = [];
const files = htmlFiles(root);

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const page = '/' + relative(root, file).replace(/index\.html$/, '').replace(/\.html$/, '');
  for (const [, attr, raw] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    const url = raw.replaceAll('&amp;', '&');
    if (/^([a-z]+:|\/\/)/i.test(url) || url === '') continue; // external, mailto:, data:, etc.

    const [pathAndQuery, hash] = url.split('#');
    const path = pathAndQuery.split('?')[0];
    const target = path === '' ? file : resolve(path.startsWith('/') ? path : join(page, path));

    if (!target) {
      errors.push(`${relative(root, file)}: broken ${attr} → ${url}`);
    } else if (hash && target.endsWith('.html') && !ids(target).has(decodeURIComponent(hash))) {
      errors.push(`${relative(root, file)}: missing anchor → ${url}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n✗ ${errors.length} broken link(s) in ${files.length} pages`);
  process.exit(1);
}
console.log(`✓ All internal links resolve (${files.length} pages)`);
