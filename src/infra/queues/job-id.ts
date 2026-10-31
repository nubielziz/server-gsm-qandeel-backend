// Deterministic BullMQ job ids. BullMQ refuses a custom id that contains ":" or is only digits, so ids are
// "<kind>-<id>": BullMQ refuses ":" in custom ids (decision 020, docs/queues.md).

const MAX_JOB_ID_LENGTH = 200;
const PART = /^[A-Za-z0-9._-]+$/;

/**
 * Builds the deterministic id of a job from a kind and the ids it is about, for example `outbox-1042` or
 * `order-poll-77`.
 *
 * Why: a job id that is a pure function of the business occurrence is what makes enqueueing idempotent: adding the same
 * id twice creates one job while the first is retained (decision 020). BullMQ rejects ids with ":" and ids that are only
 * digits, so the parts are joined with "-" and the first part must start with a letter.
 *
 * @param parts the kind (`outbox`, `order-poll`, `manual`) followed by the ids; letters, digits, ".", "_" and "-" only
 * @returns the job id
 * @throws {RangeError} when a part is empty or has other characters, when the first part does not start with a letter,
 *   or when the id is longer than 200 characters
 */
export function queueJobId(...parts: ReadonlyArray<string | number>): string {
  if (parts.length < 2) throw new RangeError('A job id needs a kind and at least one id, for example ("outbox", 12).');
  const texts = parts.map(String);
  for (const text of texts) {
    if (!PART.test(text)) {
      throw new RangeError(
        `A job id part may only have letters, digits, ".", "_" and "-", got ${JSON.stringify(text)}.`,
      );
    }
  }
  if (!/^[A-Za-z]/.test(texts[0] ?? '')) {
    throw new RangeError(
      `A job id must start with a letter (BullMQ refuses numeric ids), got ${JSON.stringify(texts[0])}.`,
    );
  }
  const id = texts.join('-');
  if (id.length > MAX_JOB_ID_LENGTH) throw new RangeError(`A job id may have at most ${MAX_JOB_ID_LENGTH} characters.`);
  return id;
}
