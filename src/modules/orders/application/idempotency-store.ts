// IdempotencyStore: the replay logic of REST v1's `Idempotency-Key` (ALIGNMENT § 7, decision 026) around feature 5's placement. It opens
// nothing itself: the caller's transaction places the orders and this stores the answer in the same commit.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { type JsonObject } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { type Transaction, isUniqueViolation } from '../../../infra/db';
import { TokenService } from '../../../infra/crypto';
import type { IdempotencyScope } from '../db/schema';
import { idempotencyCutoff } from '../domain/idempotency-window';
import {
  findIdempotencyRecord,
  forgetIdempotencyKey,
  insertIdempotencyRecord,
  tryLockIdempotencyKey,
} from '../infra/idempotency.repository';

/** The answer of a placement: the status and the body to send, now or on a replay. */
export interface StoredAnswer {
  readonly status: number;
  readonly body: JsonObject;
}

/** What {@link IdempotencyStore.run} says back. */
export interface IdempotentResult extends StoredAnswer {
  /** True when the answer was stored by an earlier request with the same key and body: nothing was placed this time. */
  readonly replayed: boolean;
}

/** A JSON value written with its object keys in order, so two spellings of one body hash alike. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Makes a placement happen once per `Idempotency-Key`.
 *
 * Why: brief 7a, decision 026: a merchant's integration retries a request whose answer it never saw; the retry must neither place a
 * second order nor spend the wallet twice. Inside the placement's own transaction the key is locked (without waiting), the stored answer
 * is read, and when there is none the placement runs and its answer is stored before the commit, so the orders and the answer exist
 * together or not at all (nothing is stored for a refusal: the key may be tried again). The same key with the same body replays the
 * stored status and body; with another body or on the other route it is `409 IDEMPOTENCY_KEY_REUSED`; while another request with the key
 * still runs it is `409 IDEMPOTENCY_IN_PROGRESS`. Keys are per merchant and remembered for exactly 7 days (`IDEMPOTENCY_WINDOW_DAYS`, B166):
 * the row's `created_at` is the clock's time, and a stored answer older than the window (the same strict `<` as the job) is forgotten here,
 * under the lock, before anything else: its row is deleted, `orders.idempotency_key` is cleared and the request runs as a first one. The
 * daily job `idempotency_purge` only cleans the keys nobody sends again.
 *
 * Side effects: one `idempotency_keys` row in the caller's transaction on the first answer; an advisory transaction lock; on an expired key
 * its row is deleted and the merchant's `orders.idempotency_key` for it is cleared.
 *
 * @see docs/contract/ALIGNMENT.md (§ 7)
 */
@Injectable()
export class IdempotencyStore {
  constructor(
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Hashes what a key stands for.
   *
   * @param scope the route kind (`order`, `bulk`)
   * @param body the validated request body
   * @returns a keyed hash, equal for two spellings of the same body
   */
  hashOf(scope: IdempotencyScope, body: unknown): string {
    return this.tokens.hash(`idempotency:${scope}:${canonical(body)}`);
  }

  /**
   * Runs a placement under a key, or replays what the key stored.
   *
   * @param tx the transaction the placement runs in
   * @param request the merchant, the key, the scope and the hash of the body
   * @param work places the orders and returns the answer to send; not called on a replay
   * @returns the answer and whether it was replayed
   * @throws {AppError} `IDEMPOTENCY_IN_PROGRESS` (409, with `Retry-After`), `IDEMPOTENCY_KEY_REUSED` (409), and whatever `work` throws
   */
  async run(
    tx: Transaction,
    request: { clientId: number; key: string; scope: IdempotencyScope; requestHash: string },
    work: () => Promise<StoredAnswer>,
  ): Promise<IdempotentResult> {
    if (!(await tryLockIdempotencyKey(tx, request.clientId, request.key))) throw inProgress();
    let stored = await findIdempotencyRecord(tx, request.clientId, request.key);
    if (stored && stored.createdAt < idempotencyCutoff(this.clock.nowMs())) {
      // Past the window: the key is free again, whatever the new request is (same body, another body or the other route).
      await forgetIdempotencyKey(tx, request.clientId, request.key);
      stored = undefined;
    }
    if (stored) {
      if (stored.scope !== request.scope || stored.requestHash !== request.requestHash) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', {
          detail: 'This Idempotency-Key was already used for a different request. Use a new key for a new request.',
        });
      }
      return { status: stored.status, body: stored.response as JsonObject, replayed: true };
    }
    const answer = await work();
    try {
      await insertIdempotencyRecord(tx, {
        clientId: request.clientId,
        key: request.key,
        scope: request.scope,
        requestHash: request.requestHash,
        status: answer.status,
        response: answer.body,
        createdAt: this.clock.now(),
      });
    } catch (error) {
      // The lock makes this impossible; if it ever happens another request stored the key first.
      if (isUniqueViolation(error, 'idempotency_keys_client_key_uq')) throw inProgress();
      throw error;
    }
    return { ...answer, replayed: false };
  }
}

function inProgress(): AppError {
  return new AppError('IDEMPOTENCY_IN_PROGRESS', {
    detail: 'A request with this Idempotency-Key is still being processed. Wait a moment and send it again.',
    retryAfterSeconds: 1,
  });
}
