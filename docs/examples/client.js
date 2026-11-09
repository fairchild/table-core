// A complete client: a store for /api/items, the
// query string it sends, and the count it shows.
// test/docs.test.ts runs this file against server.js,
// and the live demo on the landing page is built on it.
import { ServerRowsStore } from '@fairchild/table-core';

/** The view as a query string. Send it as you like. */
export function query(view, offset, limit) {
  const params = new URLSearchParams();
  const sort = view.sort[0];
  if (sort) {
    params.set('sort', sort.columnId);
    params.set('dir', sort.direction);
  }
  if (offset !== undefined) {
    params.set('offset', String(offset));
    params.set('limit', String(limit));
  }
  return params.toString();
}

// fetch() resolves on a 500 too. Check `ok`, or an
// error body is taken for an answer.
async function json(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function createItemsStore({
  fetch = globalThis.fetch,
  pageSize = 50,
} = {}) {
  const options = {
    view: { sort: [] },
    pageSize,
    // Resolves with { rows, total?, nextCursor? }.
    fetchRows: ({ view, offset, limit, signal }) =>
      fetch(`/api/items?${query(view, offset, limit)}`, {
        signal,
      }).then(json),
    // Resolves with a number: the view's exact count.
    // Asked only while a page's total is { atLeast }.
    fetchCount: ({ view, signal }) =>
      fetch(`/api/items/count?${query(view)}`, {
        signal,
      }).then(json),
  };
  const store = new ServerRowsStore(options);

  // update() takes every option: change the view and
  // pass the rest as they were.
  function sortBy(columnId, direction = 'ascending') {
    options.view = { sort: [{ columnId, direction }] };
    store.update({ ...options });
  }

  // "Select all" goes to the server as the view and
  // its exceptions, so it reaches rows not loaded yet.
  // Resolves with the ids the server archived.
  async function archive(selection) {
    const body = selection.kind === 'ids'
      ? { view: options.view, ids: [...selection.ids] }
      : { view: options.view,
          except: [...selection.except] };
    const res = await fetch('/api/items/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const { archived } = await json(res);
    store.reload();
    return archived;
  }
  return { store, sortBy, archive };
}

/** "50 of 310 items", or "50 of 100+ items" for now. */
export function countText({ rows, total }) {
  const fmt = (n) => n.toLocaleString('en-US');
  const items = (n) => (n === 1 ? 'item' : 'items');
  const shown = fmt(rows.length);
  if (total === undefined) {
    return `${shown} ${items(rows.length)}`;
  }
  if (typeof total === 'number') {
    return `${shown} of ${fmt(total)} ${items(total)}`;
  }
  return `${shown} of ${fmt(total.atLeast)}+ items`;
}
