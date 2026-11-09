// Consistency between refreshed data, totals and paging. Each test checks rows, total and paging
// together, because the bugs were in how they drifted apart.
import { test } from 'node:test';
import { expect } from './expect.ts';
import { ServerRowsStore, type ServerRowsConfig, type ServerRowsRequest, type TableView } from '../src/index.ts';

type Row = { id: number };
const rows = (from: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: from + i }));
const NONE: TableView = { sort: [] };
const BY_ID: TableView = { sort: [{ columnId: 'id', direction: 'descending' }] };
const flush = () => new Promise((r) => setTimeout(r, 0));

type Pending<T> = { req: T; resolve: (v: unknown) => void; reject: (e: unknown) => void; open: () => boolean };
function setup(config: Partial<ServerRowsConfig<Row>> = {}) {
  const requests: Array<Pending<ServerRowsRequest>> = [];
  const counts: Array<Pending<{ view: TableView }>> = [];
  const defer = <T,>(list: Array<Pending<T>>, req: T, signal: AbortSignal) =>
    new Promise((resolve, reject) => {
      let settled = false;
      list.push({ req, resolve: (v) => { settled = true; resolve(v); }, reject: (e) => { settled = true; reject(e); }, open: () => !settled && !signal.aborted });
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  let clock = 1_000;
  const base: ServerRowsConfig<Row> = {
    view: NONE, pageSize: 2, staleAfter: 100, now: () => clock,
    fetchRows: (r) => defer(requests, r, r.signal) as never,
    fetchCount: (r) => defer(counts, r, r.signal) as never,
    ...config,
  };
  const store = new ServerRowsStore<Row>(base);
  store.start();
  const openRows = () => requests.filter((p) => p.open());
  const openCounts = () => counts.filter((p) => p.open());
  return {
    store, requests, counts, openRows, openCounts,
    snap: () => store.getSnapshot(),
    ids: () => store.getSnapshot().rows.map((r) => r.id),
    tick: (ms: number) => { clock += ms; },
    update: (changes: Partial<ServerRowsConfig<Row>>) => store.update({ ...base, ...changes }),
    /** Answer the one open rows request. */
    async rows(value: { rows: Row[]; total?: unknown; nextCursor?: string | null }) {
      const open = openRows();
      expect(open).toHaveLength(1);
      open[0].resolve(value);
      await flush();
    },
    async failRows() {
      const open = openRows();
      expect(open).toHaveLength(1);
      open[0].reject(new Error('Timed out'));
      await flush();
    },
    async count(n: number) {
      const open = openCounts();
      expect(open).toHaveLength(1);
      open[0].resolve(n);
      await flush();
    },
  };
}

test('server growth between visits: a refreshed {atLeast} beyond the old exact count opens the new rows', async () => {
  // The review's reproduction: two rows, exact total 2; another sort; the cache expires and the server grows to four.
  const t = setup();
  await t.rows({ rows: rows(0, 2), total: 2 });
  expect(t.snap().total).toBe(2);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
  t.update({ view: BY_ID });
  await t.rows({ rows: rows(10, 2), total: 2 });
  t.tick(500);
  t.update({ view: NONE });
  await t.rows({ rows: rows(0, 2), total: { atLeast: 4 } });
  // The old exact count is contradicted: the total is the new lower bound, Load more is offered, and a count is asked.
  expect(t.snap().total).toEqual({ atLeast: 4 });
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
  expect(t.openCounts()).toHaveLength(1);
  await t.count(4);
  expect(t.snap().total).toBe(4);
  t.store.loadMore();
  expect(t.openRows()[0].req.offset).toBe(2);
  await t.rows({ rows: rows(2, 2), total: 4 });
  expect(t.ids()).toEqual([0, 1, 2, 3]);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
});

test('server growth with an uninformative bound: a stale exact count is asked for again, and paging trusts the rows', async () => {
  const t = setup();
  await t.rows({ rows: rows(0, 2), total: { atLeast: 2 } });
  await t.count(2);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
  t.update({ view: BY_ID });
  await t.rows({ rows: rows(10, 2), total: 2 });
  t.tick(500);
  t.update({ view: NONE });
  // The refreshed page is full and says only "at least 2": the old count (2) can't bound paging any more.
  await t.rows({ rows: rows(0, 2), total: { atLeast: 2 } });
  expect(t.openCounts()).toHaveLength(1);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
  await t.count(5);
  expect(t.snap().total).toBe(5);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
});

test('server shrinkage between visits: the refreshed count and rows agree, and Load more goes away', async () => {
  const t = setup();
  await t.rows({ rows: rows(0, 2), nextCursor: 'c1', total: 4 });
  t.store.loadMore();
  await t.rows({ rows: rows(2, 2), nextCursor: null, total: 4 });
  t.update({ view: BY_ID });
  await t.rows({ rows: rows(10, 2), total: 2 });
  t.tick(500);
  t.update({ view: NONE });
  // Back to two pages loaded? No: a new visit shows one page. It comes back as the whole list now.
  await t.rows({ rows: rows(0, 1), nextCursor: null, total: 1 });
  expect(t.ids()).toEqual([0]);
  expect(t.snap().total).toBe(1);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
});

test('pages mode, shrinkage between visits: the page past the new end steps back, and the count matches', async () => {
  const t = setup({ mode: 'pages' });
  await t.rows({ rows: rows(0, 2), total: 6 });
  t.store.setPage(2);
  await t.rows({ rows: rows(4, 2), total: 6 });
  t.tick(500);
  t.store.setPage(1);
  await t.rows({ rows: rows(2, 2), total: 6 });
  t.tick(500);
  t.store.setPage(2); // stale: refetched, and the server now has three rows
  await t.rows({ rows: [], total: 3 });
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 1, pageCount: 2 });
  await t.rows({ rows: rows(2, 1), total: 3 });
  expect(t.ids()).toEqual([2]);
  expect(t.snap().total).toBe(3);
});

for (const order of ['count first', 'rows first'] as const) {
  test(`reload after a change: the same settled result whether the count arrives ${order === 'count first' ? 'before' : 'after'} the rows`, async () => {
    const t = setup();
    await t.rows({ rows: rows(0, 2), nextCursor: 'c1', total: { atLeast: 10 } });
    await t.count(10);
    t.store.reload();
    // Rows and a new count are asked for together.
    expect(t.openRows()).toHaveLength(1);
    expect(t.openCounts()).toHaveLength(1);
    if (order === 'count first') {
      await t.count(9);
      expect(t.snap().total).toBe(9);
      await t.rows({ rows: rows(0, 2), nextCursor: 'c1', total: { atLeast: 9 } });
    } else {
      await t.rows({ rows: rows(0, 2), nextCursor: 'c1', total: { atLeast: 9 } });
      expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
      await t.count(9);
    }
    expect(t.ids()).toEqual([0, 1]);
    expect(t.snap().total).toBe(9);
    expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
    expect(t.snap().state).toMatchObject({ rows: 'current', fetching: false });
  });
}

test('a count that answers before a visit\'s refreshed rows still ends consistent', async () => {
  const t = setup();
  await t.rows({ rows: rows(0, 2), total: { atLeast: 10 } });
  await t.count(10);
  t.update({ view: BY_ID });
  await t.rows({ rows: rows(20, 2), total: 10 });
  t.tick(500);
  t.update({ view: NONE }); // stale: rows refetched, and the count with them
  expect(t.openCounts()).toHaveLength(1);
  await t.count(3); // the count answers first: three rows now
  expect(t.snap().total).toBe(3);
  await t.rows({ rows: rows(0, 2), total: { atLeast: 3 } });
  expect(t.ids()).toEqual([0, 1]);
  expect(t.snap().total).toBe(3);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
});

test('a failed refresh keeps rows and count together as saved data; retry refreshes both', async () => {
  const t = setup();
  await t.rows({ rows: rows(0, 2), total: 2 });
  t.update({ view: BY_ID });
  await t.rows({ rows: rows(10, 2), total: 2 });
  t.tick(500);
  t.update({ view: NONE });
  await t.failRows();
  // The saved rows and the count that belongs to them stay; paging doesn't promise rows that may not exist.
  expect(t.ids()).toEqual([0, 1]);
  expect(t.snap().total).toBe(2);
  expect(t.snap().state).toMatchObject({ rows: 'current', failure: { scope: 'refresh' } });
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
  t.snap().state.failure!.retry();
  await t.rows({ rows: rows(0, 2), total: { atLeast: 6 } });
  expect(t.snap().state.failure).toBeUndefined();
  expect(t.snap().total).toEqual({ atLeast: 6 });
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
  await t.count(6);
  expect(t.snap().total).toBe(6);
});

// ---- Second review of the consistency rules ------------------------------------------------------------------------

test('offset paging: a short page ends the list even when an old exact count says there is more', async () => {
  const t = setup({ fetchCount: undefined });
  await t.rows({ rows: rows(0, 2), total: 10 });
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
  t.store.loadMore();
  await t.rows({ rows: rows(2, 1) }); // the server shrank to three rows
  expect(t.ids()).toEqual([0, 1, 2]);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
  expect(t.snap().total).toBe(3); // the short page says how many there are
});

test('offset paging: an empty next page ends the list and corrects the count', async () => {
  const t = setup({ fetchCount: undefined });
  await t.rows({ rows: rows(0, 2), total: 10 });
  t.store.loadMore();
  await t.rows({ rows: [] });
  expect(t.ids()).toEqual([0, 1]);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
  expect(t.snap().total).toBe(2);
});

test('a failed refresh keeps the count that matches the saved rows, even rows fetched after the count', async () => {
  const t = setup();
  await t.rows({ rows: rows(0, 2), total: { atLeast: 3 } });
  await t.count(4);
  t.tick(10);
  t.store.loadMore();
  await t.rows({ rows: rows(2, 2), total: { atLeast: 4 } }); // page 1 is newer than the count
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
  t.store.reload();
  await t.failRows();
  t.openCounts()[0].reject(new Error('Count timed out'));
  await new Promise((r) => setTimeout(r, 0));
  // Saved rows, saved count: they agree, so Load more stays away.
  expect(t.ids()).toEqual([0, 1, 2, 3]);
  expect(t.snap().total).toBe(4);
  expect(t.snap().state).toMatchObject({ failure: { scope: 'refresh' } });
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
});

test('pages mode: a count older than staleAfter doesn\'t bound a page opened for the first time', async () => {
  // The server reports a total only on the first page; then it grows. The aged count can't close the pager.
  const t = setup({ mode: 'pages' });
  await t.rows({ rows: rows(0, 2), total: 4 });
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 0, pageCount: 2 });
  t.tick(500);
  t.store.setPage(1);
  expect(t.openCounts()).toHaveLength(0); // the count came from a page: a page settles it, not fetchCount
  await t.rows({ rows: rows(2, 2) });
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 1, pageCount: 3 }); // a full page: there may be more
  t.store.setPage(2);
  await t.rows({ rows: rows(4, 2), total: 6 });
  expect(t.snap().total).toBe(6);
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 2, pageCount: 3 });
});

// ---- Third review: counts that a page already settles, page counts while recounting, deep links -------------------

test('a server that gives exact totals is never asked for a separate count', async () => {
  const t = setup();
  await t.rows({ rows: rows(0, 2), total: 10 });
  t.store.reload();
  expect(t.openCounts()).toHaveLength(0);
  await t.rows({ rows: rows(0, 2), total: 9 });
  expect(t.snap().total).toBe(9);
  t.update({ view: BY_ID });
  await t.rows({ rows: rows(20, 2), total: 9 });
  t.tick(500);
  t.update({ view: NONE }); // stale: the refreshed page brings its own total
  await t.rows({ rows: rows(0, 2), total: 8 });
  expect(t.counts).toHaveLength(0);
  expect(t.snap().total).toBe(8);
});

test('pages mode, exact totals on every page: turning pages after staleAfter asks no count', async () => {
  const t = setup({ mode: 'pages' });
  await t.rows({ rows: rows(0, 2), total: 10 });
  for (let p = 1; p < 5; p++) {
    t.tick(150);
    t.store.setPage(p);
    await t.rows({ rows: rows(p * 2, 2), total: 10 });
  }
  expect(t.counts).toHaveLength(0);
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 4, pageCount: 5 });
});

test('a count answered after a newer exact total from a page doesn\'t overwrite it', async () => {
  const t = setup();
  await t.rows({ rows: rows(0, 2), total: { atLeast: 4 } });
  // The count is in flight; then a reload brings an exact total with its first page.
  t.store.reload();
  await t.rows({ rows: rows(0, 2), total: 7 });
  t.counts.filter((c) => c.open()).forEach((c) => c.resolve(20)); // the older count answers late
  await new Promise((r) => setTimeout(r, 0));
  expect(t.snap().total).toBe(7);
});

test('pages mode: while a recount is pending, the page count keeps the old count as a floor', async () => {
  const t = setup({ mode: 'pages' });
  await t.rows({ rows: rows(0, 2), total: { atLeast: 4 } });
  await t.count(20);
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 0, pageCount: 10 });
  t.tick(150);
  t.store.setPage(5);
  await t.rows({ rows: rows(10, 2), total: { atLeast: 4 } });
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 5, pageCount: 10 }); // not "of 7"
  expect(t.snap().total).toBe(20);
  await t.count(20);
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 5, pageCount: 10 });
});

test('pages mode: a deep link past an aged count waits for the page instead of being clamped by that count', async () => {
  const t = setup({ mode: 'pages' });
  await t.rows({ rows: rows(0, 2), total: { atLeast: 2 } });
  await t.count(6); // three pages, as far as the old count knows
  t.tick(150);
  t.store.setPage(4); // the server has grown to ten rows meanwhile
  expect(t.snap().paging).toMatchObject({ kind: 'pages', page: 4 });
  expect(t.openRows().map((r) => r.req.offset)).toEqual([8]);
  await t.rows({ rows: rows(8, 2) });
  await t.count(10);
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 4, pageCount: 5 });
  expect(t.ids()).toEqual([8, 9]);
});

test('an empty page by offset doesn\'t invent an exact count: it asks for one', async () => {
  const t = setup({ mode: 'pages' });
  await t.rows({ rows: rows(0, 2), total: { atLeast: 2 } });
  await t.count(10);
  t.store.setPage(3);
  await t.rows({ rows: rows(6, 2) });
  t.store.setPage(4); // the server now has five rows
  await t.rows({ rows: [] });
  // 8 would be wrong (it's only an upper bound); a count settles it, and the page steps back to one that exists.
  expect(t.snap().total).not.toBe(8);
  expect(t.openCounts()).toHaveLength(1);
  await t.count(5);
  expect(t.snap().total).toBe(5);
  expect(t.snap().paging).toMatchObject({ kind: 'pages', pageCount: 3 });
});
