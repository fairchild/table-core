// Copies the built package into docs/vendor/table-core/, where the landing page's import map points, so the live
// demo runs on the real dist. `npm run docs` builds and copies; `npm run docs:serve` also serves docs/ locally.
import { cpSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const target = new URL('docs/vendor/table-core/', root);
rmSync(target, { recursive: true, force: true });
cpSync(new URL('dist/', root), target, { recursive: true, filter: (src) => !src.endsWith('.map') && !src.endsWith('.d.ts') });
console.log('Copied dist/ to docs/vendor/table-core/');
