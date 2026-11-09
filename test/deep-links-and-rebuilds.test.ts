// Failed rebuilds, deep links past the end of a list with no totals, and Load more after a short page. Each test was
// shown failing before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerRowsStore, type ServerRowsConfig, type ServerRowsRequest } from '../src/index.ts';

type Row = { id: number };
const rows = (from: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: from + i }));
type P = { req: ServerRowsRequest; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const flush = () => new Promise((r) => setTimeout(r, 0));
function setup(extra: Partial<ServerRowsConfig<Row>> = {}) {
  const reqs: P[] = []; const counts: P[] = [];
  let clock = 1000;
  const mk = (list: P[]) => (req: any) => new Promise((resolve, reject) => {
    list.push({ req, resolve, reject });
    req.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) as never;
  const store = new ServerRowsStore<Row>({ view: { sort: [] }, pageSize: 2, now: () => clock, fetchRows: mk(reqs), fetchCount: mk(counts), ...extra });
  store.start();
  return { store, reqs, counts, fetchRows: mk(reqs), tick: (ms: number) => { clock += ms; }, snap: () => store.getSnapshot() };
}


test('a rebuild that fails keeps the count of the rows it leaves on screen, not the rebuilt pages\' count', async () => {
  const t = setup({ fetchCount: undefined });
  t.reqs[0].resolve({ rows: rows(0, 2), total: 10 }); await flush();
  t.store.loadMore();
  t.reqs[1].resolve({ rows: rows(2, 2), total: 10 }); await flush();
  assert.equal(t.snap().total, 10);
  t.store.reload();                         // rebuild aside: page 0, then page 1
  t.reqs[2].resolve({ rows: rows(100, 2), total: 8 }); await flush();
  t.reqs[3].reject(new Error('Timed out')); await flush();
  assert.deepEqual(t.snap().rows, [...rows(0, 2), ...rows(2, 2)], 'the old rows stay');
  assert.equal(t.snap().state.failure?.scope, 'refresh');
  assert.equal(t.snap().total, 10, `old rows shown with total ${JSON.stringify(t.snap().total)}`);
});

test('a deep link past the end of a list with no totals finds the last page in a few requests, not one per page', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined, pageSize: 10 });
  const items = 35;                         // pages 0..3; page 3 has 5 rows
  const serve = async () => {
    for (let guard = 0; guard < 50; guard++) {
      const open = t.reqs.filter((r) => !(r as any).done && !r.req.signal.aborted);
      if (!open.length) return;
      for (const r of open) {
        (r as any).done = true;
        const from = r.req.offset;
        r.resolve({ rows: rows(from, Math.max(0, Math.min(10, items - from))) });
      }
      await flush();
    }
  };
  await serve();
  const before = t.reqs.length;
  t.store.setPage(99);
  await serve();
  const p = t.snap().paging;
  assert.equal(p.kind === 'pages' && p.page, 3, `landed on ${JSON.stringify(p)}`);
  const asked = t.reqs.length - before;
  assert.ok(asked <= 10, `${asked} requests to walk back from page 99`);
});

test('load more by offset after a short page asks from the rows it has, so rows added meanwhile aren\'t skipped', async () => {
  const t = setup({ pageSize: 5, fetchCount: undefined });
  // A short page whose own total says more rows exist: rows were added after the server read the page.
  t.reqs[0].resolve({ rows: rows(0, 3), total: 9 }); await flush();
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
  t.store.loadMore();
  assert.equal(t.reqs[1].req.offset, 3, `asked from offset ${t.reqs[1].req.offset}, skipping rows 3 and 4`);
});

async function walk(items: number, deep: number) {
  const t = setup({ mode: 'pages', fetchCount: undefined, pageSize: 10 });
  const serve = async () => {
    for (let guard = 0; guard < 50; guard++) {
      const open = t.reqs.filter((r) => !(r as { done?: boolean }).done && !r.req.signal.aborted);
      if (!open.length) return;
      for (const r of open) {
        (r as { done?: boolean }).done = true;
        r.resolve({ rows: rows(r.req.offset, Math.max(0, Math.min(10, items - r.req.offset))) });
      }
      await flush();
    }
  };
  await serve();
  const before = t.reqs.length;
  t.store.setPage(deep);
  await serve();
  const p = t.snap().paging;
  return { page: p.kind === 'pages' ? p.page : -1, asked: t.reqs.length - before, rows: t.snap().rows.length };
}

test('the walk back lands on the last page wherever the list ends', async () => {
  assert.deepEqual(await walk(40, 99), { page: 3, asked: (await walk(40, 99)).asked, rows: 10 }, 'ends on a page boundary');
  assert.equal((await walk(40, 99)).asked <= 10, true);
  assert.deepEqual(await walk(0, 7), { page: 0, asked: (await walk(0, 7)).asked, rows: 0 }, 'an empty list');
  const short = await walk(35, 4);
  assert.equal(short.page, 3, 'a deep link one page past the end');
  assert.equal(short.rows, 5);
  const far = await walk(1001, 5000);
  assert.equal(far.page, 100);
  assert.ok(far.asked <= 16, `${far.asked} requests from page 5000 to page 100`);
});

// From review of the fixes above.
test('a failed rebuild keeps a count fetchCount gave during it, which is newer than the saved one', async () => {
  const t = setup();
  t.reqs[0].resolve({ rows: rows(0, 2), total: { atLeast: 2 } }); await flush();
  assert.equal(t.counts.length, 1);
  t.counts[0].resolve(10); await flush();
  t.store.loadMore();
  t.reqs[1].resolve({ rows: rows(2, 2) }); await flush();
  assert.equal(t.snap().total, 10);
  t.store.reload();
  assert.equal(t.counts.length, 2, 'recount asked');
  t.reqs[2].resolve({ rows: rows(0, 2) }); await flush();   // rebuild page 0
  t.counts[1].resolve(12); await flush();                   // fresh server count
  assert.equal(t.snap().total, 12);
  t.reqs[3].reject(new Error('Timed out')); await flush();  // rebuild page 1 fails
  assert.equal(t.counts.length, 2, 'not asked again this visit');
  assert.equal(t.snap().total, 12, `fresh count lost: total ${JSON.stringify(t.snap().total)}`);
});

const serveAll = async (t: ReturnType<typeof setup>, items: number) => {
  for (let g = 0; g < 50; g++) {
    const open = t.reqs.filter((r) => !(r as { done?: boolean }).done && !r.req.signal.aborted);
    if (!open.length) return;
    for (const r of open) { (r as { done?: boolean }).done = true; r.resolve({ rows: rows(r.req.offset, Math.max(0, Math.min(10, items - r.req.offset))) }); }
    await flush();
  }
};
test('changing the sort while finding the end starts the new view on its first page', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined, pageSize: 10 });
  await serveAll(t, 35);
  t.store.setPage(99);
  const r99 = t.reqs.at(-1)!; (r99 as { done?: boolean }).done = true; r99.resolve({ rows: [] }); await flush();
  // walk has moved to 49, request in flight; user now sorts
  t.store.update({ view: { sort: [{ columnId: 'name', direction: 'ascending' }] }, mode: 'pages', pageSize: 10, fetchRows: t.fetchRows });
  const r0 = t.reqs.at(-1)!; assert.equal(r0.req.offset, 0);
  (r0 as { done?: boolean }).done = true; r0.resolve({ rows: rows(0, 10) }); await flush();
  const p = t.snap().paging;
  assert.equal(p.kind === 'pages' && p.page, 0, `new view jumped to ${JSON.stringify(p)}`);
});
