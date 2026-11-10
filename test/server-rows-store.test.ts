// The server row model on its own: no browser, no timers. Each request is a deferred promise the test resolves or
// rejects, so the order of events is exact rather than a matter of latency.
import { test } from 'node:test';
import { expect } from './expect.ts';
import { ServerRowsStore, pageKey, type ServerRowsConfig, type ServerRowsRequest, type TableView } from '../src/index.ts';

type Row = { id: number };
const rows = (from: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: from + i }));
const NONE: TableView = { sort: [] };
const BY_ID: TableView = { sort: [{ columnId: 'id', direction: 'descending' }] };

type Pending<T> = { req: T; resolve: (v: unknown) => void; reject: (e: unknown) => void; aborted: () => boolean; open: () => boolean };

/** A fake server whose requests stay pending until the test settles them. */
function fakeServer() {
  const requests: Array<Pending<ServerRowsRequest>> = [];
  const counts: Array<Pending<{ view: TableView }>> = [];
  const defer = <T,>(list: Array<Pending<T>>, req: T, signal: AbortSignal) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: (v: unknown) => void) => (v: unknown) => { settled = true; fn(v); };
      list.push({ req, resolve: settle(resolve), reject: settle(reject), aborted: () => signal.aborted, open: () => !settled && !signal.aborted });
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  return {
    requests,
    counts,
    fetchRows: (r: ServerRowsRequest) => defer(requests, r, r.signal) as never,
    fetchCount: (r: { view: TableView; signal: AbortSignal }) => defer(counts, r, r.signal) as never,
    /** Requests still pending and not aborted. */
    open: () => requests.filter((p) => p.open()),
    last: () => requests[requests.length - 1],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(config: Partial<ServerRowsConfig<Row>> = {}) {
  const server = fakeServer();
  let clock = 1_000;
  const base: ServerRowsConfig<Row> = {
    view: NONE, fetchRows: server.fetchRows, fetchCount: server.fetchCount, pageSize: 2, now: () => clock, ...config,
  };
  const store = new ServerRowsStore<Row>(base);
  let notified = 0;
  store.subscribe(() => { notified++; });
  store.start();
  return {
    store, server,
    /** What the hook does on a render: the full options, with these changes. */
    update: (changes: Partial<ServerRowsConfig<Row>>) => store.update({ ...base, ...changes }),
    snap: () => store.getSnapshot(),
    tick: (ms: number) => { clock += ms; },
    notified: () => notified,
    /** Settle request i and let the store react. */
    async answer(i: number, value: { rows: Row[]; total?: unknown; nextCursor?: string | null }) {
      server.requests[i].resolve(value);
      await flush();
    },
    async fail(i: number, message = 'Timed out') {
      server.requests[i].reject(new Error(message));
      await flush();
    },
  };
}

test('pageKey: the view and the page size are both part of a page’s identity', () => {
  expect(pageKey(NONE, 50)).not.toBe(pageKey(NONE, 25));
  expect(pageKey(NONE, 50)).not.toBe(pageKey(BY_ID, 50));
  expect(pageKey({ sort: [] }, 50)).toBe(pageKey(NONE, 50));
});

test('first load: nothing on screen and fetching, then current rows', async () => {
  const t = setup();
  expect(t.snap().state).toEqual({ rows: 'none', fetching: true });
  expect(t.server.requests).toHaveLength(1);
  expect(t.server.requests[0].req).toMatchObject({ offset: 0, limit: 2, cursor: undefined });
  await t.answer(0, { rows: rows(0, 2), total: 5 });
  expect(t.snap().rows.map((r) => r.id)).toEqual([0, 1]);
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: false });
  expect(t.snap().total).toBe(5);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
});

test('load more chains cursors: page p is asked for only after page p − 1 arrives, with its cursor', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
  t.store.loadMore();
  t.store.loadMore(); // a second click before the first lands is ignored: Load more is hidden while loading
  expect(t.server.open()).toHaveLength(1);
  expect(t.server.last().req.cursor).toBe('c1');
  // Current rows stay usable while more load.
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: true });
  await t.answer(1, { rows: rows(2, 2), nextCursor: 'c2' });
  t.store.loadMore();
  expect(t.server.last().req).toMatchObject({ cursor: 'c2', offset: 4 });
  await t.answer(2, { rows: rows(4, 1), nextCursor: null });
  expect(t.snap().rows.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
});

test('reload rebuilds the loaded pages in order, never in parallel', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
  t.store.loadMore();
  await t.answer(1, { rows: rows(2, 2), nextCursor: 'c2' });
  t.store.reload();
  expect(t.server.open()).toHaveLength(1);
  expect(t.server.last().req.cursor).toBeUndefined();
  // The rows on screen stay, as this view's, while their pages come back in order.
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: true });
  await t.answer(2, { rows: rows(0, 2), nextCursor: 'n1' });
  expect(t.server.last().req.cursor).toBe('n1');
  await t.answer(3, { rows: rows(2, 2), nextCursor: 'n2' });
  expect(t.snap().rows.map((r) => r.id)).toEqual([0, 1, 2, 3]);
});

test('a page-size change starts again with the new page boundaries', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2) });
  t.store.loadMore();
  await t.answer(1, { rows: rows(2, 2) });
  t.update({ view: NONE, pageSize: 3 });
  expect(t.server.last().req).toMatchObject({ offset: 0, limit: 3 });
  await t.answer(2, { rows: rows(0, 3) });
  t.store.loadMore();
  expect(t.server.last().req).toMatchObject({ offset: 3, limit: 3 });
});

test('out-of-date requests are aborted; duplicates are merged; a view seen before comes from the cache', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2) });
  t.update({ view: BY_ID });
  t.update({ view: BY_ID }); // same key again: no second request
  expect(t.server.requests).toHaveLength(2);
  t.update({ view: NONE }); // back before it lands
  expect(t.server.requests[1].aborted()).toBe(true);
  expect(t.server.requests).toHaveLength(2); // the first view is cached and fresh
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: false });
  // Stopping (unmount) aborts what is in flight.
  t.update({ view: BY_ID });
  t.store.stop();
  expect(t.server.last().aborted()).toBe(true);
});

test('{atLeast} is followed by one exact count, asked for again if a view change cancelled it', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2), total: { atLeast: 100 } });
  expect(t.snap().total).toEqual({ atLeast: 100 });
  expect(t.server.counts).toHaveLength(1);
  t.update({ view: BY_ID });
  expect(t.server.counts[0].aborted()).toBe(true);
  t.update({ view: NONE });
  expect(t.server.counts).toHaveLength(2);
  t.server.counts[1].resolve(310);
  await flush();
  expect(t.snap().total).toBe(310);
});

test('failure scopes: load hides nothing it shouldn’t, more keeps rows, refresh keeps rows with their age', async () => {
  const t = setup({ staleAfter: 100 });
  // 'load': the first page of a new view failed. The previous view's rows are 'previous', never 'current'.
  await t.answer(0, { rows: rows(0, 2) });
  t.update({ view: BY_ID });
  await t.fail(1);
  expect(t.snap().state).toMatchObject({ rows: 'previous', fetching: false, failure: { scope: 'load', message: 'Timed out' } });
  expect(t.server.requests).toHaveLength(2); // a failure is never retried by itself
  t.snap().state.failure!.retry();
  await t.answer(2, { rows: rows(10, 2) });
  expect(t.snap().state.failure).toBeUndefined();
  expect(t.snap().state.rows).toBe('current');

  // 'more': the next page failed. Current rows stay, and Load more retries the same page.
  t.store.loadMore();
  await t.fail(3);
  expect(t.snap().state).toMatchObject({ rows: 'current', failure: { scope: 'more' } });
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
  t.store.loadMore();
  expect(t.server.last().req.offset).toBe(2);
  await t.answer(4, { rows: rows(12, 1) });
  expect(t.snap().rows).toHaveLength(3);

  // 'refresh': a cached page came back on screen stale, and refreshing it failed. Its rows stay, with their age.
  t.update({ view: NONE });
  t.tick(500);
  t.update({ view: BY_ID });
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: true });
  await t.fail(t.server.requests.length - 1);
  const s = t.snap().state;
  expect(s).toMatchObject({ rows: 'current', failure: { scope: 'refresh' } });
  expect(s.since).toBeInstanceOf(Date);
});

test('staleAfter: a cached page is refetched when it comes back on screen, not while it stays there', async () => {
  const t = setup({ staleAfter: 100 });
  await t.answer(0, { rows: rows(0, 2) });
  t.tick(500);
  t.store.loadMore(); // page 0 is on screen already: only page 1 is asked for
  expect(t.server.requests).toHaveLength(2);
  expect(t.server.last().req.offset).toBe(2);
  await t.answer(1, { rows: rows(2, 2) });
  t.update({ view: BY_ID });
  await t.answer(2, { rows: rows(9, 2) });
  t.update({ view: NONE }); // back: page 0 is stale, so it is refetched
  expect(t.server.last().req).toMatchObject({ view: NONE, offset: 0 });
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: true });
});

test('pages mode: steps back when the page past the end comes back empty', async () => {
  const t = setup({ mode: 'pages' });
  await t.answer(0, { rows: rows(0, 2), total: 4 });
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 0, pageCount: 2 });
  t.store.setPage(1);
  await t.answer(1, { rows: rows(2, 2), total: 4 });
  t.store.reload();
  await t.answer(2, { rows: [], total: 2 });
  expect(t.snap().paging).toMatchObject({ kind: 'pages', page: 0, pageCount: 1 });
  await t.answer(3, { rows: rows(0, 2), total: 2 });
  expect(t.snap().rows).toHaveLength(2);
});

test('subscribers hear only real changes', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2) });
  const before = t.notified();
  const snap = t.snap();
  t.update({ view: NONE, fetchRows: (r) => t.server.fetchRows(r) }); // same key, new fetcher
  expect(t.notified()).toBe(before);
  expect(t.snap()).toBe(snap);
});

// ---- Regressions from review ---------------------------------------------------------------------------------------

test('a failure belongs to its visit: coming back to a view that failed asks the server again', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2) });
  t.update({ view: BY_ID });
  await t.fail(1);
  t.update({ view: NONE });
  t.update({ view: BY_ID });
  expect(t.server.requests).toHaveLength(3);
  expect(t.snap().state.failure).toBeUndefined();
  expect(t.snap().state.fetching).toBe(true);
});

test('pages mode: going back to a page that failed asks again', async () => {
  const t = setup({ mode: 'pages' });
  await t.answer(0, { rows: rows(0, 2), total: 6 });
  t.store.setPage(1);
  await t.fail(1);
  expect(t.snap().state.failure?.scope).toBe('load');
  t.store.setPage(0);
  t.store.setPage(1);
  expect(t.server.requests).toHaveLength(3);
  expect(t.snap().state.failure).toBeUndefined();
});

test('reload that fails keeps this view’s rows, as saved data', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2) });
  t.store.reload();
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: true });
  await t.fail(1);
  expect(t.snap().state).toMatchObject({ rows: 'current', failure: { scope: 'refresh' } });
  expect(t.snap().rows).toHaveLength(2);
  t.snap().state.failure!.retry();
  await t.answer(2, { rows: rows(5, 2) });
  expect(t.snap().rows.map((r) => r.id)).toEqual([5, 6]);
  expect(t.snap().state.failure).toBeUndefined();
});

test('undefined options fall back to the defaults', async () => {
  const t = setup({ pageSize: undefined, staleAfter: undefined });
  expect(t.server.requests[0].req).toMatchObject({ offset: 0, limit: 50 });
  await t.answer(0, { rows: rows(0, 50) });
  t.update({ view: BY_ID, pageSize: undefined });
  await t.answer(1, { rows: rows(0, 50) });
  t.update({ view: NONE, staleAfter: undefined });
  expect(t.server.requests).toHaveLength(2); // cached and fresh under the default staleAfter
});

test('pages mode: an exact count that arrives later clamps the page', async () => {
  const t = setup({ mode: 'pages' });
  await t.answer(0, { rows: rows(0, 2), total: { atLeast: 20 } });
  t.store.setPage(8);
  await t.answer(1, { rows: rows(16, 2), total: { atLeast: 20 } });
  t.server.counts[0].resolve(6);
  await flush();
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 2, pageCount: 3 });
  expect(t.server.last().req.offset).toBe(4); // the rows shown are page 3’s, not page 9’s
});

test('load more after the last page does nothing', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 1), nextCursor: null });
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
  t.store.loadMore();
  expect(t.server.requests).toHaveLength(1);
  expect(t.snap().state.fetching).toBe(false);
});

test('a fetcher that throws synchronously is a failure, not an exception', async () => {
  const t = setup({ fetchRows: () => { throw new Error('bad URL'); } });
  await flush();
  expect(t.snap().state).toMatchObject({ rows: 'none', fetching: false, failure: { scope: 'load', message: 'bad URL' } });
});

test('StrictMode start, stop, start leaves one live request; a fetcher that ignores the signal cannot land late', async () => {
  const t = setup();
  t.store.stop();
  t.store.start(); // StrictMode: start, stop, start
  expect(t.server.open()).toHaveLength(1);
  t.update({ view: BY_ID });
  t.update({ view: NONE }); // back while NONE's request is still open
  expect(t.server.open()).toHaveLength(1);
  const late = t.server.requests[1];
  expect(late.aborted()).toBe(true);
  // Resolving an aborted request (a fetcher that ignores its signal) changes nothing.
  t.server.requests[1].resolve({ rows: rows(90, 2) });
  await flush();
  const open = t.server.requests.findIndex((p) => p.open());
  await t.answer(open, { rows: rows(0, 2) });
  expect(t.snap().rows.map((r) => r.id)).toEqual([0, 1]);
});

test('a failed count leaves {atLeast} and isn’t retried on every update', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2), total: { atLeast: 100 } });
  t.server.counts[0].reject(new Error('nope'));
  await flush();
  t.store.loadMore();
  await t.answer(1, { rows: rows(2, 2), total: { atLeast: 100 } });
  expect(t.snap().total).toEqual({ atLeast: 100 });
  expect(t.server.counts).toHaveLength(1);
});

test('load more still works after refreshing the first page failed', async () => {
  const t = setup({ staleAfter: 100 });
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
  t.update({ view: BY_ID });
  await t.answer(1, { rows: rows(9, 2), nextCursor: 'x1' });
  t.tick(500);
  t.update({ view: NONE }); // stale: refetched, and that fails
  await t.fail(2);
  expect(t.snap().state.failure?.scope).toBe('refresh');
  t.store.loadMore();
  expect(t.server.last().req).toMatchObject({ view: NONE, offset: 2, cursor: 'c1' });
});

// ---- Revalidating a load-more chain: built aside, swapped in whole -------------------------------------------------

test('reload that comes back shorter drops the rows past the new end', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
  t.store.loadMore();
  await t.answer(1, { rows: rows(2, 2), nextCursor: 'c2' });
  t.store.loadMore();
  await t.answer(2, { rows: rows(4, 2), nextCursor: null });
  t.store.reload();
  await t.answer(3, { rows: [{ id: 0 }, { id: 2 }], nextCursor: null }); // rows were deleted on the server
  expect(t.snap().rows.map((r) => r.id)).toEqual([0, 2]);
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: false });
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: false });
  expect(t.server.open()).toHaveLength(0);
});

test('revalidation never mixes old and new pages: the old chain stays until the new one is complete', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
  t.store.loadMore();
  await t.answer(1, { rows: rows(2, 2), nextCursor: 'c2' });
  t.store.reload();
  await t.answer(2, { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'n1' }); // row 0 deleted: everything shifts
  // Until page 1 is back, the old chain is shown whole: no [1,2,2,3].
  expect(t.snap().rows.map((r) => r.id)).toEqual([0, 1, 2, 3]);
  expect(t.server.last().req.cursor).toBe('n1');
  await t.answer(3, { rows: [{ id: 3 }, { id: 4 }], nextCursor: 'n2' });
  expect(t.snap().rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
});

test('a later page built on an old cursor is refetched when the page before it is', async () => {
  const t = setup({ staleAfter: 100 });
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
  t.store.loadMore();
  await t.answer(1, { rows: rows(2, 2), nextCursor: 'c2' });
  t.tick(80);
  t.store.loadMore();
  await t.answer(2, { rows: rows(4, 2), nextCursor: 'c3' });
  t.tick(30); // pages 0 and 1 are stale, page 2 is not
  t.store.stop();
  t.store.start();
  await t.answer(3, { rows: rows(0, 2), nextCursor: 'c1' });
  await t.answer(4, { rows: [{ id: 2 }, { id: 4 }], nextCursor: 'd2' }); // a different cursor
  expect(t.server.last().req.cursor).toBe('d2'); // page 2 again, from the new cursor
  await t.answer(5, { rows: [{ id: 5 }, { id: 6 }], nextCursor: 'd3' });
  expect(t.snap().rows.map((r) => r.id)).toEqual([0, 1, 2, 4, 5, 6]);
});

test('a failed revalidation keeps the old chain whole; retry rebuilds it', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
  t.store.loadMore();
  await t.answer(1, { rows: rows(2, 2), nextCursor: 'c2' });
  t.store.reload();
  await t.answer(2, { rows: rows(10, 2), nextCursor: 'n1' });
  await t.fail(3);
  expect(t.snap().rows.map((r) => r.id)).toEqual([0, 1, 2, 3]);
  expect(t.snap().state).toMatchObject({ rows: 'current', failure: { scope: 'refresh' } });
  t.snap().state.failure!.retry();
  expect(t.server.last().req).toMatchObject({ offset: 0, cursor: undefined });
  expect(t.snap().rows.map((r) => r.id)).toEqual([0, 1, 2, 3]); // still the old chain, whole
  await t.answer(4, { rows: rows(10, 2), nextCursor: 'n1' });
  expect(t.server.last().req.cursor).toBe('n1');
  await t.answer(5, { rows: rows(12, 2), nextCursor: null });
  expect(t.snap().rows.map((r) => r.id)).toEqual([10, 11, 12, 13]);
  expect(t.snap().state.failure).toBeUndefined();
});

test('pages mode sends no cursor', async () => {
  const t = setup({ mode: 'pages' });
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1', total: 6 });
  t.store.setPage(1);
  expect(t.server.last().req).toMatchObject({ offset: 2, cursor: undefined });
});

// ---- Third review --------------------------------------------------------------------------------------------------

test('switching mode while the first page loads starts again, in the new mode', async () => {
  const t = setup();
  t.update({ mode: 'pages' });
  expect(t.server.requests[0].aborted()).toBe(true);
  expect(t.server.open()).toHaveLength(1);
  await t.answer(1, { rows: rows(0, 2), total: 4 });
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: false });
  expect(t.snap().paging).toEqual({ kind: 'pages', page: 0, pageCount: 2 });
});

test('a next page that fails after a failed reload is reported as the next page, and Load more retries it', async () => {
  const t = setup();
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
  t.store.loadMore();
  await t.answer(1, { rows: rows(2, 2), nextCursor: 'c2' });
  t.store.reload();
  await t.fail(2, 'Reload failed');
  expect(t.snap().state).toMatchObject({ rows: 'current', failure: { scope: 'refresh' } });
  t.store.loadMore();
  expect(t.server.last().req).toMatchObject({ offset: 4, cursor: 'c2' });
  await t.fail(3, 'More failed');
  expect(t.snap().state.failure).toMatchObject({ scope: 'more', message: 'More failed' });
  expect(t.snap().paging).toEqual({ kind: 'load-more', hasMore: true });
  t.store.loadMore();
  expect(t.server.last().req).toMatchObject({ offset: 4, cursor: 'c2' });
});

test('a stale cached page revealed by Load more is fetched again, not shown', async () => {
  const t = setup({ staleAfter: 100 });
  await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
  t.store.loadMore();
  await t.answer(1, { rows: rows(2, 2), nextCursor: 'c2' });
  t.update({ view: BY_ID });
  await t.answer(2, { rows: rows(9, 2) });
  t.tick(60);
  t.update({ view: NONE }); // page 0 still fresh: no request
  expect(t.server.requests).toHaveLength(3);
  t.tick(60); // page 1 is now stale
  t.store.loadMore();
  expect(t.server.last().req).toMatchObject({ view: NONE, offset: 2, cursor: 'c1' });
  expect(t.snap().rows).toHaveLength(2);
});

const sortedBy = (columnId: string): TableView => ({ sort: [{ columnId, direction: 'ascending' }] });

test('maxViews: past it, the view shown longest ago is fetched again, and the others come from the cache', async () => {
  const t = setup({ maxViews: 2 });
  await t.answer(0, { rows: rows(0, 2) });
  t.update({ view: sortedBy('a') });
  await t.answer(1, { rows: rows(10, 2) });
  t.update({ view: sortedBy('b') });
  await t.answer(2, { rows: rows(20, 2) });
  // Two views are kept: `a` is one of them.
  t.update({ view: sortedBy('a') });
  expect(t.server.requests).toHaveLength(3);
  expect(t.snap().rows.map((r) => r.id)).toEqual([10, 11]);
  expect(t.snap().state).toMatchObject({ rows: 'current', fetching: false });
  // The first view left when `b` came in.
  t.update({ view: NONE });
  expect(t.server.requests).toHaveLength(4);
  expect(t.snap().state).toMatchObject({ rows: 'previous', fetching: true });
  // Showing `a` again made `b` the one shown longest ago, so `b` left for the first view and `a` stayed.
  await t.answer(3, { rows: rows(0, 2) });
  t.update({ view: sortedBy('a') });
  expect(t.server.requests).toHaveLength(4);
  t.update({ view: sortedBy('b') });
  expect(t.server.requests).toHaveLength(5);
});

test('maxViews: the view on screen keeps its pages and its requests, even at 1, 0 or NaN', async () => {
  for (const maxViews of [1, 0, NaN]) {
    const t = setup({ maxViews });
    await t.answer(0, { rows: rows(0, 2), nextCursor: 'c1' });
    t.update({ view: BY_ID, maxViews });
    expect(t.server.last().aborted()).toBe(false);
    await t.answer(1, { rows: rows(10, 2), nextCursor: 'd1' });
    t.store.loadMore();
    expect(t.server.last().req).toMatchObject({ cursor: 'd1', offset: 2 });
    await t.answer(2, { rows: rows(12, 2), nextCursor: null });
    expect(t.snap().rows.map((r) => r.id)).toEqual([10, 11, 12, 13]);
    expect(t.snap().state).toMatchObject({ rows: 'current', fetching: false });
    // Only that one: the first view is fetched again.
    t.update({ view: NONE, maxViews });
    expect(t.server.requests).toHaveLength(4);
  }
});

test('maxViews: 20 views by default, and Infinity keeps them all', async () => {
  for (const [maxViews, kept] of [[undefined, false], [Infinity, true]] as const) {
    const t = setup({ maxViews });
    await t.answer(0, { rows: rows(0, 2) });
    for (let i = 1; i <= 20; i++) {
      t.update({ view: sortedBy(`c${i}`) });
      await t.answer(i, { rows: rows(i * 10, 2) });
    }
    t.update({ view: sortedBy('c1') });
    expect(t.server.requests).toHaveLength(21);
    t.update({ view: NONE });
    expect(t.server.requests).toHaveLength(kept ? 21 : 22);
  }
});
