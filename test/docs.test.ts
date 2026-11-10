// The docs site (docs/, published with GitHub Pages) stays in step with the code: every export has an entry in the API
// reference, and every link between pages resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const docs = new URL('docs/', root);
const pages = readdirSync(docs).filter((f) => f.endsWith('.html'));
const html = (name: string) => readFileSync(new URL(name, docs), 'utf8');
const ids = (name: string) => new Set([...html(name).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test('every export of the package has an entry in the API reference', () => {
  const index = readFileSync(new URL('src/index.ts', root), 'utf8');
  const exported = [...index.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.replace(/^\s*type\s+/, '').trim())
    .filter(Boolean);
  assert.ok(exported.length > 10, 'found the exports');
  const anchors = ids('api.html');
  assert.deepEqual(exported.filter((name) => !anchors.has(name)), []);
});

test('links between pages resolve, anchors included', () => {
  const broken: string[] = [];
  for (const page of pages) {
    for (const [, href] of html(page).matchAll(/\shref="([^"]+)"/g)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [path, hash] = href.split('#');
      const target = path === '' ? page : path === './' ? 'index.html' : path;
      if (!existsSync(new URL(target, docs))) { broken.push(`${page}: ${href}`); continue; }
      if (hash && target.endsWith('.html') && !ids(target).has(hash)) broken.push(`${page}: ${href}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every page has a title, a description, a language and a skip link', () => {
  for (const page of pages) {
    const s = html(page);
    assert.match(s, /<html lang="en">/, page);
    assert.match(s, /<title>[^<]+<\/title>/, page);
    assert.match(s, /<meta name="description" content="[^"]+">/, page);
    assert.match(s, /<a class="skip" href="#main">/, page);
    assert.ok(ids(page).has('main'), page);
  }
});

test('every page has a favicon and share tags whose image is on the published site', () => {
  const site = 'https://fairchild.github.io/table-core/';
  for (const page of pages) {
    const s = html(page);
    const meta = (key: string) => s.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]+)">`))?.[1];
    const icon = s.match(/<link rel="icon" href="([^"]+)"/)?.[1];
    assert.ok(icon && existsSync(new URL(icon, docs)), `${page}: favicon`);
    assert.equal(meta('og:title'), s.match(/<title>([^<]+)<\/title>/)?.[1], `${page}: og:title`);
    assert.equal(meta('og:description'), meta('description'), `${page}: og:description`);
    assert.equal(meta('twitter:card'), 'summary_large_image', `${page}: twitter:card`);
    const image = meta('og:image') ?? '';
    assert.ok(image.startsWith(site), `${page}: og:image ${image} is absolute, on ${site}`);
    assert.ok(existsSync(new URL(image.slice(site.length), docs)), `${page}: ${image} exists in docs/`);
  }
});

// No browser runs here, so this reads the CSS: at 1280px only the plain list renders, and the phone disclosure's
// summary is display: none, so it is neither a tab stop nor announced. Both list the same links.
test('the contents are a plain list on wide screens and a disclosure on phones, never both', () => {
  const css = readFileSync(new URL('assets/style.css', docs), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const wide = [...css.matchAll(/@media \(min-width: 64rem\) \{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].map((m) => m[1]).join('');
  const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '');
  assert.match(outside, /\.toc-wide \{ display: none; \}/, 'below 64rem the plain list is hidden');
  assert.match(wide, /\.toc-wide \{ display: block; \}/, 'at 64rem and wider the plain list shows');
  assert.match(wide, /\.toc-narrow \{ display: none; \}/, 'at 64rem and wider the disclosure, summary and all, is hidden');
  const withToc = pages.filter((page) => html(page).includes('class="page with-toc"'));
  assert.ok(withToc.length >= 2, 'the guide and the API have contents');
  for (const page of withToc) {
    const s = html(page);
    const nav = (kind: string) => s.match(new RegExp(`<nav class="toc toc-${kind}"[^>]*>([\\s\\S]*?)</nav>`))?.[1] ?? '';
    const links = (block: string) => [...block.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.doesNotMatch(nav('wide'), /<(details|summary|button)|tabindex/, `${page}: the wide contents hold only links`);
    assert.match(nav('narrow'), /<details>\s*<summary>/, `${page}: the phone contents are a disclosure`);
    assert.ok(links(nav('wide')).length > 5, `${page}: the wide contents list links`);
    assert.deepEqual(links(nav('narrow')), links(nav('wide')), `${page}: both renderings list the same links`);
  }
});

// ---- Doc code runs, and fits ---------------------------------------------------------------------------------------

const unescape = (s: string) =>
  s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const codeBlocks = (name: string) =>
  [...html(name).matchAll(/<pre([^>]*)>([\s\S]*?)<\/pre>/g)].map((m) => ({ attrs: m[1], text: unescape(m[2]) }));

test('every code block wraps at 60 columns, so none is clipped', () => {
  const wide: string[] = [];
  for (const page of pages) {
    for (const block of codeBlocks(page)) {
      for (const line of block.text.split('\n')) if (line.length > 60) wide.push(`${page}: ${line}`);
    }
  }
  assert.deepEqual(wide, []);
});

test('every code block names its language, so the JavaScript and TypeScript ones are colored', () => {
  const unnamed: string[] = [];
  for (const page of pages) {
    for (const [, open] of html(page).matchAll(/<pre[^>]*>(<code[^>]*>)/g)) {
      if (!/^<code class="language-(js|ts|sh|text)">$/.test(open)) unnamed.push(`${page}: ${open}`);
    }
  }
  assert.deepEqual(unnamed, []);
});

test('the API signatures are colored as TypeScript, and hold only text for the highlighter to rewrite', () => {
  const s = html('api.html');
  const lists = [...s.matchAll(/<dl class="([^"]+)">([\s\S]*?)<\/dl>/g)];
  assert.ok(lists.length >= 5, 'found the member lists');
  for (const [, cls, body] of lists) {
    assert.equal(cls, 'api language-ts');
    for (const [, dt] of body.matchAll(/<dt>([\s\S]*?)<\/dt>/g)) assert.doesNotMatch(dt, /</, `<dt>${dt}</dt>`);
  }
});

test('highlighting keeps every character and tells keywords, strings, comments, calls and types apart', async () => {
  const { tokenize } = await import(new URL('assets/highlight.js', docs).href);
  type Run = [string | null, string];
  for (const page of pages) {
    const blocks = [...html(page).matchAll(/<code class="language-(?:js|ts)">([\s\S]*?)<\/code>/g)];
    const lists = [...html(page).matchAll(/<dl class="[^"]*language-ts[^"]*">([\s\S]*?)<\/dl>/g)];
    const signatures = lists.flatMap(([, list]) => [...list.matchAll(/<dt>([\s\S]*?)<\/dt>/g)]);
    for (const [, body] of [...blocks, ...signatures]) {
      const text = unescape(body);
      assert.equal((tokenize(text) as Run[]).map(([, t]) => t).join(''), text, `${page}: ${text.split('\n')[0]}`);
    }
  }
  const runs = (tokenize("// hi\nconst s = new Store(`${n} of ${fmt(t)}`, 'x', 3, true);") as Run[])
    .filter(([kind]) => kind);
  assert.deepEqual(runs, [
    ['comment', '// hi'], ['keyword', 'const'], ['keyword', 'new'], ['type', 'Store'], ['string', '`'],
    ['punctuation', '${'], ['punctuation', '}'], ['string', ' of '], ['punctuation', '${'], ['function', 'fmt'],
    ['punctuation', '}'], ['string', '`'], ['string', "'x'"], ['literal', '3'], ['literal', 'true'],
  ]);
});

test('a block that shows an example file shows all of it, as it is', () => {
  let shown = 0;
  for (const page of pages) {
    for (const block of codeBlocks(page)) {
      const source = block.attrs.match(/data-source="([^"]+)"/)?.[1];
      if (!source) continue;
      shown++;
      assert.equal(block.text, readFileSync(new URL(source, docs), 'utf8').trimEnd(), `${page}: ${source}`);
    }
  }
  assert.ok(shown >= 1, 'the guide shows the example client');
});

test('the example client runs against the example server: a first page, the count, Load more, a sort, a failure', { timeout: 10_000 }, async () => {
  const { createItemsServer } = await import(new URL('examples/server.js', docs).href);
  const { createItemsStore, countText } = await import(new URL('examples/client.js', docs).href);
  const server = createItemsServer({ latency: 1, countLatency: 20 });
  const { store, sortBy } = createItemsStore({ fetch: server.fetch });
  type Snap = { rows: Array<{ id: string; title: string }>; total?: unknown; state: { failure?: { scope: string; retry: () => void } }; paging: { kind: string; hasMore?: boolean } };
  const until = (ok: (s: Snap) => boolean) => new Promise<Snap>((resolve) => {
    const check = () => { const s = store.getSnapshot() as Snap; if (ok(s)) { off(); resolve(s); } };
    const off = store.subscribe(check);
    check();
  });

  store.start();
  let s = await until((x) => x.rows.length === 50);
  assert.equal(countText(s), '50 of 100+ items');
  s = await until((x) => x.total === 310);
  assert.equal(countText(s), '50 of 310 items');

  store.loadMore();
  s = await until((x) => x.rows.length === 100);
  assert.equal(s.rows[99].id, 'IT-100');

  sortBy('title', 'descending');
  s = await until((x) => x.rows.length === 50 && x.rows[0].id !== 'IT-1');
  const titles = s.rows.map((r) => r.title);
  assert.deepEqual(titles, [...titles].sort((a, b) => b.localeCompare(a)));

  // An error status is a failure, not rows: client.js checks `res.ok`.
  server.failNextRequest();
  store.loadMore();
  s = await until((x) => x.state.failure?.scope === 'more');
  assert.equal(s.rows.length, 50);
  s.state.failure!.retry();
  s = await until((x) => x.rows.length === 100 && !x.state.failure);
  store.stop();
});

test('the count names one item in the singular', async () => {
  const { countText } = await import(new URL('examples/client.js', docs).href);
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `IT-${i}` }));
  assert.equal(countText({ rows: rows(1), total: 1 }), '1 of 1 item');
  assert.equal(countText({ rows: rows(1) }), '1 item');
  assert.equal(countText({ rows: rows(0), total: 0 }), '0 of 0 items');
  assert.equal(countText({ rows: rows(1), total: 2 }), '1 of 2 items');
  assert.equal(countText({ rows: rows(1), total: { atLeast: 1 } }), '1 of 1+ items');
});

test('the example client archives a selection: ids as ids, and "select all" as the view and its exceptions', { timeout: 10_000 }, async () => {
  const { createItemsServer } = await import(new URL('examples/server.js', docs).href);
  const { createItemsStore, countText } = await import(new URL('examples/client.js', docs).href);
  const { setSelected, removeFromSelection, selectionCount } = await import('@fairchild/table-core');
  const server = createItemsServer({ latency: 1, countLatency: 5 });
  const { store, archive } = createItemsStore({ fetch: server.fetch });
  type Snap = { rows: Array<{ id: string }>; total?: number | { atLeast: number }; state: { fetching?: boolean } };
  const until = (ok: (s: Snap) => boolean) => new Promise<Snap>((resolve) => {
    const check = () => { const s = store.getSnapshot() as Snap; if (ok(s)) { off(); resolve(s); } };
    const off = store.subscribe(check);
    check();
  });
  const settled = (total: number) => until((x) => x.total === total && !x.state.fetching);
  store.start();
  await settled(310);

  let selection = setSelected({ kind: 'ids', ids: new Set() }, ['IT-1', 'IT-2'], true);
  let archived = await archive(selection);
  assert.deepEqual(archived, ['IT-1', 'IT-2']);
  selection = removeFromSelection(selection, archived);
  let s = await settled(308);
  assert.equal(s.rows[0].id, 'IT-3');
  assert.equal(selectionCount(selection, s.total, s.rows.length), 0);

  // Select all 308, untick one: the server archives the 307 others, loaded or not.
  selection = setSelected({ kind: 'all-matching', except: new Set() }, ['IT-3'], false);
  assert.equal(selectionCount(selection, s.total, s.rows.length), 307);
  archived = await archive(selection);
  assert.equal(archived.length, 307);
  selection = removeFromSelection(selection, archived);
  s = await settled(1);
  assert.deepEqual(s.rows.map((r) => r.id), ['IT-3']);
  assert.equal(countText(s), '1 of 1 item');
  assert.equal(selectionCount(selection, s.total, s.rows.length), 0);
  store.stop();
});

// The demo's DOM needs a browser, so this checks the rule demo.js applies and that render() applies it.
test('when a demo control hides or disables itself while focused, focus moves to the next control, never to <body>', async () => {
  const { focusTarget } = await import(new URL('assets/demo-state.js', docs).href);
  assert.equal(focusTarget({ from: 'paging', moreShown: true, retryShown: false }), 'more', 'Try again → Load more');
  assert.equal(focusTarget({ from: 'paging', moreShown: false, retryShown: true }), 'retry', 'Load more failed → Try again');
  assert.equal(focusTarget({ from: 'paging', moreShown: false, retryShown: false }), 'count', 'nothing left → the count');
  assert.equal(focusTarget({ from: 'selection', moreShown: true, retryShown: false }), 'select-all', 'Archive → Select all');
  const demo = readFileSync(new URL('assets/demo.js', docs), 'utf8');
  assert.match(demo, /focused\.disabled \|\| focused\.closest\('\[hidden\]'\)/);
  assert.match(demo, /focusTarget\(\{ from, moreShown: !more\.hidden, retryShown: !problem\.hidden \}\)/);
  assert.match(html('index.html'), /class="demo-count"[^>]*tabindex="-1"/, 'the count can take focus');
});

test('the demo table is aria-busy="true" while another view loads, and "false" once it settles', { timeout: 10_000 }, async () => {
  // The value, not just the attribute: aria-busy="" isn't busy to Chromium's accessibility tree.
  const { ariaBusy } = await import(new URL('assets/demo-state.js', docs).href);
  const { createItemsServer } = await import(new URL('examples/server.js', docs).href);
  const { createItemsStore } = await import(new URL('examples/client.js', docs).href);
  const server = createItemsServer({ latency: 5, countLatency: 5 });
  const { store, sortBy } = createItemsStore({ fetch: server.fetch });
  type Snap = { rows: unknown[]; state: { rows?: string; fetching?: boolean } };
  const until = (ok: (s: Snap) => boolean) => new Promise<Snap>((resolve) => {
    const check = () => { const s = store.getSnapshot() as Snap; if (ok(s)) { off(); resolve(s); } };
    const off = store.subscribe(check);
    check();
  });
  store.start();
  const first = await until((s) => s.rows.length === 50 && !s.state.fetching);
  assert.equal(ariaBusy(first.state), 'false');
  sortBy('title');
  const pending = store.getSnapshot() as Snap;
  assert.equal(pending.state.rows, 'previous');
  assert.equal(ariaBusy(pending.state), 'true');
  const settled = await until((s) => s.state.rows === 'current' && !s.state.fetching);
  assert.equal(ariaBusy(settled.state), 'false');
  store.stop();
  // The demo sets the attribute from it, with a value.
  const demo = readFileSync(new URL('assets/demo.js', docs), 'utf8');
  assert.match(demo, /setAttribute\('aria-busy', ariaBusy\(state\)\)/);
  assert.doesNotMatch(demo, /toggleAttribute\('aria-/);
});
