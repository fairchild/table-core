import { test } from 'node:test';
import { expect } from './expect.ts';
import { isSelected, removeFromSelection, selectionCount, setSelected, type Selection } from '../src/index.ts';
// Internal to the package: the empty selection the tests start from.
import { NO_SELECTION } from '../src/selection.ts';

const ids = (...a: string[]): Selection => ({ kind: 'ids', ids: new Set(a) });
const all = (...except: string[]): Selection => ({ kind: 'all-matching', except: new Set(except) });

test('ticking and unticking: ids add and remove; all-matching keeps the exceptions', () => {
  expect(setSelected(NO_SELECTION, ['a', 'b'], true)).toEqual(ids('a', 'b'));
  expect(setSelected(ids('a', 'b'), ['a'], false)).toEqual(ids('b'));
  expect(setSelected(all(), ['a'], false)).toEqual(all('a'));
  expect(setSelected(all('a'), ['a'], true)).toEqual(all());
  expect(isSelected(all('a'), 'a')).toBe(false);
  expect(isSelected(all('a'), 'b')).toBe(true);
});

test('counts: all-matching counts against the total, a lower bound stays a lower bound', () => {
  expect(selectionCount(ids('a', 'b'), 310, 50)).toBe(2);
  expect(selectionCount(all('a'), 310, 50)).toBe(309);
  expect(selectionCount(all('a'), { atLeast: 100 }, 50)).toEqual({ atLeast: 99 });
  expect(selectionCount(all('a'), undefined, 50)).toBe(49);
});

test('a deleted row leaves an explicit selection, and the count drops by one', () => {
  const before = ids('a', 'b', 'c');
  const after = removeFromSelection(before, ['b']);
  expect(after).toEqual(ids('a', 'c'));
  expect(selectionCount(after, 309, 50)).toBe(2);
  expect(removeFromSelection(before, ['z'])).toBe(before); // nothing to remove: the same object
});

test('a deleted row leaves an all-matching selection without becoming an exception', () => {
  // The review's case: select all 310, archive one. The server's total becomes 309, and all 309 are still selected.
  const before = all();
  const after = removeFromSelection(before, ['b']);
  expect(after).toBe(before);
  expect(selectionCount(after, 309, 50)).toBe(309);
  // An unticked row that is then deleted stops being an exception: the new total no longer counts it either.
  const unticked = all('b', 'c');
  const gone = removeFromSelection(unticked, ['b']);
  expect(gone).toEqual(all('c'));
  expect(selectionCount(gone, 309, 50)).toBe(308);
});
