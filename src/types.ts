// The table's public vocabulary. Plain data and functions: no framework, no DOM.

export type SortDirection = 'ascending' | 'descending';
export type SortItem = { columnId: string; direction: SortDirection };

/** Everything a saved view stores. Later versions may add optional keys. */
export type TableView = {
  /** Zero or one item: a view sorts by one column. */
  sort: SortItem[];
  /**
   * What the rows are narrowed to, such as a search term or a status: your own keys and plain JSON values, which the
   * store doesn't interpret and a view can carry into a URL. The filter is part of the view the fetchers are given and
   * of each page's cache key, so put every filter here: one closed over in `fetchRows` starts no new visit and keeps
   * the old filter's cached pages. The same filter written another way (key order, `{}` for none) counts as new and
   * refetches. A selection made under one filter belongs to it: clear the selection when the filter changes, so an
   * action never reaches rows that aren't shown.
   */
  filter?: TableFilter;
};
/** A filter's values: plain JSON, so a view serializes. */
export type FilterValue = string | number | boolean | null | readonly (string | number | boolean | null)[];
export type TableFilter = { readonly [key: string]: FilterValue | undefined };

/**
 * What is selected: these ids, or every row matching the view except these. Clearing a row's checkbox after "Select
 * all N" adds it to `except`. When rows are deleted on the server, update the selection with `removeFromSelection`:
 * a deleted row leaves `ids` and `except` alike.
 */
export type Selection =
  | { kind: 'ids'; ids: ReadonlySet<string> }
  | { kind: 'all-matching'; except: ReadonlySet<string> };

/** A count, or a lower bound while the exact figure is computed ("50 of 1,000+"). */
export type Total = number | { atLeast: number };

/**
 * What the table is showing and doing, as independent parts: whose rows, whether more are coming, what failed and
 * when the rows were fetched. Every field is optional: `{}` is a table showing its own, settled rows. The store always
 * sets `rows` and `fetching`: its settled state is `{ rows: 'current', fetching: false, since }`.
 * - `rows`: whose rows are on screen. `'current'`, the default, are this view's. `'previous'` are the last view's, kept
 *   while this one loads so the layout doesn't jump. `'none'` means nothing is on screen yet.
 * - `fetching`: rows are on the way. With current rows a table can show "Updating…" and stay usable. Otherwise it is
 *   busy.
 * - `since`: when the rows on screen were fetched. Shown when refreshing them failed.
 * - `failure`: the last request failed. `scope` says what failed: `'load'` (this view's or page's rows: hide previous
 *   rows so they never pass as this view's), `'refresh'` (rows on screen could not be refreshed: they stay, with their
 *   age) or `'more'` (the next page: the rows stay, and Load more retries).
 */
export interface TableState {
  rows?: 'current' | 'previous' | 'none';
  fetching?: boolean;
  since?: Date;
  failure?: { message?: string; retry: () => void; scope: 'load' | 'refresh' | 'more' };
}
