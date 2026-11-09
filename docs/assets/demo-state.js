// What the demo table tells assistive tech, from the store's state. Separate from demo.js so test/docs.test.ts can
// check it without a browser.

/**
 * aria-busy for the table: "true" while the rows on screen aren't this view's and its rows are on the way (a new
 * sort), "false" otherwise. Always a value: an empty aria-busy="" isn't busy to Chromium's accessibility tree.
 */
export function ariaBusy(state) {
  return state.rows !== 'current' && state.fetching ? 'true' : 'false';
}

/**
 * Where focus goes when the control that has it hides or disables itself, so it never falls to <body>. After Try
 * again or Load more: Load more if it shows, then Try again, then the count. After Clear or Archive: Select all.
 */
export function focusTarget({ from, moreShown, retryShown }) {
  if (from === 'selection') return 'select-all';
  return moreShown ? 'more' : retryShown ? 'retry' : 'count';
}
