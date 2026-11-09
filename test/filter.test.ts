// A view's filter. It is part of the view, so it is part of a page's identity: a different filter is
// a different page, and changing it starts again at the first page. The key is the view's JSON, so the same filter
// written another way (another key order, `{}` for none) is a new entry too: a missed match costs a refetch, never
// another filter's rows.
import { test } from 'node:test';
import { expect } from './expect.ts';
import { ServerRowsStore, pageKey, type ServerRowsRequest } from '../src/index.ts';
import type { TableView } from '../src/index.ts';

type Row = { id: number };
const flush = () => new Promise((r) => setTimeout(r, 0));

test('pageKey: a filter is part of the identity', () => {
  const sort = [{ columnId: 'id', direction: 'ascending' as const }];
  expect(pageKey({ sort, filter: { q: 'a' } }, 2)).not.toBe(pageKey({ sort, filter: { q: 'b' } }, 2));
  expect(pageKey({ sort, filter: { q: 'a' } }, 2)).not.toBe(pageKey({ sort }, 2));
  expect(pageKey({ sort, filter: { s: ['a', 'b'] } }, 2)).not.toBe(pageKey({ sort, filter: { s: ['b', 'a'] } }, 2));
});

test('a new filter asks for its first page with the filter, and the previous filter’s pages come back from the cache', async () => {
  const requests: ServerRowsRequest[] = [];
  const answers: Array<(v: unknown) => void> = [];
  const fetchRows = (r: ServerRowsRequest) => { requests.push(r); return new Promise((res) => answers.push(res)) as never; };
  const base = { view: { sort: [] } as TableView, fetchRows, pageSize: 2, mode: 'pages' as const, now: () => 1000 };
  const store = new ServerRowsStore<Row>(base);
  store.start();
  answers[0]({ rows: [{ id: 1 }, { id: 2 }], total: 6 });
  await flush();
  store.setPage(2);
  answers[1]({ rows: [{ id: 5 }, { id: 6 }], total: 6 });
  await flush();

  store.update({ ...base, view: { sort: [], filter: { q: 'x' } } });
  expect(requests[2].offset).toBe(0);
  expect(requests[2].view.filter).toEqual({ q: 'x' });
  const p = store.getSnapshot().paging;
  expect(p.kind === 'pages' && p.page).toBe(0);
  answers[2]({ rows: [{ id: 9 }], total: 1 });
  await flush();
  expect(store.getSnapshot().rows).toEqual([{ id: 9 }]);
  expect(store.getSnapshot().total).toBe(1);

  // The same filter again: nothing new is asked.
  store.update({ ...base, view: { sort: [], filter: { q: 'x' } } });
  expect(requests).toHaveLength(3);

  // Back to no filter: its first page is shown at once from the cache.
  store.update({ ...base, view: { sort: [] } });
  expect(store.getSnapshot().rows).toEqual([{ id: 1 }, { id: 2 }]);
  store.stop();
});

// A filter must never share the unfiltered view's cache entry (a false match shows
// another filter's rows). These guard against a key that normalises filters.
const PROTO = JSON.parse('{"__proto__":"restricted"}') as Record<string, string>;
const COLLIDERS: Array<[string, TableView]> = [
  ['an application key holding an empty array', { sort: [], filter: { filter: [] } }],
  ['an own __proto__ key', { sort: [], filter: PROTO }],
];

for (const [name, view] of COLLIDERS) {
  test(`pageKey: a filter with ${name} is not the unfiltered view`, () => {
    expect(pageKey(view, 2)).not.toBe(pageKey({ sort: [] }, 2));
    expect(pageKey(view, 2)).not.toBe(pageKey({ sort: [], filter: {} }, 2));
  });

  test(`store: moving to a filter with ${name} asks for its rows instead of keeping the unfiltered ones`, async () => {
    const requests: ServerRowsRequest[] = [];
    const answers: Array<(v: unknown) => void> = [];
    const fetchRows = (r: ServerRowsRequest) => { requests.push(r); return new Promise((res) => answers.push(res)) as never; };
    const base = { view: { sort: [] } as TableView, fetchRows, pageSize: 2, now: () => 1000 };
    const store = new ServerRowsStore<{ id: string }>(base);
    store.start();
    answers[0]({ rows: [{ id: 'unfiltered' }], total: 1 });
    await flush();
    store.update({ ...base, view });
    expect(requests).toHaveLength(2);
    expect(requests[1].view.filter).toBe(view.filter);
    expect(store.getSnapshot().state.rows).not.toBe('current');
    answers[1]({ rows: [{ id: 'filtered' }], total: 1 });
    await flush();
    expect(store.getSnapshot().rows).toEqual([{ id: 'filtered' }]);
    store.stop();
  });
}
