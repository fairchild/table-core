// The store against the shapes real servers take. Each test was shown failing before its fix, or pins a line no other
// test held. The fake servers here are shapes real servers take: a number on every page, a number on page 0
// only, a lower bound, no total, a number that stays too high, and cursors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerRowsStore, type ServerRowsConfig, type ServerRowsRequest } from '../src/index.ts';

type Row = { id: number };
const rows = (from: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: from + i }));
type P = { req: ServerRowsRequest; resolve: (v: unknown) => void; reject: (e: unknown) => void; done?: boolean };
const flush = () => new Promise((r) => setTimeout(r, 0));
const NONE = { sort: [] };
const BY_ID = { sort: [{ columnId: 'id', direction: 'descending' as const }] };

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
    update: (changes: Partial<ServerRowsConfig<Row>>) => store.update({ ...base, ...changes }),
    /** Answer the one open request. */
    async answer(value: { rows: Row[]; total?: unknown; nextCursor?: string | null }) {
      const o = open();
      assert.equal(o.length, 1, `${o.length} open requests`);
      o[0].resolve(value);
      await flush();
    },
    async count(n: number) { counts[counts.length - 1].resolve(n); await flush(); },
    /** Serve every open request from a plain offset server with `items` rows and no total. */
    async serve(items: number) {
      for (let g = 0; g < 50; g++) {
        const o = open();
        if (!o.length) return;
        for (const r of o) r.resolve({ rows: rows(r.req.offset, Math.max(0, Math.min(r.req.limit, items - r.req.offset))) });
        await flush();
      }
    },
    page() { const p = store.getSnapshot().paging; return p.kind === 'pages' ? p : assert.fail('not pages'); },
  };
}

// ---- A number that stays too high: Load more must end --------------------------------------------------------------

test('load more ends at an empty page, even when the server\'s total says there are more rows', async () => {
  const t = setup({ fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 9 });
  t.store.loadMore();
  await t.answer({ rows: rows(2, 2), total: 9 });
  t.store.loadMore();
  assert.equal(t.reqs.at(-1)!.req.offset, 4);
  await t.answer({ rows: [], total: 9 });
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: false }, 'the next request would be offset 4 again');
  t.store.loadMore();
  assert.equal(t.reqs.length, 3, 'load more asked again');
  assert.equal(t.snap().total, 9, 'the server\'s number still shows');
  assert.equal(t.snap().rows.length, 4);
});

test('load more ends at an empty page after a short page whose total said more', async () => {
  const t = setup({ fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 5 });
  t.store.loadMore();
  await t.answer({ rows: rows(2, 1), total: 5 });
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true }, 'the number says more than 3');
  t.store.loadMore();
  assert.equal(t.reqs.at(-1)!.req.offset, 3);
  await t.answer({ rows: [], total: 5 });
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: false });
  t.store.loadMore();
  assert.equal(t.reqs.length, 3);
});

test('an empty first page with a total ends the list at once', async () => {
  const t = setup({ fetchCount: undefined });
  await t.answer({ rows: [], total: 5 });
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: false });
  t.store.loadMore();
  assert.equal(t.reqs.length, 1);
});

// ---- An empty page proves nothing about rows below its offset -------------------------------------------------------

test('pages mode: an empty page past the end keeps an exact count it agrees with, and the pager goes straight to the last page', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 6 });
  t.tick(500);                              // the count has aged: it is redone with the next page
  t.store.setPage(4);
  assert.equal(t.reqs.at(-1)!.req.offset, 8);
  await t.answer({ rows: [] });             // no rows at 8: fewer than 9, which the count of 6 already said
  assert.equal(t.snap().total, 6, `total ${JSON.stringify(t.snap().total)} after an empty page`);
  assert.equal(t.reqs.at(-1)!.req.offset, 4, 'the last page by the count, not a walk');
  await t.answer({ rows: rows(4, 2) });
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 2, pageCount: 3 });
});

// ---- A short page whose own lower bound says there are more rows ----------------------------------------------------

test('a short page with a lower bound above its rows is not the end, with the count from a page', async () => {
  const t = setup();
  await t.answer({ rows: rows(0, 2), total: 10 });
  t.store.loadMore();
  await t.answer({ rows: rows(2, 1), total: { atLeast: 10 } });
  assert.equal(t.snap().total, 10);
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
  t.store.loadMore();
  assert.equal(t.reqs.length, 3, 'load more asked for nothing');
  assert.equal(t.reqs[2].req.offset, 3);
});

test('a short page with a lower bound above its rows is not the end, with the count from fetchCount', async () => {
  const t = setup();
  await t.answer({ rows: rows(0, 2), total: { atLeast: 2 } });
  await t.count(10);
  t.store.loadMore();
  await t.answer({ rows: rows(2, 1), total: { atLeast: 10 } });
  assert.equal(t.snap().total, 10);
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
  t.store.loadMore();
  assert.equal(t.reqs[2]?.req.offset, 3);
});

test('a short page with a lower bound at or below its rows settles the count without fetchCount', async () => {
  const t = setup({ pageSize: 5 });
  await t.answer({ rows: rows(0, 3), total: { atLeast: 3 } });
  assert.equal(t.snap().total, 3);
  assert.equal(t.counts.length, 0);
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: false });
});

// ---- A reload asks for the count when the fresh page cannot settle it -----------------------------------------------

test('a reload asks for a new count when the count came from a page and the fresh page has no total at all', async () => {
  const t = setup({ mode: 'pages' });
  await t.answer({ rows: rows(0, 2), total: { atLeast: 2 } });
  await t.count(5);
  t.store.setPage(2);
  await t.answer({ rows: rows(4, 1), total: 5 });   // the last page gives the count itself
  t.store.setPage(0);
  t.store.reload();
  const before = t.counts.length;
  await t.answer({ rows: rows(0, 2) });
  assert.equal(t.counts.length, before + 1, 'no count was asked for');
  await t.count(4);
  assert.equal(t.snap().total, 4);
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 0, pageCount: 2 });
});

// ---- A short page that confirms the count ends the recount ---------------------------------------------------------

test('a short page that confirms the count settles it: the pager does not fall back to an old lower bound', async () => {
  const t = setup({ mode: 'pages', pageSize: 3 });
  await t.answer({ rows: rows(0, 3), total: { atLeast: 4 } });
  await t.count(5);
  t.store.reload();
  await t.answer({ rows: rows(0, 1) });     // the list shrank to 1
  assert.equal(t.snap().total, 1);
  t.counts.at(-1)!.reject(new Error('Count failed')); await flush();
  t.store.reload();
  await t.answer({ rows: rows(0, 1) });     // the same 1 row: the count is confirmed
  assert.equal(t.snap().total, 1);
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 0, pageCount: 1 }, 'a stale lower bound set the pager');
  assert.equal(t.counts.length, 2, 'a count was asked for after the page confirmed it');
});

// ---- A number on page 0 only: the probe page past the count lets it stand --------------------------------------------

test('pages mode, total on page 0 only: after the count ages, an empty page past it lets it stand and the pager shrinks back', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 4 });
  t.tick(500);
  t.store.setPage(1);
  await t.answer({ rows: rows(2, 2) });     // full, no total: the aged count may have grown, so a page past it is offered
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 1, pageCount: 3 });
  t.store.setPage(2);
  await t.answer({ rows: [] });
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 1, pageCount: 2 }, 'the empty page found nothing past the count');
  assert.equal(t.snap().total, 4);
  assert.equal(t.reqs.length, 3);
});

test('pages mode, total on page 0 only: a reload on the last page, then the probe, settles on two pages', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 4 });
  t.store.setPage(1);
  await t.answer({ rows: rows(2, 2) });
  t.store.reload();
  await t.answer({ rows: rows(2, 2) });
  t.store.setPage(2);
  await t.answer({ rows: [] });
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 1, pageCount: 2 });
  t.store.setPage(2);                       // the pager no longer offers it; a stray call stays put
  await flush();
  assert.equal(t.page().page, 1);
});

// ---- The walk back from a deep link belongs to its view and mode ---------------------------------------------------

test('a mode change during the walk back ends it: back in pages mode, the view starts on page 0', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined, pageSize: 10 });
  await t.serve(35);
  t.store.setPage(99);
  await t.answer({ rows: [] });             // the walk has moved on; its request is in flight
  t.update({ mode: 'load-more' });
  await t.serve(35);
  t.update({ mode: 'pages' });
  await t.serve(35);
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 0, pageCount: 2 }, 'the walk resumed');
  assert.equal(t.snap().rows[0]?.id, 0);
});

test('a page chosen during the walk back ends it', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined, pageSize: 10 });
  await t.serve(35);
  t.store.setPage(99);
  await t.answer({ rows: [] });
  t.store.setPage(1);
  await t.serve(35);
  assert.equal(t.page().page, 1, 'the walk went on from page 1');
});

test('the walk back stops at a cached short page: it is the last page', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined, pageSize: 10 });
  await t.serve(35);
  for (const p of [1, 2, 3]) { t.store.setPage(p); await t.serve(35); }
  const before = t.reqs.length;
  t.store.setPage(99);
  await t.serve(35);
  assert.equal(t.page().page, 3);
  assert.equal(t.reqs.length - before, 1, 'page 3 is cached and short: nothing between was asked for');
});

test('an exact count ends the walk back for good: a later recount does not resume it', async () => {
  const t = setup({ mode: 'pages' });
  await t.answer({ rows: rows(0, 2), total: { atLeast: 2 } });
  t.store.setPage(9);
  await t.answer({ rows: [] });             // the walk moves to page 4
  await t.count(6);                         // the count clamps to the last page, 2
  await t.answer({ rows: rows(4, 2) });
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 2, pageCount: 3 });
  t.store.reload();                         // the count is redone: until it answers, nothing bounds this page
  await t.answer({ rows: rows(4, 2) });
  assert.equal(t.page().page, 2, 'the old walk moved the page');
});

// ---- A rebuild that is given up takes its count with it --------------------------------------------------------------

test('a rebuild interrupted by a second reload: when that fails, the old rows keep their own count', async () => {
  const t = setup({ fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 10 });
  t.store.loadMore();
  await t.answer({ rows: rows(2, 2), total: 10 });
  t.store.reload();
  await t.answer({ rows: rows(100, 2), total: 8 });
  t.store.reload();
  t.reqs.at(-1)!.reject(new Error('Timed out')); await flush();
  assert.deepEqual(t.snap().rows, rows(0, 4));
  assert.equal(t.snap().state.failure?.scope, 'refresh');
  assert.equal(t.snap().total, 10, `old rows with total ${JSON.stringify(t.snap().total)}`);
});

test('a rebuild interrupted by a view change: when the next one fails, the old rows keep their own count', async () => {
  const t = setup({ fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 10 });
  t.store.loadMore();
  await t.answer({ rows: rows(2, 2), total: 10 });
  t.store.reload();
  await t.answer({ rows: rows(100, 2), total: 8 });
  t.update({ view: BY_ID });
  await t.answer({ rows: rows(50, 2), total: 8 });
  t.update({ view: NONE });                 // back: one page is wanted again, and it is stale
  t.reqs.at(-1)!.reject(new Error('Timed out')); await flush();
  assert.deepEqual(t.snap().rows, rows(0, 2));
  assert.equal(t.snap().state.failure?.scope, 'refresh');
  assert.equal(t.snap().total, 10, `old rows with total ${JSON.stringify(t.snap().total)}`);
});

// ---- Pins: lines no other test held ---------------------------------------------------------------------------------

test('cursor pages of varying size with a total on page 0 only end with that total', async () => {
  const t = setup({ pageSize: 5, fetchCount: undefined });
  await t.answer({ rows: rows(0, 3), nextCursor: 'a', total: 8 });
  t.store.loadMore();
  await t.answer({ rows: rows(3, 3), nextCursor: 'b' });
  t.store.loadMore();
  await t.answer({ rows: rows(6, 2), nextCursor: null });
  assert.equal(t.snap().rows.length, 8);
  assert.equal(t.snap().total, 8, `total ${JSON.stringify(t.snap().total)}`);
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: false });
});

test('load more compares the rows it holds with the count, not pages × limit', async () => {
  const t = setup({ pageSize: 5, fetchCount: undefined });
  await t.answer({ rows: rows(0, 3), total: 9 });
  t.store.loadMore();
  await t.answer({ rows: rows(3, 5), total: 9 });   // 8 of 9 rows, in two pages
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
  t.store.loadMore();
  assert.equal(t.reqs.at(-1)!.req.offset, 8);
});

test('a stale load-more chain coming back on screen asks for its count again', async () => {
  const t = setup();
  await t.answer({ rows: rows(0, 2), total: { atLeast: 2 } });
  await t.count(5);
  t.update({ view: BY_ID });
  await t.answer({ rows: rows(9, 2), total: 5 });
  t.tick(500);
  t.update({ view: NONE });
  assert.equal(t.reqs.at(-1)!.req.offset, 0, 'the stale chain is rebuilt');
  assert.equal(t.counts.length, 2, 'the count, as old as the rows, is asked for again');
});

test('a stale page coming back on screen in pages mode asks for its count again', async () => {
  const t = setup({ mode: 'pages' });
  await t.answer({ rows: rows(0, 2), total: { atLeast: 2 } });
  await t.count(5);
  t.store.setPage(1);
  await t.answer({ rows: rows(2, 2), total: { atLeast: 4 } });
  t.tick(500);
  t.store.setPage(0);
  assert.equal(t.reqs.at(-1)!.req.offset, 0, 'the stale page is fetched again');
  assert.equal(t.counts.length, 2, 'the count, as old as the rows, is asked for again');
});

// ---- From the pre-review of this change -----------------------------------------------------------------------------

/** A plain offset server with `items` rows that gives its total on page 0 only. */
const serveFirst = async (t: ReturnType<typeof setup>, items: number) => {
  for (let g = 0; g < 50; g++) {
    const o = t.open();
    if (!o.length) return;
    for (const r of o) {
      const page = rows(r.req.offset, Math.max(0, Math.min(r.req.limit, items - r.req.offset)));
      r.resolve(r.req.offset === 0 ? { rows: page, total: items } : { rows: page });
    }
    await flush();
  }
};

test('pages mode: a stale page being fetched again is not clamped by a count that bounds only its old copy', async () => {
  const t = setup({ mode: 'pages', pageSize: 3, fetchCount: undefined });
  await serveFirst(t, 10);                  // total 10 from page 0
  t.store.setPage(3); await serveFirst(t, 10);   // the last page, 1 row, now cached
  t.store.setPage(2); await serveFirst(t, 10);
  t.tick(500);
  t.store.setPage(0); await serveFirst(t, 9);    // the list shrank: page 0 says 9
  t.store.setPage(2); await serveFirst(t, 9);    // stale: fetched again, and the count is redone
  t.store.reload(); await serveFirst(t, 9);
  assert.equal(t.snap().total, 9);
  t.store.setPage(3);                       // meanwhile the list grew to 22 rows
  const req = t.reqs.at(-1)!;
  assert.equal(req.req.offset, 9);
  assert.equal(req.req.signal.aborted, false, 'the refetch of page 3 was aborted by a clamp on its stale copy');
  await serveFirst(t, 22);
  assert.equal(t.page().page, 3, 'Next bounced back');
  assert.deepEqual(t.snap().rows, rows(9, 3));
});

test('the walk back stops at a cached short page when no count bounds it', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined, pageSize: 10 });
  await t.serve(35);
  for (const p of [1, 2, 3]) { t.store.setPage(p); await t.serve(35); }
  t.store.setPage(0);
  t.store.reload();
  await t.answer({ rows: rows(0, 10), total: { atLeast: 40 } });   // a bound above the count drops it
  assert.deepEqual(t.snap().total, { atLeast: 40 });
  const before = t.reqs.length;
  t.store.setPage(99);
  await t.serve(35);
  assert.equal(t.page().page, 3);
  assert.deepEqual(t.snap().rows, rows(30, 5));
  assert.equal(t.reqs.length - before, 2, 'page 3 is cached and short: nothing between was asked for');
});

test('a count still owed after a failed one is asked for on the next visit, even when rows dropped the count meanwhile', async () => {
  const t = setup();
  await t.answer({ rows: rows(0, 2), total: 4 });
  t.store.loadMore();
  await t.answer({ rows: rows(2, 2) });
  t.store.reload();                         // the count is redone with the rows
  await t.answer({ rows: rows(0, 2) });     // a full page with no total can't settle it: a count is asked for
  assert.equal(t.counts.length, 1);
  await t.answer({ rows: rows(2, 2) });
  t.store.loadMore();
  await t.answer({ rows: rows(4, 2) });     // rows past the count drop it
  assert.equal(t.snap().total, undefined);
  t.counts[0].reject(new Error('Count failed')); await flush();
  t.store.reload();
  assert.equal(t.counts.length, 2, 'the count still owed was not asked for');
  await t.count(7);
  assert.equal(t.snap().total, 7);
});

test('with no count to go by, a short page with a lower bound above its rows is not the end, and the next page is asked from its rows', async () => {
  const t = setup({ pageSize: 5, fetchCount: undefined });
  await t.answer({ rows: rows(0, 3), total: { atLeast: 30 } });
  assert.deepEqual(t.snap().total, { atLeast: 30 });
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
  t.store.loadMore();
  assert.equal(t.reqs.at(-1)!.req.offset, 3);
  await t.answer({ rows: rows(3, 5) });
  assert.deepEqual(t.snap().paging, { kind: 'load-more', hasMore: true });
});

test('pages mode: a short page with rows settles the count, whatever the pages before it', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined });
  await t.answer({ rows: rows(0, 2) });
  t.store.setPage(2);
  await t.answer({ rows: rows(4, 1) });
  assert.equal(t.snap().total, 5);
  assert.deepEqual(t.snap().paging, { kind: 'pages', page: 2, pageCount: 3 });
});

test('pages mode: an empty page below the count finds the end by halving, not one page at a time', async () => {
  const t = setup({ mode: 'pages', fetchCount: undefined });
  await t.answer({ rows: rows(0, 2), total: 20 });
  t.store.setPage(9);
  const before = t.reqs.length;
  await t.serve(2);                         // the list shrank to 2 rows
  assert.equal(t.page().page, 0);
  assert.ok(t.reqs.length - before <= 5, `${t.reqs.length - before} requests from page 9 back to page 0`);
});

test('pages mode: a cached empty page within the count steps back a page, not to the same page', async () => {
  const t = setup({ mode: 'pages' });
  await t.answer({ rows: rows(0, 2), total: { atLeast: 2 } });
  t.store.setPage(4);
  await t.answer({ rows: [] });             // no rows at 8; the walk moves on
  await t.count(10);                        // a count that still says 5 pages
  await t.serve(8);
  assert.equal(t.page().page, 2);
  t.store.setPage(4);                       // the cached empty page
  await flush();
  assert.equal(t.page().page, 3, 'stayed on the empty page');
});
