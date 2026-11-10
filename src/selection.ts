import type { Selection, Total } from './types.ts';

/** Nothing selected. */
export const NO_SELECTION: Selection = Object.freeze({ kind: 'ids', ids: new Set<string>() }) as Selection;

export function isSelected(selection: Selection, id: string): boolean {
  return selection.kind === 'ids' ? selection.ids.has(id) : !selection.except.has(id);
}

/** Tick or untick rows. In an all-matching selection, unticking adds to `except` and ticking takes out of it. */
export function setSelected(selection: Selection, ids: Iterable<string>, on: boolean): Selection {
  if (selection.kind === 'ids') {
    const next = new Set(selection.ids);
    for (const id of ids) if (on) next.add(id); else next.delete(id);
    return { kind: 'ids', ids: next };
  }
  const except = new Set(selection.except);
  for (const id of ids) if (on) except.delete(id); else except.add(id);
  return { kind: 'all-matching', except };
}

/**
 * The selection after rows were deleted on the server. A deleted row is no longer a member of anything: it leaves
 * an explicit selection, and it leaves an all-matching selection's `except` too. Adding it to `except` instead would
 * count it twice once the server's new total arrives (the total already excludes it).
 */
export function removeFromSelection(selection: Selection, deleted: Iterable<string>): Selection {
  const gone = new Set(deleted);
  if (selection.kind === 'ids') {
    if (![...gone].some((id) => selection.ids.has(id))) return selection;
    return { kind: 'ids', ids: new Set([...selection.ids].filter((id) => !gone.has(id))) };
  }
  if (![...gone].some((id) => selection.except.has(id))) return selection;
  return { kind: 'all-matching', except: new Set([...selection.except].filter((id) => !gone.has(id))) };
}

/**
 * How many rows are selected. An all-matching selection counts against the view's total (or, without one, the rows
 * shown); a lower bound stays a lower bound.
 */
export function selectionCount(selection: Selection, total: Total | undefined, shown: number): Total {
  if (selection.kind === 'ids') return selection.ids.size;
  const n = selection.except.size;
  if (total == null) return Math.max(0, shown - n);
  return typeof total === 'number' ? Math.max(0, total - n) : { atLeast: Math.max(0, total.atLeast - n) };
}
