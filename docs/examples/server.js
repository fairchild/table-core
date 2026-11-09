// A pretend server, as a fetch(): it answers the URLs
// client.js asks for, with real delays. The docs test
// and the live demo use it; your server replaces it.
const VERBS = ['Review', 'Draft', 'Fix', 'Plan', 'Ship'];
const THINGS = ['contract', 'budget', 'invoice', 'rota',
  'release notes', 'pricing page', 'onboarding'];

function item(n) {
  const title = `${VERBS[n % 5]} ${THINGS[(n * 3) % 7]}`
    + ` ${n}`;
  const day = 1 + ((n * 7) % 28);
  const pad = (x) => String(x).padStart(2, '0');
  const due = `2026-${pad(1 + (n % 12))}-${pad(day)}`;
  return { id: `IT-${n}`, title, due };
}

export function createItemsServer({
  items = 310, latency = 450, countLatency = 1600,
} = {}) {
  const fresh = () => Array.from({ length: items },
    (_, i) => item(i + 1));
  let rows = fresh();
  let next = items + 1;
  let slow = false;
  let failNext = false;
  let log = [];
  let seq = 0;
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(); };

  function sorted(params) {
    const key = params.get('sort');
    const dir = params.get('dir') === 'descending' ? -1 : 1;
    if (key !== 'title' && key !== 'due' && key !== 'id') {
      return rows;
    }
    const num = (r) => Number(r.id.slice(3));
    return [...rows].sort((a, b) => {
      const c = key === 'id' ? num(a) - num(b)
        : a[key].localeCompare(b[key]);
      return (c || num(a) - num(b)) * dir;
    });
  }

  // POST /api/items/archive with { view, ids } or, for
  // "select all", { view, except }: every row matching
  // the view except those. This server has no filters,
  // so every row matches.
  function archive(body) {
    const { ids, except } = JSON.parse(body);
    const out = new Set(except);
    const gone = ids
      ? rows.filter((r) => ids.includes(r.id))
      : rows.filter((r) => !out.has(r.id));
    rows = rows.filter((r) => !gone.includes(r));
    return [200, { archived: gone.map((r) => r.id) }];
  }

  function answer(url, init) {
    if (url.pathname === '/api/items/archive') {
      return init.method === 'POST'
        ? archive(init.body) : [405, null];
    }
    const params = url.searchParams;
    const list = sorted(params);
    if (url.pathname === '/api/items/count') {
      return [200, list.length];
    }
    if (url.pathname !== '/api/items') return [404, null];
    const offset = Number(params.get('offset') ?? 0);
    const limit = Number(params.get('limit') ?? 50);
    const page = list.slice(offset, offset + limit);
    const end = offset + page.length;
    // Like many databases: a lower bound until the
    // (slower) count query answers.
    const total = end >= list.length ? list.length
      : { atLeast: Math.min(list.length, end + limit) };
    return [200, { rows: page, total }];
  }

  function fetch(input, init = {}) {
    const { signal, method = 'GET', body } = init;
    const url = new URL(input, 'http://pretend.test');
    const isCount = url.pathname.endsWith('/count');
    const isRows = url.pathname === '/api/items';
    const path = url.pathname + url.search;
    const entry = {
      id: ++seq, status: 'pending', ms: 0,
      url: method === 'GET' ? path
        : `${method} ${path} ${body ?? ''}`.trim(),
    };
    log = [entry, ...log].slice(0, 12);
    emit();
    const set = (status) => {
      log = log.map((e) => (e.id === entry.id
        ? { ...e, status, ms: Date.now() - started } : e));
      emit();
    };
    const started = Date.now();
    const wait = (isCount ? countLatency : latency)
      * (slow ? 4 : 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        let [status, json] = [503, { error: 'Unavailable' }];
        if (failNext && isRows) failNext = false;
        else [status, json] = answer(url, init);
        set(status);
        resolve(new Response(JSON.stringify(json), {
          status,
          headers: { 'content-type': 'application/json' },
        }));
      }, wait);
      function abort() {
        clearTimeout(timer);
        set('canceled');
        reject(new DOMException('Aborted', 'AbortError'));
      }
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort);
    });
  }

  return {
    fetch,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getLog: () => log,
    get size() { return rows.length; },
    get slow() { return slow; },
    setSlow(on) { slow = on; emit(); },
    /** The next rows request answers 503, once. */
    failNextRequest() { failNext = true; },
    addRows(n) {
      for (let i = 0; i < n; i++) {
        rows.push(item(next++));
      }
    },
    deleteRow(id) {
      rows = rows.filter((r) => r.id !== id);
    },
    /** Back to the first rows, as on page load. */
    reset() {
      rows = fresh();
      next = items + 1;
    },
  };
}
