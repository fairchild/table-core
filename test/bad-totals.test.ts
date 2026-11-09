// A rows response whose `total` isn't a total (NaN, a negative number, a string, a bad bound) fails like a
// malformed response instead of deciding paging: in pages mode a NaN total requested pages without end. And
// a malformed refresh of a page already on screen keeps that page, in both modes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerRowsStore, type ServerRowsConfig, type ServerRowsRequest } from '../src/index.ts';

type Row = { id: number };
const rows = (from: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: from + i }));
type P = { req: ServerRowsRequest; resolve: (v: unknown) => void; reject: (e: unknown) => void; done?: boolean };
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(extra: Partial<ServerRowsConfig<Row>> = {}) {
  const reqs: P[] = []; const counts: P[] = [];
  const mk = (list: P[]) => (req: any) => new Promise((resolve, reject) => {
    const p: P = { req, resolve: (v) => { p.done = true; resolve(v); }, reject: (e) => { p.done = true; reject(e); } };
    list.push(p);
    req.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) as never;
  const fetchRows = mk(reqs);
  const store = new ServerRowsStore<Row>({ view: { sort: [] }, pageSize: 2, fetchRows, fetchCount: mk(counts), ...extra });
  store.start();
  const open = () => reqs.filter((r) => !r.done && !r.req.signal.aborted);
  return {
    store, reqs, counts, open, fetchRows, snap: () => store.getSnapshot(),
    async answer(value: unknown) {
      const o = open();
      assert.equal(o.length, 1, `${o.length} open requests`);
      o[0].resolve(value);
      await flush(); await flush();
    },
  };
}

/** Collect unhandled rejections while `fn` runs. */
async function rejections(fn: () => Promise<void>) {
  const seen: unknown[] = [];
  const on = (e: unknown) => { seen.push(e); };
  process.on('unhandledRejection', on);
  try { await fn(); await flush(); } finally { process.off('unhandledRejection', on); }
  return seen;
}

const NOT_ROWS: Array<[string, unknown]> = [
  ['undefined', undefined], ['null', null], ['a number', 500], ['an object with no rows', { error: 'Internal Server Error' }],
  ['rows that aren\'t an array', { rows: 'nope' }],
];


const BAD_TOTALS: Array<[string, unknown]> = [
  ['NaN', NaN], ['Infinity', Infinity], ['-1', -1], ['a numeric string', '12'], ['true', true], ['an empty object', {}],
  ['{atLeast: \'x\'}', { atLeast: 'x' }], ['{atLeast: NaN}', { atLeast: NaN }], ['{atLeast: -1}', { atLeast: -1 }],
];

for (const mode of ['pages', 'load-more'] as const) {
  for (const [name, bad] of BAD_TOTALS) {
    test(`${mode}: rows with a total of ${name} are a failed load, not a total, and retry recovers`, async () => {
      const t = setup({ mode });
      try {
        const seen = await rejections(async () => {
          t.open()[0].resolve({ rows: rows(0, 2), total: bad });
          await flush(); await flush();
        });
        assert.deepEqual(seen.map(String), [], 'an unhandled rejection');
        assert.equal(t.reqs.length, 1, `${t.reqs.length} row requests`);
        assert.equal(t.counts.length, 0, 'fetchCount was asked about a total that isn\'t one');
        const s = t.snap();
        assert.equal(s.state.failure?.scope, 'load', `state: ${JSON.stringify(s.state)}, total: ${JSON.stringify(s.total)}`);
        assert.equal(s.total, undefined);
        if (s.paging.kind === 'pages') assert.ok(Number.isFinite(s.paging.page) && Number.isFinite(s.paging.pageCount), JSON.stringify(s.paging));
        s.state.failure!.retry();
        await t.answer({ rows: rows(0, 2), total: 6 });
        assert.deepEqual(t.snap().rows, rows(0, 2));
        assert.equal(t.snap().total, 6);
        assert.equal(t.snap().state.failure, undefined);
      } finally {
        t.store.stop();
      }
    });
  }

  test(`${mode}: a total of null or left out is no total, and the rows show`, async () => {
    for (const total of [null, undefined]) {
      const t = setup({ mode, fetchCount: undefined });
      await t.answer({ rows: rows(0, 2), total });
      assert.deepEqual(t.snap().rows, rows(0, 2));
      assert.equal(t.snap().state.failure, undefined);
      t.store.stop();
    }
  });

  // A malformed refresh of a page already held.
  for (const [name, bad] of NOT_ROWS) {
    test(`${mode}: a refresh that resolves with ${name} keeps the rows on screen, says so, and retry recovers`, async () => {
      const t = setup({ fetchCount: undefined, mode });
      await t.answer({ rows: rows(0, 2), total: 6 });
      t.store.reload();
      const seen = await rejections(() => t.answer(bad));
      assert.deepEqual(seen.map(String), [], 'an unhandled rejection');
      assert.deepEqual(t.snap().rows, rows(0, 2), 'the rows on screen stay');
      assert.equal(t.snap().state.rows, 'current');
      assert.equal(t.snap().state.fetching, false);
      assert.equal(t.snap().state.failure?.scope, 'refresh', `failure: ${JSON.stringify(t.snap().state)}`);
      t.snap().state.failure!.retry();
      await t.answer({ rows: rows(10, 2), total: 6 });
      assert.deepEqual(t.snap().rows, rows(10, 2));
      assert.equal(t.snap().state.failure, undefined);
    });
  }
}

// The loop needs a page past 0 (clampPage returns early on page 0, so a first-page test
// can't see it); a bad total on Load more and on a refresh; and 0 staying legal.
test('pages: a NaN total past page 0 is a failed load and asks for nothing more', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 9 });
  t.store.setPage(2);
  const seen = await rejections(() => t.answer({ rows: rows(4, 2), total: NaN }));
  assert.deepEqual(seen.map(String), [], 'an unhandled rejection');
  assert.equal(t.reqs.length, 2, `${t.reqs.length} row requests`);
  assert.equal(t.snap().state.failure?.scope, 'load');
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 2, pageCount: 5 });
  t.snap().state.failure!.retry();
  await t.answer({ rows: rows(4, 2), total: 9 });
  assert.deepEqual(t.snap().rows, rows(4, 2));
  assert.equal(t.snap().state.failure, undefined);
  t.store.stop();
});

for (const [name, bad] of BAD_TOTALS) {
  test(`Load more with a total of ${name} keeps the rows, says the next page failed, and retry recovers`, async () => {
    const t = setup({ fetchCount: undefined });
    await t.answer({ rows: rows(0, 2), total: 9 });
    t.store.loadMore();
    const seen = await rejections(() => t.answer({ rows: rows(2, 2), total: bad }));
    assert.deepEqual(seen.map(String), [], 'an unhandled rejection');
    assert.deepEqual(t.snap().rows, rows(0, 2), 'the rows on screen stay');
    assert.equal(t.snap().total, 9);
    assert.equal(t.snap().state.failure?.scope, 'more', `failure: ${JSON.stringify(t.snap().state)}`);
    t.snap().state.failure!.retry();
    await t.answer({ rows: rows(2, 2), total: 9 });
    assert.deepEqual(t.snap().rows, rows(0, 4));
    assert.equal(t.snap().state.failure, undefined);
    t.store.stop();
  });

  for (const mode of ['pages', 'load-more'] as const) {
    test(`${mode}: a refresh with a total of ${name} keeps the rows on screen and the count, and retry recovers`, async () => {
      const t = setup({ fetchCount: undefined, mode });
      await t.answer({ rows: rows(0, 2), total: 6 });
      t.store.reload();
      const seen = await rejections(() => t.answer({ rows: rows(10, 2), total: bad }));
      assert.deepEqual(seen.map(String), [], 'an unhandled rejection');
      assert.deepEqual(t.snap().rows, rows(0, 2), 'the rows on screen stay');
      assert.equal(t.snap().state.rows, 'current');
      assert.equal(t.snap().total, 6);
      assert.equal(t.snap().state.failure?.scope, 'refresh', `failure: ${JSON.stringify(t.snap().state)}`);
      t.snap().state.failure!.retry();
      await t.answer({ rows: rows(10, 2), total: 6 });
      assert.deepEqual(t.snap().rows, rows(10, 2));
      assert.equal(t.snap().state.failure, undefined);
      t.store.stop();
    });
  }
}

for (const mode of ['pages', 'load-more'] as const) {
  test(`${mode}: an empty list with a total of 0 is an empty list, not a failure`, async () => {
    const t = setup({ mode, fetchCount: undefined });
    await t.answer({ rows: [], total: 0 });
    assert.equal(t.snap().state.failure, undefined);
    assert.equal(t.snap().total, 0);
    t.store.stop();
  });
  test(`${mode}: a bound of zero is a bound, not a failure`, async () => {
    const t = setup({ mode, fetchCount: undefined });
    await t.answer({ rows: rows(0, 2), total: { atLeast: 0 } });
    assert.equal(t.snap().state.failure, undefined);
    t.store.stop();
  });
}

// The other routes to the same loop: a page or a page size that isn't a usable number.
test('pages: setPage with a page that isn\'t a finite number does nothing', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 9 });
  for (const page of [NaN, Infinity, -Infinity]) {
    assert.doesNotThrow(() => t.store.setPage(page), `setPage(${page})`);
    await flush();
    assert.equal(t.reqs.length, 1, `setPage(${page}): ${t.reqs.length} row requests`);
    assert.deepEqual(t.snap().paging, { kind: 'pages', page: 0, pageCount: 5 });
  }
  t.store.stop();
});

// Each page holds no more rows than its total, as rows above a total make it a lower bound of them (low-totals), and a
// total of 0 has to stay 0 to reach moveTo's check. Without that check, [NaN, 9], [Infinity, undefined] and [0, 0]
// loop; [Infinity, 9] doesn't loop either way, as its total keeps the end of the list a number.
for (const [pageSize, total] of [[NaN, 9], [Infinity, 9], [Infinity, undefined], [0, 0]] as const) {
  test(`pages: a page size of ${pageSize} with a total of ${total} doesn't loop`, async () => {
    const t = setup({ mode: 'pages', fetchCount: undefined, pageSize });
    const n = Math.min(2, total ?? 2);
    let threw: unknown;
    try {
      t.open()[0]?.resolve({ rows: rows(0, n), total }); await flush(); await flush();
      t.store.setPage(1);
      for (const r of t.open()) r.resolve({ rows: rows(2, n), total });
      await flush(); await flush();
    } catch (e) { threw = e; }
    assert.equal(threw, undefined);
    assert.ok(t.reqs.length <= 3, `${t.reqs.length} row requests`);
    t.store.stop();
  });
}
