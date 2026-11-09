// What fetchRows or fetchCount resolves with that isn't a response fails like an error, and Load more stays
// offered while its page loads. The undefined and null rows cases already passed on main (reading `res.rows` threw);
// they stay as regression cover. Every other test was shown failing before its fix, or with its clause removed.
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

for (const [name, bad] of NOT_ROWS) {
  test(`a first page that resolves with ${name} fails the load, and retry recovers`, async () => {
    const t = setup({ fetchCount: undefined });
    const seen = await rejections(() => t.answer(bad));
    assert.deepEqual(seen.map(String), [], 'an unhandled rejection');
    assert.equal(t.snap().state.fetching, false, 'still fetching');
    assert.equal(t.snap().state.failure?.scope, 'load', `failure: ${JSON.stringify(t.snap().state)}`);
    assert.doesNotThrow(() => t.snap().state.failure!.retry());
    await t.answer({ rows: rows(0, 2) });
    assert.deepEqual(t.snap().rows, rows(0, 2));
    assert.equal(t.snap().state.failure, undefined);
  });

  test(`Load more that resolves with ${name} keeps the rows, says the next page failed, and retry recovers`, async () => {
    const t = setup({ fetchCount: undefined });
    await t.answer({ rows: rows(0, 2) });
    t.store.loadMore();
    const seen = await rejections(() => t.answer(bad));
    assert.deepEqual(seen.map(String), [], 'an unhandled rejection');
    assert.deepEqual(t.snap().rows, rows(0, 2), 'the rows on screen stay');
    assert.equal(t.snap().state.fetching, false);
    assert.equal(t.snap().state.failure?.scope, 'more', `failure: ${JSON.stringify(t.snap().state)}`);
    t.snap().state.failure!.retry();
    await t.answer({ rows: rows(2, 1) });
    assert.deepEqual(t.snap().rows, rows(0, 3));
    assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: false });
  });
}

const NOT_COUNTS: Array<[string, unknown]> = [
  ['an object', { count: 10 }], ['a numeric string', '10'], ['NaN', NaN], ['Infinity', Infinity], ['a negative number', -1],
  ['null', null], ['undefined', undefined], ['true', true],
];

for (const [name, bad] of NOT_COUNTS) {
  test(`a count of ${name} is a failed count, not a total`, async () => {
    const t = setup();
    await t.answer({ rows: rows(0, 2), total: { atLeast: 10 } });
    assert.equal(t.counts.length, 1);
    const seen = await rejections(async () => { t.counts[0].resolve(bad); await flush(); });
    assert.deepEqual(seen.map(String), []);
    assert.deepEqual(t.snap().total, { atLeast: 10 }, `total: ${JSON.stringify(t.snap().total)}`);
    assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
  });
}

test('while a view\'s first page loads, there is no Load more: on the first visit and after a sort', async () => {
  const t = setup({ fetchCount: undefined });
  assert.equal(t.snap().state.rows, 'none');
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: false }, 'Load more offered before any row arrived');
  await t.answer({ rows: rows(0, 2) });
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
  t.store.update({ view: { sort: [{ columnId: 'id', direction: 'descending' }] }, pageSize: 2, fetchRows: t.fetchRows });
  assert.equal(t.snap().state.rows, 'previous');
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: false }, 'Load more offered for the last view\'s rows');
});

test('Load more stays offered while its page loads, and pressing it again asks for nothing more', async () => {
  const t = setup({ fetchCount: undefined });
  await t.answer({ rows: rows(0, 2) });
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
  t.store.loadMore();
  assert.equal(t.snap().state.fetching, true);
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true }, 'Load more went away while its page loads');
  t.store.loadMore();
  t.store.loadMore();
  assert.equal(t.open().length, 1, 'a second press asked for another page');
  assert.equal(t.open()[0].req.offset, 2);
  await t.answer({ rows: rows(2, 2) });
  assert.deepEqual(t.snap().rows, rows(0, 4));
});
