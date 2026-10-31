// Test helpers: the reason a promise rejected with, and an assertion on it. Bun's types declare
// `expect(promise).rejects.*` as synchronous, so `await expect(...).rejects` trips @typescript-eslint/await-thenable;
// these keep the await explicit and typed.
import { expect } from 'bun:test';

/**
 * Waits for a promise that must reject and returns the rejection reason.
 *
 * Why: tests of failure paths (rollbacks, unreachable databases) need the error itself; a promise that resolves fails
 * the test instead of passing silently.
 *
 * @param promise the promise expected to reject
 * @returns the rejection reason
 * @throws {Error} when the promise resolves instead
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

/** An error class, as accepted by `toBeInstanceOf`. */
type ErrorClass = abstract new (...args: never[]) => unknown;

/**
 * Asserts that a promise rejects, optionally with an error of a class or a message.
 *
 * Why: the typed replacement for `await expect(promise).rejects.toThrow(...)` (see the file comment).
 *
 * @param promise the promise expected to reject
 * @param expected an error class (checked with instanceof), a regular expression or text the message must match; omit to
 *   accept any rejection
 * @param label shown when the assertion fails
 * @returns the rejection reason, for further assertions
 * @throws {Error} when the promise resolves, or rejects with something else than expected
 */
export async function expectRejection(
  promise: Promise<unknown>,
  expected?: ErrorClass | RegExp | string,
  label?: string,
): Promise<unknown> {
  const reason = await rejectionOf(promise);
  if (typeof expected === 'function') {
    expect(reason, label).toBeInstanceOf(expected);
  } else if (expected !== undefined) {
    expect(reason instanceof Error ? reason.message : String(reason), label).toMatch(expected);
  }
  return reason;
}
