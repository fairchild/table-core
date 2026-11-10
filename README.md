# @fairchild/table-core

Loads table rows from a server one page at a time and keeps the count right. It has no dependencies and no framework,
so it runs in a browser, in Node or under any UI library.

[Docs and live demo](https://fairchild.github.io/table-core/) ·
[Guide](https://fairchild.github.io/table-core/guide.html) · [API](https://fairchild.github.io/table-core/api.html)

## What it does

- **Fetches pages.** It calls your function for each page, by offset or by cursor. Load more adds pages, and pages mode
  shows one at a time.
- **Caches and cancels.** It keeps pages per view, so switching back to a sort is instant. It aborts requests you no
  longer need and merges duplicate ones.
- **Keeps the count right.** It reports "at least 100" until your count endpoint answers, so you can show "50 of 100+"
  and then the exact number.
- **Reports its state.** It tells you whose rows are on screen, whether more are loading, what failed and how old the
  rows are.
- **Helps with selection.** Functions over a selection you hold: a set of ids, or every matching row except some.

It has no columns, no rendering and no virtualization. You render the rows.

**Use it when** your rows live on a server and come a page at a time, you render the table yourself, and you want a
correct count, cancellation and failure states without writing them.

**Use something else when** you want columns, cell rendering or virtualization (TanStack Table or a data grid), when
all your rows are already in memory (sort them yourself), or when you want a general data cache for your whole app.

## Install

```sh
npm install @fairchild/table-core
```

It needs Node.js 22 or later, or any current browser. To type-check against it, include the DOM library or
`@types/node`: it uses `AbortController` and `DOMException`.

## Use

```ts
import { ServerRowsStore } from '@fairchild/table-core';

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

`fetchRows` resolves with `{ rows, total?, nextCursor? }` and `fetchCount` with a plain number. Both reject on an
error status.

From here:

- [Quick start](https://fairchild.github.io/table-core/guide.html#quick-start): a complete client, which is
  [`docs/examples/client.js`](docs/examples/client.js).
- [Your server's contract](https://fairchild.github.io/table-core/guide.html#server): what a page and a count look like.
- [Reading the state](https://fairchild.github.io/table-core/guide.html#state): what to render for each case.
- [Using it from React](https://fairchild.github.io/table-core/guide.html#react): a hook in a few lines.

## Tests

`npm test` answers each request by hand and controls the clock, so it checks the exact order of events with no browser
and no timers. [What the tests cover](https://fairchild.github.io/table-core/guide.html#guarantees) lists each suite.

## Contributing

Building, testing, the docs site and releasing are in [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed.
