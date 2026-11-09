// The landing page's live demo: a plain <table> on the package's real dist (through the import map) and the
// example client and server the guide shows. No framework. Without JavaScript, or if the import fails, the
// static sample in the HTML stays.
import { isSelected, setSelected, removeFromSelection, selectionCount } from '@fairchild/table-core';
import { createItemsServer } from '../examples/server.js';
import { createItemsStore, countText } from '../examples/client.js';
import { ariaBusy, focusTarget } from './demo-state.js';

const root = document.getElementById('demo');
const $ = (sel) => root.querySelector(sel);
const server = createItemsServer();
const { store, sortBy, archive } = createItemsStore({ fetch: server.fetch });

const table = $('table');
const tbody = $('tbody');
const count = $('.demo-count');
const status = $('.demo-status');
const more = $('.demo-more');
const problem = $('.demo-problem');
const problemText = $('.demo-problem-text');
const log = $('.demo-log');
const snapshotOut = $('.demo-snapshot');
const selected = $('.demo-selected');
const selectAll = $('.demo-select-all');
const clear = $('.demo-clear');
const archiveButton = $('.demo-archive');
const sortButtons = [...root.querySelectorAll('th button[data-sort]')];
const fmt = (n) => n.toLocaleString('en-US');
const fmtTime = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const fmtTotal = (t) => (typeof t === 'number' ? fmt(t) : `${fmt(t.atLeast)}+`);

const NONE = { kind: 'ids', ids: new Set() };
let selection = NONE;
let shownRows = null;

function renderRows(rows) {
  tbody.replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    const pick = document.createElement('td');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = r.id;
    box.setAttribute('aria-label', `Select ${r.id}`);
    pick.append(box);
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = r.id;
    const title = document.createElement('td');
    title.textContent = r.title;
    const due = document.createElement('td');
    due.textContent = r.due;
    tr.append(pick, th, title, due);
    return tr;
  }));
}

function render() {
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const snap = store.getSnapshot();
  const { rows, state, paging, total } = snap;

  if (rows !== shownRows) {
    shownRows = rows;
    renderRows(rows);
  }
  for (const box of tbody.querySelectorAll('input')) box.checked = isSelected(selection, box.value);

  // Busy while the rows on screen aren't this view's; "Updating…" while more of them are on the way.
  table.setAttribute('aria-busy', ariaBusy(state));
  table.classList.toggle('is-previous', state.rows === 'previous');
  count.textContent = state.rows === 'none' ? 'Loading items…' : countText(snap);
  status.textContent = state.fetching && state.rows !== 'none' ? 'Updating…' : '';

  const n = selectionCount(selection, total, rows.length);
  selected.textContent = n === 0 ? 'None selected' : `${fmtTotal(n)} selected`;
  selectAll.textContent = total === undefined ? 'Select all' : `Select all ${fmtTotal(total)}`;
  archiveButton.disabled = n === 0;
  clear.disabled = selection === NONE;

  const failure = state.failure;
  problem.hidden = !failure;
  if (failure) {
    problemText.textContent = failure.scope === 'refresh'
      ? `Couldn’t refresh. Showing rows from ${fmtTime(state.since)}.`
      : failure.scope === 'more' ? 'The next page didn’t load.' : 'The items didn’t load.';
  }
  // The store keeps hasMore while the next page loads, and a second loadMore() meanwhile asks for nothing.
  more.hidden = !(paging.kind === 'load-more' && paging.hasMore && failure?.scope !== 'more');

  if (focused && (focused.disabled || focused.closest('[hidden]'))) {
    const from = focused.closest('.demo-selection') ? 'selection' : 'paging';
    const to = focusTarget({ from, moreShown: !more.hidden, retryShown: !problem.hidden });
    ({ more, retry: $('.demo-retry'), count, 'select-all': selectAll })[to].focus();
  }

  snapshotOut.textContent = JSON.stringify({
    rows: rows.length ? `${rows.length} rows: ${rows[0].id} … ${rows[rows.length - 1].id}` : '0 rows',
    total,
    paging,
    state: {
      ...state,
      since: state.since && fmtTime(state.since),
      failure: failure && { scope: failure.scope, message: failure.message },
    },
  }, null, 2);
}

function renderLog() {
  log.replaceChildren(...server.getLog().map((e) => {
    const li = document.createElement('li');
    li.dataset.status = String(e.status);
    const what = document.createElement('code');
    what.textContent = e.url;
    const outcome = e.status === 'pending' ? 'waiting…'
      : e.status === 'canceled' ? `canceled after ${fmt(e.ms)} ms` : `${e.status} in ${fmt(e.ms)} ms`;
    li.append(what, ` ${outcome}`);
    return li;
  }));
  $('.demo-slow').setAttribute('aria-pressed', String(server.slow));
}

function select(next) {
  selection = next;
  render();
}

function showSort(columnId, direction) {
  for (const button of sortButtons) {
    const th = button.closest('th');
    if (button.dataset.sort === columnId) th.setAttribute('aria-sort', direction);
    else th.removeAttribute('aria-sort');
  }
}

for (const button of sortButtons) {
  button.addEventListener('click', () => {
    const next = button.closest('th').getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
    showSort(button.dataset.sort, next);
    sortBy(button.dataset.sort, next);
  });
}
tbody.addEventListener('change', (e) => select(setSelected(selection, [e.target.value], e.target.checked)));
selectAll.addEventListener('click', () => select({ kind: 'all-matching', except: new Set() }));
clear.addEventListener('click', () => select(NONE));
archiveButton.addEventListener('click', async () => {
  const archived = await archive(selection).catch(() => []);
  if (archived.length) select(NONE);
});
more.addEventListener('click', () => store.loadMore());
$('.demo-retry').addEventListener('click', () => store.getSnapshot().state.failure?.retry());
$('.demo-slow').addEventListener('click', () => server.setSlow(!server.slow));
$('.demo-fail').addEventListener('click', () => server.failNextRequest());
$('.demo-add').addEventListener('click', () => { server.addRows(25); store.reload(); });
$('.demo-delete').addEventListener('click', () => {
  const first = store.getSnapshot().rows[0];
  if (!first) return;
  server.deleteRow(first.id);
  selection = removeFromSelection(selection, [first.id]);
  store.reload();
});
$('.demo-reset').addEventListener('click', () => {
  server.reset();
  server.setSlow(false);
  selection = NONE;
  showSort('id', 'ascending');
  sortBy('id', 'ascending');
  store.reload();
});

// One-click stories: each presses the demo's own buttons, so the table, the log and the snapshot show what happens.
const settled = () => new Promise((resolve) => {
  const check = () => {
    const { state } = store.getSnapshot();
    if (!state.fetching || state.failure) { off(); resolve(); }
  };
  const off = store.subscribe(check);
  check();
});
const stories = {
  'sort-twice': () => {
    $('th button[data-sort="title"]').click();
    $('th button[data-sort="due"]').click();
  },
  'fail-more': async () => {
    await settled();
    server.failNextRequest();
    more.click();
  },
  'fail-refresh': async () => {
    await settled();
    server.failNextRequest();
    store.reload();
  },
  'archive-all-but-one': async () => {
    await settled();
    selectAll.click();
    tbody.querySelector('input')?.click();
    archiveButton.click();
  },
};
for (const button of root.querySelectorAll('[data-story]')) {
  button.addEventListener('click', () => stories[button.dataset.story]());
}

store.subscribe(render);
server.subscribe(renderLog);
root.classList.add('is-live');
for (const el of root.querySelectorAll('[data-live-only]')) el.hidden = false;
for (const el of root.querySelectorAll('[data-static-only]')) el.hidden = true;
store.start();
render();
renderLog();
