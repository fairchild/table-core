// tsc rewrites `./x.ts` to `./x.js` in the emitted JavaScript (rewriteRelativeImportExtensions) but not in the
// declarations. TypeScript before 5.0 can't resolve a `.ts` specifier in a .d.ts, and silently types the package as
// `any`. Rewrite them the same way, so every consumer's TypeScript reads the same paths the JavaScript uses.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
for (const name of readdirSync(dist).filter((f) => f.endsWith('.d.ts'))) {
  const file = join(dist, name);
  const before = readFileSync(file, 'utf8');
  const after = before.replace(/(from\s+|import\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
  if (after !== before) writeFileSync(file, after);
}
