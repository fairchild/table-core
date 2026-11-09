// A small expect() over node:assert, so the tests read the same as Lede's tests and need no test library.
import assert from 'node:assert/strict';

export function expect(actual: unknown) {
  const matchers = {
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
    toMatchObject: (expected: object) => assert.partialDeepStrictEqual(actual, expected),
    toHaveLength: (n: number) => assert.strictEqual((actual as { length: number }).length, n),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toBeInstanceOf: (type: new (...args: never[]) => unknown) => assert.ok(actual instanceof type, `expected an instance of ${type.name}`),
    toBeGreaterThan: (n: number) => assert.ok((actual as number) > n, `expected ${String(actual)} > ${n}`),
  };
  return {
    ...matchers,
    not: {
      toBe: (expected: unknown) => assert.notStrictEqual(actual, expected),
      toEqual: (expected: unknown) => assert.notDeepStrictEqual(actual, expected),
    },
  };
}
