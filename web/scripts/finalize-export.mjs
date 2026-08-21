/**
 * Makes the exported directory safe to publish as a GitHub Pages site.
 *
 * Pages runs everything it serves through Jekyll unless told not to, and Jekyll drops any path
 * beginning with an underscore. That is exactly where Next puts every script, stylesheet and
 * font, so without `.nojekyll` the site deploys and then loads as unstyled markup with no
 * JavaScript. The file has to exist in the published output, not in the repository, which is
 * why it is written here rather than checked in.
 *
 * Runs automatically after `build`.
 */

import { writeFileSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

if (!existsSync(OUT)) {
  console.error('no out/ directory — run the build first');
  process.exit(1);
}

writeFileSync(join(OUT, '.nojekyll'), '');

/**
 * The router prefetches each route's payload as `…/__next.<route>.__PAGE__.txt`, but the export
 * writes that payload into a *directory* called `__next.<route>` instead. On a host that serves
 * flat files and nothing else — which is the whole point of this build — every prefetch is a
 * 404 in the console. The navigation still works, because it falls back to loading the page,
 * but the errors are real and a reader opening dev tools deserves a clean one. So each payload
 * is also written at the path that is actually asked for.
 */
let flattened = 0;
function flattenPayloads(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    if (entry.startsWith('__next.')) {
      for (const file of readdirSync(path)) {
        const source = join(path, file);
        if (!statSync(source).isFile()) continue;
        copyFileSync(source, join(dir, `${entry}.${file}`));
        flattened += 1;
      }
    } else {
      flattenPayloads(path);
    }
  }
}
flattenPayloads(OUT);

// Pages serves 404.html for anything it cannot find. Next writes one; keep it at the root so a
// mistyped path lands on the register's own page rather than on GitHub's.
if (!existsSync(join(OUT, '404.html')) && existsSync(join(OUT, '404', 'index.html'))) {
  copyFileSync(join(OUT, '404', 'index.html'), join(OUT, '404.html'));
}

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
console.log(
  `export finalised in out/ · basePath ${basePath || '(none — user or organisation page)'} · ` +
    `.nojekyll written · ${flattened} route payload(s) flattened`,
);
