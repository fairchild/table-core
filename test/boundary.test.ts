// The package's own boundary: it depends on nothing, and nothing in it reaches outside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const sources = readdirSync(new URL('src/', root)).filter((f) => f.endsWith('.ts'));
const specifiers = (file: string) =>
  [...readFileSync(new URL(`src/${file}`, root), 'utf8').matchAll(/\bfrom\s+(['"`])([^'"`]+)\1|\bimport\s*\(\s*(['"`])([^'"`]+)\3|^\s*import\s+(['"`])([^'"`]+)\5/gm)].map((m) => m[2] ?? m[4] ?? m[6]);

test('no runtime or peer dependencies: the core runs wherever JavaScript does', () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), []);
});

test('sources import only each other: no React, no DOM, no files outside the package', () => {
  for (const file of sources) {
    for (const spec of specifiers(file)) {
      assert.match(spec, /^\.\/[\w-]+\.ts$/, `${file} imports ${spec}`);
    }
  }
});

test('the package exports one entry, and it is built', () => {
  assert.deepEqual(Object.keys(pkg.exports), ['.', './package.json']);
  assert.equal(pkg.exports['.'].types, './dist/index.d.ts');
  assert.equal(pkg.sideEffects, false);
});

test('built declarations import .js paths, like the built JavaScript (TypeScript before 5.0 reads no .ts paths)', () => {
  const dist = new URL('dist/', root);
  const files = readdirSync(dist).filter((f) => f.endsWith('.d.ts'));
  assert.ok(files.includes('index.d.ts'), 'run npm run build first');
  for (const file of files) {
    const text = readFileSync(new URL(file, dist), 'utf8');
    assert.doesNotMatch(text, /from\s+'\.{1,2}\/[^']+\.ts'/, `${file} imports a .ts path`);
  }
});
