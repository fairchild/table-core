# Changelog

Versions follow [semver](https://semver.org). Until 1.0, a minor version (0.2.0) may break the API; a patch version
(0.1.1) does not. Every breaking change is listed under **Breaking**, with what to change.

## Unreleased

### Added

- `maxViews` on `ServerRowsStore`: how many views keep their pages, counting the one on screen. Default 20.

### Changed

- The page cache is bounded. It kept every view until the mode changed; now it keeps the 20 shown most recently, and a
  view past that is fetched again when it comes back. `maxViews: Infinity` keeps them all, as before.

## 0.1.0

First release.

### Added

- `ServerRowsStore`: a server-side row model. It fetches pages on demand by offset or cursor, in load-more or pages
  mode, caches them per view and page size, merges duplicate requests and aborts outdated ones. It follows a
  `{ atLeast }` total with one exact count from `fetchCount`, and asks again when the rows are refreshed. Its snapshot
  reports `TableState`: whose rows are shown, whether more are on the way, what failed and how old the rows are.
- `pageKey(view, pageSize)`: the cache identity of a page.
- Selection helpers over a value you hold: `isSelected`, `setSelected`, `removeFromSelection` and `selectionCount`.
  A selection is a set of ids, or every row matching the view except some.
- Types: `TableView` with an optional `filter` (`TableFilter`, `FilterValue`), `SortItem`, `SortDirection`,
  `Selection`, `Total`, `TableState`, and the store's config, request, response, count request and snapshot types.

### Behavior worth knowing

- A response that isn't `{ rows: [...] }`, a `total` that isn't a count or `{ atLeast }` of one, and a `fetchCount`
  answer that isn't a non-negative finite number all count as failed requests.
- Rows win over a `total` below them: such a total is read as `{ atLeast }` of the rows, so the list doesn't end on
  it. Past a full last page, an empty page's low total counts the rows through the furthest page held. A
  `fetchCount` answer below the rows held with no gap from the first row, fetched since the last `reload()` and newer
  than `staleAfter`, is read the same way. The two use different rows: an empty page past held pages shows where the
  list ends, and a count is overruled only by rows that prove every row before them.
- A page with `nextCursor: null` ends the list and settles the count at the rows through it, unless its own
  `{ atLeast }` is above them.
- A failed refresh keeps the rows on screen, with their age and their count.
- Before the first `start()`, the snapshot is `{ rows: 'none', fetching: true }`: the rows are coming, so a table
  rendered before it starts shows loading rather than an empty list. After `stop()`, `fetching` is false.
- In pages mode a deep link past the end finds the last page by halving, in a few requests.
