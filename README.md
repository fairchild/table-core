# @fairchild/table-core

**Documentation:** [fairchild.github.io/table-core](https://fairchild.github.io/table-core/) (the `docs/` folder,
published with GitHub Pages).

Loads table rows from a server one page at a time and keeps the count right. No React, no DOM, no dependencies:
it runs in a browser, in Node or under any UI framework. It uses `AbortController` and `DOMException`, which both
provide; type-check against either the DOM library or `@types/node`.

- **Types** for a table's view, selection, total and state: `TableView`, `Selection`, `Total`, `TableState`.
- **Selection algebra**: `setSelected`, `isSelected`, `selectionCount` and `removeFromSelection` for rows deleted on
  the server. An all-matching selection (`{ kind: 'all-matching', except }`) stays correct across deletions.
- **`ServerRowsStore`**, a server-side row model:
  - pages are cached by view and page size;
  - load-more pages chain their cursors, and a revalidated chain is rebuilt aside and swapped in whole;
  - out-of-date requests are aborted, and duplicate ones merged;
  - `{ atLeast }` totals are followed by one exact count, kept consistent with the rows it describes.

It has no columns, no rendering and no virtualization: you render the rows. From React, a hook over it is a thin
`useSyncExternalStore` wrapper, as [the guide](https://fairchild.github.io/table-core/guide.html#react) shows.

**Use it when** your rows live on a server and come a page at a time, you render the table yourself, and you want a
correct count, cancellation and failure states without writing them.

**Use something else when** you want columns, cell rendering or virtualization (TanStack Table or a data grid), when
all your rows are already in memory (sort them yourself), or when you want a general data cache for your whole app.

## Use

```ts
import { ServerRowsStore, removeFromSelection, selectionCount } from '@fairchild/table-core';

const store = new ServerRowsStore({
  view: { sort: [{ columnId: 'due', direction: 'ascending' }] },
  pageSize: 50,
  fetchRows: ({ view, offset, cursor, limit, signal }) => api.rows({ view, offset, cursor, limit }, { signal }),
  fetchCount: ({ view, signal }) => api.count({ view }, { signal }),
});
store.subscribe(() => render(store.getSnapshot())); // { rows, state, total, paging }
store.start(); // fetches the first page
moreButton.onclick = () => store.loadMore(); // once the first page is in
```

`fetchRows` resolves with `{ rows, total?, nextCursor? }` and `fetchCount` with a plain number; both reject on an
error status. [`docs/examples/client.js`](docs/examples/client.js) is a complete client, and `test/docs.test.ts` runs
it against [`docs/examples/server.js`](docs/examples/server.js).

## Guarantees, and where they are tested

`npm test` runs `node --test` over `test/`, with no browser and no timers. Each request is a deferred promise the
test settles, so the order of events is exact.

- `server-rows-store.test.ts`: the cursor chain, reload, page size, cancellation, failures and their scopes,
  `staleAfter` and pages mode.
- `consistency.test.ts`: rows, total and paging together, through server growth and shrinkage between visits, totals
  arriving before or after rows, and a failed refresh followed by retry.
- `regressions.test.ts`: sequences that once broke, each failing before its fix.
- `server-shapes.test.ts`: the shapes real servers take: a number on every page or page 0 only, a lower bound, no
  total, a number that stays too high and cursors.
- `deep-links-and-rebuilds.test.ts`: failed rebuilds, deep links past the end of a list with no totals and Load more
  after a short page.
- `pages-refresh.test.ts`: pages mode when a refresh fails or a count ages: saved rows stay, empty pages don't.
- `malformed-responses.test.ts` and `bad-totals.test.ts`: answers that aren't rows, counts or totals fail like errors,
  in every position, and Load more stays offered while its page loads.
- `filter.test.ts`: a filter is part of a page's identity, and never shares the unfiltered view's cache entry.
- `low-totals.test.ts`: a total below the rows a page brings is read as a lower bound, so the list doesn't end on it.
- `selection.test.ts`: the selection algebra, including deletions from both kinds of selection.
- `boundary.test.ts`: no dependencies, and sources that import only each other.
- `docs.test.ts`: the docs site. Every export is documented, links resolve, code blocks fit in 60 columns, and the
  example client runs against the example server. `npm test` builds first, because the example imports the package
  by name.

## Install

```sh
npm install @fairchild/table-core
```

It needs Node.js 22 or later, or any current browser.

## Contributing

Building, testing, the docs site and releasing are in [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed.
