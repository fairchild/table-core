// Pages mode when a refresh fails or a count ages: saved rows stay on screen, empty pages aren't held, and the pager
// agrees with the rows shown. Each test was shown failing before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerRowsStore, type ServerRowsConfig, type ServerRowsRequest } from '../src/index.ts';

type Row = { id: number };
const rows = (from: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: from + i }));
type P = { req: ServerRowsRequest; resolve: (v: unknown) => void; reject: (e: unknown) => void; done?: boolean };
const flush = () => new Promise((r) => setTimeout(r, 0));
const NONE = { sort: [] };

function setup(extra: Partial<ServerRowsConfig<Row>> = {}) {
  const reqs: P[] = []; const counts: P[] = [];
  let clock = 1000;
  const mk = (list: P[]) => (req: any) => new Promise((resolve, reject) => {
    const p: P = { req, resolve: (v) => { p.done = true; resolve(v); }, reject: (e) => { p.done = true; reject(e); } };
    list.push(p);
    req.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) as never;
  const base: ServerRowsConfig<Row> = { view: NONE, pageSize: 2, staleAfter: 100, now: () => clock, fetchRows: mk(reqs), fetchCount: mk(counts), ...extra };
  const store = new ServerRowsStore<Row>(base);
  store.start();
  const open = () => reqs.filter((r) => !r.done && !r.req.signal.aborted);
  return {
    store, reqs, counts, open,
    tick: (ms: number) => { clock += ms; },
    snap: () => store.getSnapshot(),
    /** Answer the one open request. */
    async answer(value: { rows: Row[]; total?: unknown; nextCursor?: string | null }) {
      const o = open();
      assert.equal(o.length, 1, `${o.length} open requests`);
      o[0].resolve(value);
      await flush();
    },
    /**
     * Serve every open request from an offset server with `items` rows and no total on its pages, and answer every
     * open count with `items` unless `answerCounts` is false. Returns how many row requests it answered.
     */
    async serve(items: number, answerCounts = true) {
      let served = 0;
      for (let g = 0; g < 100; g++) {
        const o = open();
        const c = answerCounts ? counts.filter((r) => !r.done && !r.req.signal.aborted) : [];
        if (!o.length && !c.length) return served;
        for (const r of o) r.resolve({ rows: rows(r.req.offset, Math.max(0, Math.min(r.req.limit, items - r.req.offset))) });
        for (const r of c) r.resolve(items);
        served += o.length;
        await flush();
      }
      return served;
    },
  };
}

const pageOf = (t: ReturnType<typeof setup>) => { const p = t.snap().paging; return p.kind === 'pages' ? p.page : -1; };

test('a failed refetch of a page past a newer count keeps its rows, says so, and the pager agrees with them', async () => {
  // Pages mode, pageSize 3, a total on page 0 only, no fetchCount.
  const t = setup({ mode: 'pages', pageSize: 3, fetchCount: undefined });
  await t.answer({ rows: rows(0, 3), total: 10 });
  t.store.setPage(3); await t.answer({ rows: rows(9, 1) });
  t.store.setPage(2); await t.answer({ rows: rows(6, 3) });
  t.tick(100);                                 // the cache ages
  t.store.setPage(0); await t.answer({ rows: rows(0, 3), total: 9 });
  t.store.setPage(2); await t.answer({ rows: rows(6, 3) });
  t.store.reload();
  t.store.setPage(3);                          // Next, while page 2 is being fetched again
  const refetch = t.open();
  assert.equal(refetch.length, 1);
  assert.equal(refetch[0].req.offset, 9);
  // While it runs, the pager shows the page whose rows are on screen.
  assert.deepEqual(t.snap().rows, rows(9, 1));
  assert.equal(pageOf(t), 3, `pager says ${JSON.stringify(t.snap().paging)} over page 3's row`);
  t.tick(50);
  refetch[0].reject(new Error('Timed out')); await flush();
  // It failed: the old rows stay, as saved data, and say so, with the time they were fetched.
  assert.deepEqual(t.snap().rows, rows(9, 1), 'the old rows stay');
  assert.equal(t.snap().state.failure?.scope, 'refresh', `failure: ${JSON.stringify(t.snap().state.failure)}`);
  assert.equal(t.snap().state.since?.getTime(), 1000, 'since is when the rows on screen were fetched');
  assert.equal(pageOf(t), 3);
  // Retry asks for that page again.
  t.snap().state.failure!.retry();
  assert.equal(t.open().length, 1);
  assert.equal(t.open()[0].req.offset, 9);
});

test('an empty deep link past an aged count asks for a new count, so rows added since are reachable', async () => {
  // A server that totals page 0 only, with fetchCount, pageSize 2, staleAfter 100.
  const t = setup({ mode: 'pages', pageSize: 2 });
  let size = 6;
  const page = async () => { const r = t.open()[0]; await t.answer({ rows: rows(r.req.offset, Math.max(0, Math.min(2, size - r.req.offset))) }); };
  await t.answer({ rows: rows(0, 2), total: 6 });         // t=1000
  t.tick(50); size = 8;                                   // t=1050: the list grows to 8
  t.tick(50);                                             // t=1100: the count is 100 old
  t.store.setPage(4); await page();                       // offset 8: empty
  assert.equal(t.counts.length, 1, 'no count was asked for');
  t.counts[0].resolve(8); await flush();
  while (t.open().length) await page();
  t.tick(50);                                             // t=1150
  t.store.setPage(3);
  assert.equal(pageOf(t), 3, `clamped to ${JSON.stringify(t.snap().paging)}`);
  await page();
  assert.deepEqual(t.snap().rows, rows(6, 2));
  assert.equal(t.snap().total, 8);
});

test('a deep link past the end with an aged count lands on the last page, once the count answers', async () => {
  for (const [items, deep, last] of [[100, 60, 49], [8, 4, 3]]) {
    const t = setup({ mode: 'pages', pageSize: 2 });
    await t.answer({ rows: rows(0, 2), total: items });
    t.tick(100);                                          // the count ages
    t.store.setPage(deep);
    await t.serve(items);
    assert.equal(pageOf(t), last, `${items} rows, setPage(${deep}) landed on ${JSON.stringify(t.snap().paging)}`);
  }
});

test('with a slow count, a deep link far past the end still takes a few requests', async () => {
  const t = setup({ mode: 'pages', pageSize: 2 });
  await t.answer({ rows: rows(0, 2), total: 6 });
  t.tick(100);
  t.store.setPage(1023);
  const asked = await t.serve(6, false);                  // the count hasn't answered yet
  assert.ok(asked <= 3, `${asked} row requests`);
  assert.equal(pageOf(t), 2);
  await t.serve(6);
  assert.equal(pageOf(t), 2);
  assert.deepEqual(t.snap().rows, rows(4, 2));
});

test('after a failed refresh, the pager keeps the count, and the count answering again keeps it', async () => {
  const t = setup({ mode: 'pages', pageSize: 2 });
  await t.answer({ rows: rows(0, 2), total: { atLeast: 4 } });
  t.counts[0].resolve(20); await flush();
  t.store.setPage(3); await t.answer({ rows: rows(6, 2) });
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 3, pageCount: 10 });
  t.store.reload();
  t.open()[0].reject(new Error('Offline')); await flush();
  const c = t.counts.at(-1)!;
  assert.ok(!c.done, 'the reload asks for the count again');
  c.resolve(20); await flush();
  assert.equal(t.snap().state.failure?.scope, 'refresh');
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 3, pageCount: 10 });
});

test('a failed refresh of a full last page doesn\'t offer a page past it', async () => {
  // Pages mode, page size 3, no fetchCount.
  const t = setup({ mode: 'pages', pageSize: 3, fetchCount: undefined });
  await t.answer({ rows: rows(0, 3), total: 9 });
  t.store.setPage(2); await t.answer({ rows: rows(6, 3), total: 9 });
  t.store.reload();
  t.open()[0].reject(new Error('Offline')); await flush();
  assert.deepEqual(t.snap().rows, rows(6, 3));
  assert.equal(t.snap().total, 9);
  assert.equal(t.snap().state.failure?.scope, 'refresh');
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 2, pageCount: 3 });
  t.snap().state.failure!.retry();
  assert.equal(t.open().length, 1);
  assert.equal(t.open()[0].req.offset, 6);
});

test('the pager holds still while the page on screen is fetched again', async () => {
  // No total, no fetchCount: page 0 is full, so there may be a page 1.
  const t = setup({ mode: 'pages', pageSize: 2, fetchCount: undefined });
  await t.answer({ rows: rows(0, 2) });
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 0, pageCount: 2 });
  const seen: number[] = [];
  t.store.subscribe(() => { const p = t.snap().paging; if (p.kind === 'pages') seen.push(p.pageCount); });
  t.store.reload();
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 0, pageCount: 2 }, 'Next is dead while page 0 is fetched again');
  await t.answer({ rows: rows(0, 2) });
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 0, pageCount: 2 });
  assert.deepEqual([...new Set(seen)], [2], `the page count went ${seen.join(' → ')}`);
});

test('while a count is redone, the pager doesn\'t go back to an older lower bound above it', async () => {
  const t = setup({ mode: 'pages', pageSize: 2 });
  await t.answer({ rows: rows(0, 2), total: { atLeast: 18 } });  // a lower bound, then a count below it
  t.counts[0].resolve(4); await flush();
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 0, pageCount: 2 });
  t.store.reload();                                               // the count of 4 is redone
  t.store.setPage(1);                                             // page 1 is on its way, the count is open
  assert.equal(t.snap().total, 4);
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 1, pageCount: 2 }, `pager rose to ${JSON.stringify(t.snap().paging)} over a total of 4`);
});

// A failed refresh holds saved rows, and an empty page has none to hold.
const noEmptyPageHeld = (t: ReturnType<typeof setup>) => {
  const s = t.snap();
  const p = s.paging;
  const held = s.state.failure?.scope === 'refresh' && p.kind === 'pages' && p.page > 0 && s.rows.length === 0;
  const seen = JSON.stringify({ paging: p, total: s.total, rows: s.rows.length });
  assert.ok(!held, `an empty page held after a failed refresh: ${seen}`);
};

test('a failed refresh of a cached empty page goes back to the last page with rows, not "No items"', async () => {
  // Pages mode, no total, no fetchCount, 4 rows, page size 2.
  const t = setup({ mode: 'pages', fetchCount: undefined });
  await t.answer({ rows: rows(0, 2) });
  t.store.setPage(1); await t.answer({ rows: rows(2, 2) });
  t.store.setPage(2); await t.answer({ rows: [] });       // empty: back to page 1
  assert.equal(pageOf(t), 1);
  assert.deepEqual(t.snap().rows, rows(2, 2));
  t.tick(101);                                              // past staleAfter
  t.store.setPage(2);
  const o = t.open();
  assert.equal(o.length, 1, `${o.length} open requests`);
  o[0].reject(new Error('Offline')); await flush();
  noEmptyPageHeld(t);
  assert.equal(pageOf(t), 1);
  assert.deepEqual(t.snap().rows, rows(2, 2));
});

