// Test helper: the reason a promise rejected with. Bun's types declare `expect(promise).rejects.*` as synchronous, so
// `await expect(...).rejects` trips @typescript-eslint/await-thenable; this keeps the await explicit and typed.

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
