import type { TableState, TableView, Total } from './types.ts';

export interface ServerRowsRequest {
  view: TableView;
  /** Rows to skip. Always set, so offset-only servers work; prefer `cursor` when rows move between requests. */
  offset: number;
  /** The previous page's `nextCursor` (load-more mode), for cursor-paged servers. */
  cursor?: string;
  limit: number;
  /** Aborted when the request is out of date (the view or page changed) or the store is stopped. */
  signal: AbortSignal;
}
/**
 * One page. Without `nextCursor` (offset paging), a page with fewer rows than `limit` is the last page unless its
 * `total` (a number, or `{ atLeast }` above the rows so far) or a count learned later says there are more; an empty
 * page is always the last, as the next request would be the same one. Load more then asks from the rows it has; in
 * pages mode, page `n` is at offset `n * limit`, so a short page that isn't the last leaves a gap there. Return `limit`
 * rows whenever there are that many, or return cursors.
 */
export interface ServerRowsResponse<Row> {
  rows: Row[];
  /**
   * A number, or `{ atLeast }` while the server computes the exact count: `fetchCount` is then called, unless a short
   * offset page at or past the bound, or a page with a `null` cursor, settles the count itself. A number on each page
   * keeps the count current without `fetchCount`. Either is a non-negative finite number; anything else (NaN, a
   * string, `{ atLeast: 'x' }`) fails the request. Leave it out when the server doesn't know. The rows win over a
   * number below them: a total less than the rows through this page is read as `{ atLeast }` of them, so the rest of
   * the list stays reachable. Those rows are `offset` plus these; for an empty page in pages mode, they are the rows
   * through the furthest earlier page the store holds and still trusts: fetched since the last `reload()` and newer
   * than `staleAfter`.
   */
  total?: Total;
  /**
   * Next page's cursor, or `null` when this is the last page. A `null` settles the count at the rows through this page,
   * unless this page's `{ atLeast }` is above them. Omit for offset-only servers.
   */
  nextCursor?: string | null;
}
export interface ServerCountRequest { view: TableView; signal: AbortSignal; }

export interface ServerRowsConfig<Row> {
  view: TableView;
  /**
   * One page of rows. Reject when the request fails (check `res.ok`: `fetch` resolves on a 500). Resolving with
   * anything whose `rows` isn't an array (an error body, a status, nothing), or whose `total` isn't a count or
   * `{ atLeast }` of one, also counts as a failed request.
   */
  fetchRows: (request: ServerRowsRequest) => Promise<ServerRowsResponse<Row>>;
  /**
   * Resolves with the count as a plain number. Anything else (`{ count }`, a numeric string, NaN, Infinity, a negative
   * number) is a failed count, as a rejection is: the total stays the lower bound the pages gave.
   *
   * The exact count, asked for at most once per visit: when a page reports `{ atLeast }` without settling the count,
   * again when a count it gave is redone (reload, revalidation, a count older than `staleAfter`), when a page fetched
   * while the count is redone can't settle it and when an empty page in pages mode finds the count too high. A count
   * that pages settle themselves isn't asked for.
   *
   * The rows win here too, but only the rows held from the first row on, with no gap, through pages the store still
   * trusts: a count below them is read as `{ atLeast }` of the furthest rows held. Rows past a gap (a deep link) don't
   * prove the rows before them, so a count above the unbroken rows is exact and clamps the page.
   */
  fetchCount?: (request: ServerCountRequest) => Promise<number>;
  /** Rows per request. Default 50: rendering or sorting 500 rows costs 100–300 ms on a mid-range tablet. */
  pageSize?: number;
  /** `'load-more'` appends pages, and `'pages'` shows one page at a time. Default `'load-more'`. */
  mode?: 'load-more' | 'pages';
  /**
   * Cached pages older than this, in ms, are refetched when they come back on screen. Default 30,000. Each page is
   * refetched on its own, so with offset paging, rows that moved on the server between those responses can repeat or
   * go missing at page boundaries. Return `nextCursor` (keyset paging) when the data changes often.
   */
  staleAfter?: number;
  /** Clock, for tests. Default `Date.now`. */
  now?: () => number;
}

/** What the store shows: plain data, a new object only when something changed. */
export interface ServerRowsSnapshot<Row> {
  rows: readonly Row[];
  state: TableState;
  total?: Total;
  paging: { kind: 'load-more'; hasMore: boolean } | { kind: 'pages'; page: number; pageCount: number };
}

/**
 * The cache identity of a page: everything that changes page boundaries, which is the view (sort and filter) and
 * the page size. Anything added to a request that changes which rows a page holds must be added here too.
 */
export function pageKey(view: TableView, pageSize: number): string {
  return `${JSON.stringify(view)}|${pageSize}`;
}

/**
 * `seq`: arrival order, across the store. Clocks can tie, and arrivals can't. `total` is the page's own as the store
 * reads it (see `ServerRowsResponse.total`), which can differ from what the server sent.
 */
type Page<Row> = { rows: Row[]; total?: Total; nextCursor?: string | null; at: number; seq: number; invalid?: boolean };
type Chain<Row> = Array<Page<Row>>;
/**
 * One cache entry. `pages` is what is shown. In load-more mode it is a contiguous chain from page 0, each page
 * fetched with the cursor of the page before it. `next` is a chain being rebuilt (revalidation, reload): it is built
 * aside and replaces `pages` whole when it is complete, so old and new pages are never shown mixed. In pages mode
 * pages are independent and may have holes.
 *
 * The exact count is kept as consistent with the rows as the rows are with the server. `exactAt` is when it was
 * learned, or when an empty page last found nothing past it. A recount starts (`recountSeq`) when the rows are fetched
 * again (revalidation, reload) or the count is older than `staleAfter`. It ends when a page settles the count (a
 * number, or a short page by offset) or when `fetchCount` answers. With no `fetchCount`, an empty page in pages mode
 * that finds nothing at or past the count ends it too. `fetchCount` is asked at once for a count it gave, and otherwise
 * once a page fetched during the recount can't settle it (`needCount`), which includes an empty page at or past the
 * count while it is being redone. Until then the old count is still shown, but it bounds paging only for rows fetched
 * before the recount began (after a failed refresh, the rows on screen), and an empty page at or past it clamps to it.
 * A page kept on screen, while it is fetched again or after its refresh failed, stays in range even where it lies past
 * the count. Fresher evidence replaces it at once: a lower bound or rows above it, or a short last page by offset.
 */
type Entry<Row> = {
  pages: Array<Page<Row> | undefined>; next?: Chain<Row>; total?: Total;
  exact?: number; exactAt?: number; recount?: boolean; recountSeq?: number;
  /** Where the exact count came from: a page (its total, or how many rows a short page ends at), or `fetchCount`. */
  exactFrom?: 'page' | 'count';
  /** When (in arrival order) the exact count was learned: a count asked before it can't overwrite it. */
  exactSeq?: number;
  /** A page fetched during a recount couldn't settle the count, or an empty page found it too high: ask `fetchCount`. */
  needCount?: boolean;
  /** The count as it was when a rebuild began, put back if the rebuild fails, so it matches the rows left on screen. */
  saved?: CountState;
};
/** The parts of an entry that make up its count. */
type CountState = Pick<Entry<unknown>, 'total' | 'exact' | 'exactAt' | 'exactSeq' | 'exactFrom' | 'recount' | 'recountSeq' | 'needCount'>;
const COUNT_KEYS = ['total', 'exact', 'exactAt', 'exactSeq', 'exactFrom', 'recount', 'recountSeq', 'needCount'] as const;
type Config<Row> = Required<Omit<ServerRowsConfig<Row>, 'fetchCount'>> & Pick<ServerRowsConfig<Row>, 'fetchCount'>;
const EMPTY: never[] = [];
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** Calls now, so the request starts at once; a fetcher that throws synchronously is a failure like any other. */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try { return Promise.resolve(fn()); } catch (err) { return Promise.reject(err); }
}

function withDefaults<Row>(c: ServerRowsConfig<Row>): Config<Row> {
  // `??` per field, so `pageSize: undefined` (a caller passing its own optional prop through) means the default.
  return {
    view: c.view, fetchRows: c.fetchRows, fetchCount: c.fetchCount,
    pageSize: c.pageSize ?? 50, mode: c.mode ?? 'load-more', staleAfter: c.staleAfter ?? 30_000, now: c.now ?? Date.now,
  };
}

/**
 * The server-side row model, independent of any UI framework. One `sync()` reconciles what is wanted with what is
 * cached and in flight: it aborts requests that are out of date, starts the one that is due and asks for the exact
 * count.
 *
 * A *visit* is one stay on a view and page: it starts on `start()`, on a new view or page size, on a page change and on
 * reload. Within a visit nothing is retried by itself (a failed page waits for `retry()`, a failed count for the next
 * visit), and what is on screen is checked for staleness once, when the visit starts. A new visit starts afresh.
 */
export class ServerRowsStore<Row> {
  private cfg: Config<Row>;
  private key: string;
  private pos = { loaded: 1, page: 0 };
  private cache = new Map<string, Entry<Row>>();
  private inflight = new Map<string, AbortController>();
  private counting = new Map<string, AbortController>();
  // ---- this visit ----
  /** Pages of this key that failed to load in this visit, with the message. */
  private failed = new Map<number, string>();
  /** Refreshing rows on screen failed in this visit: they stay, as saved data. `retry()` starts a new visit. */
  private refreshFailed: string | null = null;
  /** Pages mode: pages checked for staleness in this visit. */
  private checked = new Set<number>();
  /** Load more: how many pages of the chain were checked for staleness in this visit. */
  private chainChecked = 0;
  /** The exact count was asked for in this visit. */
  private countAsked = false;
  /** Pages mode, no count: while finding the end of the list, the first page known to be empty. Ends with the view. */
  private walk: { hi: number } | null = null;
  /** The last current rows, shown as `'previous'` while another key loads. */
  private previous: { rows: readonly Row[]; total?: Total; at?: number } = { rows: EMPTY };
  private rowsMemo: { pages: Array<Page<Row>>; rows: readonly Row[] } = { pages: [], rows: EMPTY };
  private active = false;
  /** Stopped since the last `start()`. Before the first one, rows are still coming. */
  private stopped = false;
  /** Orders page arrivals and recounts (see `Page.seq`). */
  private seq = 0;
  private listeners = new Set<() => void>();
  private snap: ServerRowsSnapshot<Row>;

  constructor(config: ServerRowsConfig<Row>) {
    this.cfg = withDefaults(config);
    this.key = pageKey(this.cfg.view, this.cfg.pageSize);
    this.snap = this.compute();
  }

  // ---- Subscription -------------------------------------------------------------------------------------------------
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snap;
  /** Start fetching, as when the table appears: a new visit. */
  start = () => { this.active = true; this.stopped = false; this.newVisit(); this.sync(); };
  /** Abort everything in flight, as when the table goes away: `fetching` is false. The cache is kept for a later `start()`. */
  stop = () => { this.active = false; this.stopped = true; this.abortAll(); this.emit(); };

  /**
   * New options (all of them, as on every render): a new view, page size or mode starts a new visit. An option left out
   * goes back to its default, except `now`, which keeps the clock the store was made with.
   */
  update = (config: ServerRowsConfig<Row>) => {
    const next = withDefaults({ now: this.cfg.now, ...config });
    const key = pageKey(next.view, next.pageSize);
    const modeChanged = next.mode !== this.cfg.mode;
    this.cfg = next;
    if (key === this.key && !modeChanged) return;
    this.rememberCurrent();
    this.key = key;
    this.pos = { loaded: 1, page: 0 };
    this.walk = null; // a walk belongs to the view and mode it started in
    if (modeChanged) this.cache.clear(); // the two modes store pages differently
    this.newVisit();
    this.sync();
  };

  // ---- Commands -----------------------------------------------------------------------------------------------------
  /** Load the next page; if the next page failed, try it again. Nothing when there is no next page. */
  loadMore = () => {
    if (this.cfg.mode !== 'load-more' || this.snap.paging.kind !== 'load-more' || !this.snap.paging.hasMore) return;
    const shown = this.readyPages().length;
    if (this.inflight.has(`${this.key}#${shown}`)) return; // the next page is already on its way
    if (this.failed.delete(shown)) { this.sync(); return; }
    this.pos = { ...this.pos, loaded: shown + 1 };
    this.sync();
  };
  setPage = (page: number) => { this.walk = null; this.moveTo(page); };
  private moveTo(page: number) {
    if (page === this.pos.page || !Number.isFinite(page) || page < 0) return; // NaN would never equal itself: no loop
    this.rememberCurrent();
    this.pos = { ...this.pos, page };
    this.newVisit();
    this.sync();
  }
  /** Fetch what failed again: a failed page, or (after a failed refresh) everything stale on screen. */
  retry = () => {
    if (this.refreshFailed != null) this.newVisit();
    for (const p of this.failed.keys()) this.checked.delete(p);
    this.failed.clear();
    this.sync();
  };
  /**
   * Fetch everything again, such as after a change on the server. Rows on screen stay, as this view's, while they are
   * fetched again; if that fails they are shown as saved data. Other views are fetched again when next shown.
   */
  reload = () => {
    this.abortAll();
    for (const e of this.cache.values()) {
      this.giveUpRebuild(e);
      this.startRecount(e);
      for (const page of Object.values(e.pages)) if (page) page.invalid = true; // by key: a deep link leaves it sparse
    }
    this.newVisit();
    this.sync();
  };

  // ---- Reconcile ----------------------------------------------------------------------------------------------------
  /**
   * Every visit starts clean: page requests of the last one are aborted (a count of the same view carries on), and
   * nothing it failed, checked or half rebuilt is carried over.
   */
  private newVisit() {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    this.failed.clear();
    this.refreshFailed = null;
    this.checked.clear();
    this.chainChecked = 0;
    this.countAsked = false;
    for (const e of this.cache.values()) this.giveUpRebuild(e);
  }
  /**
   * A rebuild that won't finish takes its count with it: the rows left on screen keep the count they came with. A
   * count `fetchCount` gave during the rebuild is newer than both, and stays.
   */
  private giveUpRebuild(e: Entry<Row>) {
    const counted = e.exactFrom === 'count' && (e.exactSeq ?? -Infinity) > (e.saved?.exactSeq ?? -Infinity);
    if (e.next && e.saved && !counted) Object.assign(e, e.saved);
    e.next = undefined;
    e.saved = undefined;
  }
  private wanted(): number[] {
    return this.cfg.mode === 'pages' ? [this.pos.page] : Array.from({ length: this.pos.loaded }, (_, i) => i);
  }
  private entry(key = this.key) {
    let e = this.cache.get(key);
    if (!e) this.cache.set(key, (e = { pages: [] }));
    return e;
  }
  private stale(page: Page<Row>) {
    return page.invalid || this.cfg.now() - page.at >= this.cfg.staleAfter;
  }
  /**
   * Whether a page follows the last page of `chain`. By offset, the chain was fetched in order, so it holds every row
   * before its end: an empty page is the end whatever any count says (the next request would be the same one), and
   * otherwise the count, if it can bound these pages, says whether rows remain. Without one, a full page may be
   * followed by another, and a short page is the end unless its own total says there are more rows.
   */
  private continues(chain: ReadonlyArray<Page<Row> | undefined>) {
    const last = chain[chain.length - 1];
    if (!last) return chain.length === 0;
    if (last.nextCursor !== undefined) return last.nextCursor !== null;
    if (last.rows.length === 0) return false;
    const held = rowsIn(chain);
    const exact = this.boundary(this.cache.get(this.key), chain);
    if (exact != null) return held < exact;
    return last.rows.length === this.cfg.pageSize || (lowerBound(last.total) ?? 0) > held;
  }
  /** The exact count, if it can bound paging for these pages: no recount under way, or pages from before it began. */
  private boundary(e: Entry<Row> | undefined, pages: ReadonlyArray<Page<Row> | undefined>): number | undefined {
    if (e?.exact == null) return undefined;
    if (!e.recount) return e.exact;
    // A page not loaded yet may come back with rows the old count doesn't know about.
    if (pages.some((p) => !p)) return undefined;
    const newest = Math.max(-Infinity, ...pages.map((p) => p?.seq ?? -Infinity));
    return newest < (e.recountSeq ?? -Infinity) ? e.exact : undefined;
  }
  /** Pages that prove their rows: fetched since the count was redone, and still fresh. */
  private trusted(e: Entry<Row>) {
    const since = e.recount ? e.recountSeq ?? -Infinity : -Infinity;
    return (page: Page<Row>) => page.seq > since && !this.stale(page);
  }
  private setExact(e: Entry<Row>, n: number, from: 'page' | 'count') {
    e.exact = n;
    e.exactAt = this.cfg.now();
    e.exactSeq = ++this.seq;
    e.exactFrom = from;
    this.endRecount(e);
  }
  private dropExact(e: Entry<Row>) {
    e.exact = e.exactAt = e.recountSeq = e.exactSeq = e.exactFrom = undefined;
    e.recount = false;
  }
  /** The count stands: it was just learned, or nothing fetched since the recount began disagrees with it. */
  private endRecount(e: Entry<Row>) {
    e.recount = false;
    e.recountSeq = undefined;
    e.needCount = false;
  }
  /** The rows are being fetched again, or the count has aged: ask for it again (once per visit, with a `fetchCount`). */
  private startRecount(e: Entry<Row>) {
    if (e.exact == null || e.recount) return;
    e.recount = true;
    e.recountSeq = ++this.seq;
  }
  private sync() {
    if (this.active) {
      const wanted = this.wanted();
      const keep = new Set(wanted.map((p) => `${this.key}#${p}`));
      for (const [k, c] of this.inflight) if (!keep.has(k)) { c.abort(); this.inflight.delete(k); }
      for (const [k, c] of this.counting) if (k !== this.key) { c.abort(); this.counting.delete(k); }
      const e = this.entry();
      if (this.cfg.mode === 'load-more') this.syncChain(e, wanted.length);
      else this.syncPage(e, this.pos.page);
      // Once per visit, ask `fetchCount` for a total that is only a lower bound, for a count that came from it and is
      // being redone, or when a page couldn't settle the count. A count a page settles is left to the pages.
      const bounded = e.total != null && typeof e.total !== 'number';
      const ask = (bounded && e.exact == null) || e.needCount || (e.recount && e.exactFrom === 'count');
      if (!this.countAsked && ask) this.fetchCount();
      if (this.clampPage()) return;
    }
    this.emit();
  }
  /**
   * Load more: one request at a time, each with the cursor of the page before it. The chain on screen is checked for
   * staleness once per visit; from its first stale page it is rebuilt aside and swapped in whole when complete.
   */
  private syncChain(e: Entry<Row>, n: number) {
    const shown = e.pages as Chain<Row>;
    if (this.chainChecked === 0 && !this.refreshFailed) {
      // The visit's first look: rebuild from the first stale page on screen.
      const s = shown.slice(0, n).findIndex((page) => this.stale(page));
      if (s >= 0) {
        e.next = shown.slice(0, s);
        this.startRecount(e); // the count is as old as the rows: ask again with them
        e.saved = pick(e);
      }
      this.chainChecked = n;
    } else if (n > this.chainChecked) {
      // Load more reveals cached pages: a stale one, and every page after it, is fetched again before it shows.
      const s = shown.slice(this.chainChecked, n).findIndex((page) => this.stale(page));
      if (s >= 0) shown.length = this.chainChecked + s;
      this.chainChecked = n;
    }
    const chain = e.next ?? shown;
    const p = chain.length;
    if (e.next && (p >= n || !this.continues(chain))) {
      // The rebuild is complete (or the list now ends sooner): swap it in.
      e.pages = e.next;
      e.next = undefined;
      e.saved = undefined;
      if (!this.continues(e.pages)) this.pos = { ...this.pos, loaded: Math.max(1, Math.min(this.pos.loaded, e.pages.length)) };
      return;
    }
    if (p < n && this.continues(chain) && !this.failed.has(p)) this.fetchPage(p, chain);
  }
  /** Pages: each page on its own, checked for staleness when it comes on screen. */
  private syncPage(e: Entry<Row>, p: number) {
    if (this.failed.has(p) || this.checked.has(p)) return;
    this.checked.add(p);
    const page = e.pages[p];
    if (page && this.stale(page)) this.startRecount(e); // the count is as old as the rows
    if (!page || this.stale(page)) this.fetchPage(p, e.pages);
  }
  private fetchPage(p: number, into: Array<Page<Row> | undefined>) {
    const key = this.key;
    const rk = `${key}#${p}`;
    if (this.inflight.has(rk)) return; // merge duplicates
    const e = this.entry(key);
    const ctrl = new AbortController();
    this.inflight.set(rk, ctrl);
    // A count older than `staleAfter` doesn't bound a page fetched now: ask for it again.
    if (e.exact != null && this.cfg.now() - (e.exactAt ?? -Infinity) >= this.cfg.staleAfter) this.startRecount(e);
    // Cursors chain in load-more mode only; a page of pages is asked for by offset.
    const cursor = this.cfg.mode === 'load-more' && p > 0 ? into[p - 1]?.nextCursor ?? undefined : undefined;
    const { pageSize, view, fetchRows } = this.cfg;
    // Load more asks from the rows it has: after a short page that isn't the last (rows were added meanwhile), a full
    // `limit` on would skip rows. A page of pages is at its own place.
    const offset = this.cfg.mode === 'load-more' ? rowsIn(into.slice(0, p)) : p * pageSize;
    attempt(() => fetchRows({ view, offset, cursor, limit: pageSize, signal: ctrl.signal }))
      .then((res) => {
        if (ctrl.signal.aborted) return; // also covers fetchers that ignore the signal
        if (into !== e.pages && into !== e.next) return; // its chain was given up or swapped meanwhile
        // What isn't a rows response fails like an error: a fetcher that didn't check `res.ok` resolves with the
        // server's error body, which has to show as a failure.
        if (!res || typeof res !== 'object' || !Array.isArray(res.rows)) throw new Error('The server sent no rows.');
        // A total decides paging, so one the store can't trust fails the same way, and can't end or loop the list.
        if (!isTotal(res.total)) throw new Error('The server sent a total that isn’t a count.');
        const n = res.rows.length;
        const reached = offset + n;
        // Rows win (see `ServerRowsResponse.total`). Before an empty page, pages older than `staleAfter` or than a
        // recount may hold deleted rows, so they don't count; a stale empty page may have rows now, so it ends nothing.
        const paged = this.cfg.mode === 'pages';
        const proven = n > 0 || !paged ? reached : reach(into, p, pageSize, this.trusted(e));
        const next = into[p + 1];
        const atEnd = paged && (n === 0 ? proven === offset : n === pageSize && next?.rows.length === 0 && !this.stale(next));
        const total: Total | undefined = typeof res.total === 'number' && res.total < proven ? (atEnd ? proven : { atLeast: proven }) : res.total;
        into[p] = { rows: res.rows, total, nextCursor: res.nextCursor, at: this.cfg.now(), seq: ++this.seq };
        if (typeof total === 'number') this.setExact(e, total, 'page');
        else {
          // Rows past the exact count prove it out of date. An empty page only says there are no rows at its offset.
          if (e.exact != null && n > 0 && reached > e.exact) this.dropExact(e);
          if (total) {
            e.total = total;
            // A lower bound above the exact count proves it out of date too: the bound shows until a count comes.
            if (e.exact != null && total.atLeast > e.exact) this.dropExact(e);
          }
          // By offset, a page shorter than `limit` is the end of the list, unless its own bound says there are more
          // rows than it shows. A short page with rows says how many there are now: `offset` skipped, and these. So
          // does an empty one in load-more mode, where the pages before it were fetched just now, in order, and so
          // does a page whose cursor is `null`, whatever its length.
          const last = res.nextCursor === null || (res.nextCursor === undefined && n < pageSize);
          const ends = last && !(total && total.atLeast > reached);
          if (ends && (n > 0 || p === 0 || this.cfg.mode === 'load-more')) this.setExact(e, reached, 'page');
          else if (ends && e.exact != null && e.exact > offset) {
            // Pages mode: the pages before may be old, so an empty page proves only that there are fewer rows than the
            // count says. How many is unknown, so a recount asks `fetchCount`.
            this.startRecount(e);
            e.needCount = true;
          } else if (ends && e.exact != null) {
            // No rows at or past the count: nothing here disputes it. A count being redone can't stand on that, though:
            // rows may have been added below this offset since. With `fetchCount`, keep it owed; otherwise it stands.
            if (e.recount && this.cfg.fetchCount) e.needCount = true;
            else {
              e.exactAt = this.cfg.now();
              this.endRecount(e);
            }
          } else if (e.recount) e.needCount = true; // a page that can't settle a count being redone: ask `fetchCount`
        }
        this.failed.delete(p);
      })
      .catch((err: unknown) => {
        if (isAbort(err) || ctrl.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        if (into === e.next || e.pages[p]) {
          // Refreshing what is on screen failed: give the rebuild up and keep the rows, as saved data. Pages asked for
          // during the rebuild aren't fetched on the old chain by themselves: Load more asks for them again.
          this.giveUpRebuild(e);
          this.refreshFailed = message;
          if (this.cfg.mode === 'load-more') this.pos = { ...this.pos, loaded: Math.max(1, Math.min(this.pos.loaded, e.pages.length)) };
        } else this.failed.set(p, message);
      })
      .finally(() => {
        if (this.inflight.get(rk) !== ctrl) return;
        this.inflight.delete(rk);
        this.sync(); // the next page in a chain, a swap, a count, or a clamp may now be due
      });
  }
  private fetchCount() {
    const fc = this.cfg.fetchCount;
    const key = this.key;
    if (!fc || this.counting.has(key)) return;
    this.countAsked = true;
    const ctrl = new AbortController();
    this.counting.set(key, ctrl);
    const asked = ++this.seq;
    attempt(() => fc({ view: this.cfg.view, signal: ctrl.signal }))
      .then((n) => {
        // A count is a number. Anything else (`{ count }`, an error body) is a failed count.
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error('The count is not a number.');
        const e = this.entry(key);
        // A total learned since the count was asked (from a page) is newer: keep it.
        if (ctrl.signal.aborted || (e.exactSeq ?? -Infinity) >= asked) return;
        // Rows win, as over a page's total, but only rows held without a gap from the first row overrule a count: rows
        // past a gap (a deep link) leave the rows before them unproven. The bound is then the furthest rows held.
        const trusted = this.trusted(e);
        const held = unbroken(e.pages, trusted);
        if (n >= held) this.setExact(e, n, 'count');
        else {
          this.dropExact(e);
          const furthest = this.cfg.mode === 'pages' ? reach(e.pages, Infinity, this.cfg.pageSize, trusted) : held;
          e.total = { atLeast: Math.max(furthest, lowerBound(e.total) ?? 0) };
        }
      })
      .catch(() => undefined) // a failed count leaves `{ atLeast }`, and the next visit asks again
      .finally(() => {
        if (this.counting.get(key) !== ctrl) return;
        this.counting.delete(key);
        this.sync(); // the exact count can put the page past the end
      });
  }
  /**
   * Pages mode: a page past the end of the list (a deep link, or rows removed on the server) moves to the last page:
   * by the count when one bounds this page, otherwise by finding where the list ends.
   */
  private clampPage(): boolean {
    if (this.cfg.mode !== 'pages') return false;
    const e = this.entry();
    const p = this.pos.page;
    const page = this.loaded(e, p);
    const settled = page != null;
    const empty = settled && page.rows.length === 0;
    // A refresh that failed leaves saved rows on screen, as they were: no count moves them.
    if (this.refreshFailed != null && !empty) return false;
    // A page being fetched again isn't loaded yet either: its own answer places it, and a count that bounds its old
    // copy leaves it where it is.
    // An empty page at or past a count being redone disputes nothing: go by that count while the new one is on its way.
    const past = empty && e.exact != null && p * this.cfg.pageSize >= e.exact ? e.exact : undefined;
    const exact = this.boundary(e, [page]) ?? past;
    if (exact != null) {
      this.walk = null;
      if (p === 0) return false;
      const last = Math.max(0, Math.ceil(exact / this.cfg.pageSize) - 1);
      if (!empty && p <= last) return false;
      this.moveTo(Math.min(empty ? p - 1 : last, last));
      return true;
    }
    // No count to say where the list ends: find it by halving between the last page known to hold rows and the first
    // known to be empty, so a deep link far past the end costs a few requests.
    if (empty && p > 0) this.walk = { hi: p };
    else if (!(settled && this.walk && page.rows.length === this.cfg.pageSize && p + 1 < this.walk.hi)) {
      if (settled) this.walk = null;
      return false;
    }
    const hi = this.walk!.hi;
    let lo = 0;
    // By key: a deep link leaves the array sparse and long.
    for (const k of Object.keys(e.pages)) {
      const i = Number(k);
      if ((e.pages[i]?.rows.length ?? 0) > 0 && i < hi && i > lo) lo = i;
    }
    const target = e.pages[lo] && e.pages[lo]!.rows.length < this.cfg.pageSize ? lo : hi - lo <= 1 ? lo : Math.floor((lo + hi) / 2);
    this.moveTo(target);
    return true;
  }
  /** The page, if it is here and not being fetched again: only then can a count bound it. */
  private loaded(e: Entry<Row> | undefined, p: number): Page<Row> | undefined {
    const page = e?.pages[p];
    return page && !this.inflight.has(`${this.key}#${p}`) ? page : undefined;
  }
  private abortAll() {
    for (const c of this.inflight.values()) c.abort();
    for (const c of this.counting.values()) c.abort();
    this.inflight.clear();
    this.counting.clear();
  }

  // ---- Snapshot -----------------------------------------------------------------------------------------------------
  private readyPages(): Array<Page<Row>> {
    const e = this.cache.get(this.key);
    const out: Array<Page<Row>> = [];
    for (const p of this.wanted()) {
      const page = e?.pages[p];
      if (!page) break;
      out.push(page);
    }
    return out;
  }
  private currentRows(ready: Array<Page<Row>>): readonly Row[] {
    const m = this.rowsMemo;
    if (ready.length !== m.pages.length || ready.some((p, i) => p !== m.pages[i])) {
      this.rowsMemo = { pages: ready, rows: ready.length === 1 ? ready[0].rows : ready.flatMap((p) => p.rows) };
    }
    return this.rowsMemo.rows;
  }
  private rememberCurrent() {
    const ready = this.readyPages();
    if (ready.length) {
      const e = this.cache.get(this.key);
      this.previous = { rows: this.currentRows(ready), total: e?.exact ?? e?.total, at: Math.min(...ready.map((p) => p.at)) };
    }
  }
  private compute(): ServerRowsSnapshot<Row> {
    const e = this.cache.get(this.key);
    const wanted = this.wanted();
    const ready = this.readyPages();
    const current = ready.length > 0;
    const failedPage = wanted.find((p) => this.failed.has(p));
    const fetching = wanted.some((p) => this.inflight.has(`${this.key}#${p}`));
    const rowsKind = current ? 'current' : this.previous.rows.length ? 'previous' : 'none';
    const rows = current ? this.currentRows(ready) : this.previous.rows;
    const since = current ? Math.min(...ready.map((p) => p.at)) : this.previous.at;
    // Not everything wanted is here and nothing failed: on the way, or about to be, before the first `start()` or sync.
    const missing = ready.length < wanted.length && (this.cfg.mode === 'pages' || this.continues(ready));
    const state: TableState = { rows: rowsKind, fetching: fetching || (failedPage == null && missing && !this.stopped) };
    if (since != null) state.since = new Date(since);
    if (failedPage != null) {
      // A page that isn't on screen failed: the next page of a list (more), or this view's or page's rows (load).
      // It takes precedence over a failed refresh: it is what the person just asked for.
      const scope = failedPage > 0 && failedPage === ready.length && this.cfg.mode === 'load-more' ? 'more' : 'load';
      state.failure = { message: this.failed.get(failedPage), retry: this.retry, scope };
    } else if (this.refreshFailed != null && current) {
      state.failure = { message: this.refreshFailed, retry: this.retry, scope: 'refresh' };
    }
    const exact = e?.exact;
    const total: Total | undefined = exact ?? e?.total ?? (current ? undefined : this.previous.total);
    const { pageSize } = this.cfg;
    let paging: ServerRowsSnapshot<Row>['paging'];
    if (this.cfg.mode === 'pages') {
      const page = this.pos.page;
      const here = e?.pages[page];
      const sure = this.boundary(e, [here]);
      // A lower bound only counts while there's no exact count: an old one doesn't come back above it.
      const bound = sure ?? (e?.exact == null && e?.total && typeof e.total !== 'number' ? e.total.atLeast : undefined);
      const known = bound != null ? Math.ceil(bound / pageSize) : 0;
      const more = !!here && here.rows.length >= pageSize;
      // While the count is being redone, the old one is still a floor: the pager doesn't shrink before the new count.
      const floor = sure == null && e?.recount && e.exact != null ? Math.ceil(e.exact / pageSize) : 0;
      // A page kept on screen stays in range: while it is fetched again, or after its refresh failed.
      const kept = fetching || this.refreshFailed != null ? page + 1 : 0;
      const pageCount = Math.max(1, sure != null ? Math.max(known, kept) : Math.max(known, floor, page + 1 + (more ? 1 : 0)));
      paging = { kind: 'pages', page: Math.min(page, pageCount - 1), pageCount };
    } else {
      const moreFailed = state.failure?.scope === 'more';
      // While the next page is on its way, Load more stays offered (and busy), so its button and focus stay put.
      const nextOnItsWay = current && ready.length < wanted.length && this.inflight.has(`${this.key}#${ready.length}`);
      paging = { kind: 'load-more', hasMore: moreFailed || nextOnItsWay || (current && ready.length === wanted.length && this.continues(ready)) };
    }
    return { rows, state, total, paging };
  }
  private emit() {
    const next = this.compute();
    if (same(next, this.snap)) return;
    this.snap = next;
    for (const fn of this.listeners) fn();
  }
}

function same<Row>(a: ServerRowsSnapshot<Row>, b: ServerRowsSnapshot<Row>) {
  const sa = a.state, sb = b.state;
  return a.rows === b.rows && a.total === b.total && JSON.stringify(a.paging) === JSON.stringify(b.paging) &&
    sa.rows === sb.rows && sa.fetching === sb.fetching && sa.since?.getTime() === sb.since?.getTime() &&
    sa.failure?.scope === sb.failure?.scope && sa.failure?.message === sb.failure?.message;
}

/** No total, a count or a lower bound of one: a count is a non-negative finite number. */
function isTotal(t: unknown): boolean {
  const count = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (t == null) return true;
  return count(t) || (typeof t === 'object' && count((t as { atLeast?: unknown }).atLeast));
}

/** How many rows these pages hold. */
function rowsIn<Row>(pages: ReadonlyArray<Page<Row> | undefined>) {
  let n = 0;
  for (const page of pages) n += page?.rows.length ?? 0;
  return n;
}
/** Pages mode: how many rows the `trusted` pages held before page `p` prove, by where the furthest of them ends. */
function reach<Row>(pages: ReadonlyArray<Page<Row> | undefined>, p: number, pageSize: number, trusted: (page: Page<Row>) => boolean) {
  let n = 0;
  // By key: a deep link leaves the array sparse and long.
  for (const k of Object.keys(pages)) {
    const q = Number(k);
    const page = pages[q];
    if (q < p && page && page.rows.length > 0 && trusted(page)) n = Math.max(n, q * pageSize + page.rows.length);
  }
  return n;
}
/** The rows the `trusted` pages hold from the first row on, up to the first page missing or not trusted. */
function unbroken<Row>(pages: ReadonlyArray<Page<Row> | undefined>, trusted: (page: Page<Row>) => boolean) {
  let n = 0;
  for (const page of pages) {
    if (!page || !trusted(page)) break;
    n += page.rows.length;
  }
  return n;
}
/** The fewest rows a total allows. */
function lowerBound(total: Total | undefined): number | undefined {
  return typeof total === 'number' ? total : total?.atLeast;
}
function pick<Row>(e: Entry<Row>): CountState {
  const out: CountState = {};
  for (const k of COUNT_KEYS) (out as Record<string, unknown>)[k] = e[k];
  return out;
}
