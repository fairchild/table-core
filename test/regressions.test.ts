// Found in review of the server rows store. Each test was shown failing before its fix.
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
  return { store, reqs, counts, tick: (ms: number) => { clock += ms; }, snap: () => store.getSnapshot() };
}

test('a rebuild that fails on a page asked for meanwhile keeps the old chain, and fetches nothing by itself', async () => {
  const t = setup();
  t.reqs[0].resolve({ rows: rows(0, 2), nextCursor: 'old-c1' }); await flush();
  t.store.reload();                       // rebuild page 0 aside
  assert.equal(t.reqs.length, 2);
  t.store.loadMore();                     // hasMore from the old page 0
  t.reqs[1].resolve({ rows: rows(100, 2), nextCursor: 'new-c1' }); await flush();
  assert.equal(t.reqs.length, 3);
  assert.equal(t.reqs[2].req.cursor, 'new-c1');
  t.reqs[2].reject(new Error('Timed out')); await flush();
  // Doc: "The store never retries by itself within a visit." and "you never see old and new pages mixed".
  assert.equal(t.reqs.length, 3, `retried by itself: request ${t.reqs.length - 1} cursor=${t.reqs[3]?.req.cursor}`);
  // The old page stays on screen as saved data, and Load more asks for its next page, on its own cursor.
  assert.deepEqual(t.snap().rows, rows(0, 2));
  assert.equal(t.snap().state.failure?.scope, 'refresh');
  t.store.loadMore();
  assert.equal(t.reqs.length, 4);
  assert.equal(t.reqs[3].req.cursor, 'old-c1');
});

test('every command is a bound function, update included', () => {
  const t = setup();
  const { update } = t.store;
  assert.doesNotThrow(() => update({ view: { sort: [] }, pageSize: 2, fetchRows: async () => ({ rows: [] }) }));
});

test('a short last page by offset settles the count, with no exact count before it', async () => {
  const t = setup({ fetchCount: undefined });
  t.reqs[0].resolve({ rows: rows(0, 2), total: { atLeast: 2 } }); await flush();
  t.store.loadMore();
  t.reqs[1].resolve({ rows: rows(2, 1) }); await flush();
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: false });
  assert.equal(t.snap().total, 3, `total is ${JSON.stringify(t.snap().total)}`);
});

test('stop() ends fetching in the snapshot, and tells subscribers', async () => {
  const t = setup();
  assert.equal(t.snap().state.fetching, true);
  let told = 0;
  t.store.subscribe(() => { told++; });
  t.store.stop(); await flush();
  assert.equal(t.snap().state.fetching, false);
  assert.equal(told, 1);
});

test('a reload asks for a new count when the count came from a page and the fresh page gives only a lower bound', async () => {
  const t = setup({ mode: 'pages' });
  t.reqs[0].resolve({ rows: rows(0, 2), total: { atLeast: 2 } }); await flush();
  t.counts[0].resolve(5); await flush();
  assert.equal(t.snap().total, 5);
  t.store.setPage(2);                       // the last page says the total itself
  t.reqs[1].resolve({ rows: rows(4, 1), total: 5 }); await flush();
  t.store.setPage(0);
  t.store.reload();                         // e.g. a row was archived on the server
  const before = t.counts.length;
  const last = t.reqs[t.reqs.length - 1];
  assert.equal(last.req.offset, 0);
  last.resolve({ rows: rows(0, 2), total: { atLeast: 2 } }); await flush();
  assert.equal(t.counts.length, before + 1, 'no new count was asked for');
  t.counts[t.counts.length - 1].resolve(4); await flush();
  assert.equal(t.snap().total, 4);
});

test('a short page by offset stays open when its own total says there are more rows', async () => {
  const t = setup({ pageSize: 5, fetchCount: undefined });
  t.reqs[0].resolve({ rows: rows(0, 3), total: 20 }); await flush();
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
  t.store.loadMore();
  assert.equal(t.reqs.length, 2, 'loadMore() asked for nothing');
});

test('a short page by offset doesn\'t settle the count below its own lower bound', async () => {
  const t = setup({ pageSize: 5 });
  t.reqs[0].resolve({ rows: rows(0, 3), total: { atLeast: 30 } }); await flush();
  assert.deepEqual(t.snap().total, { atLeast: 30 });
  assert.equal(t.counts.length, 1, 'no count was asked for');
  t.counts[0].resolve(30); await flush();
  assert.equal(t.snap().total, 30);
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
});

test('a count inferred from a short page gives way when a reload brings more rows than it', async () => {
  const t = setup({ fetchCount: undefined });
  t.reqs[0].resolve({ rows: rows(0, 1) }); await flush();
  assert.equal(t.snap().total, 1);
  t.store.reload();                         // the list has grown
  t.reqs[1].resolve({ rows: rows(0, 2) }); await flush();
  assert.equal(t.snap().rows.length, 2);
  assert.equal(t.snap().total, undefined, `${t.snap().rows.length} rows on screen with total ${JSON.stringify(t.snap().total)}`);
});
