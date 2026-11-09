// Install the packed tarball into an empty project and use it the way a consumer would: type-check a file against
// the published types, then run it. Catches a broken `exports`, `files` or `types` before a release.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'table-core-smoke-'));
const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

try {
  const [{ filename }] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', dir], root));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(dir, filename)]);

  writeFileSync(join(dir, 'use.ts'), `
import { ServerRowsStore, setSelected, type Selection, type TableView } from '@fairchild/table-core';
const view: TableView = { sort: [] };
const store = new ServerRowsStore<{ id: string }>({ view, fetchRows: async () => ({ rows: [{ id: 'a' }], total: 1 }) });
const sel: Selection = setSelected({ kind: 'ids', ids: new Set() }, ['a'], true);
store.start();
await new Promise((r) => setTimeout(r, 0));
const { rows, total } = store.getSnapshot();
if (rows.length !== 1 || total !== 1 || sel.kind !== 'ids') throw new Error('unexpected snapshot');
console.log('runs from the tarball');
`);
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, lib: ['es2022', 'dom'] },
    files: ['use.ts'],
  }));
  run('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(dir, 'tsconfig.json')]);
  console.log('types resolve from the tarball');
  console.log(run('node', ['--experimental-strip-types', '--no-warnings', 'use.ts']));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
