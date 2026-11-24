// The life of a data-subject request (feature 18, RESOLUTIONS b2c-13, ANSWERS customers Q5 and Q12, decision 064): the moves staff may
// make, the legal deadline, the note rule and who may ask for an erasure. Pure, no database.
import type { RankKind } from '../../identity';
import type { DataRequestKind, DataRequestStatus } from '../db/schema';

/** How long the shop has to answer a request: 30 days from the day it was made (GDPR Article 12(3)). */
export const DATA_REQUEST_DEADLINE_DAYS = 30;

/** The longest note staff may write on a request. */
export const MAX_REQUEST_NOTE_LENGTH = 300;

/** The statuses a request can be moved to by staff. */
export const MOVE_TARGETS = ['in_progress', 'completed', 'rejected'] as const;

/** One value of {@link MOVE_TARGETS}. */
export type MoveTarget = (typeof MOVE_TARGETS)[number];

/** The statuses that end a request: nothing moves it any more. */
export const CLOSED_STATUSES: readonly DataRequestStatus[] = ['completed', 'rejected'];

/** The statuses of a request that still waits for an answer. */
export const PENDING_STATUSES: readonly DataRequestStatus[] = ['open', 'in_progress'];

/**
 * The date a request must be answered by.
 *
 * Why: the table keeps the legal deadline (`due_at`) from the day of the request.
 *
 * @param requestedAt when the account holder asked
 * @returns 30 days later
 */
export function dueDateOf(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + DATA_REQUEST_DEADLINE_DAYS * 86_400_000);
}

/** What the move of a request needs to know. */
export interface MoveContext {
  readonly kind: DataRequestKind;
  readonly from: DataRequestStatus;
  readonly to: MoveTarget;
  /** The note as sent (may be blank). */
  readonly note: string | undefined;
  /** Whether the account of an erasure request is already anonymized. */
  readonly accountAnonymized: boolean;
}

/** Why a move was refused. */
export type MoveRefusal =
  | { readonly code: 'REQUEST_CLOSED' }
  | { readonly code: 'ERASURE_NOT_DONE' }
  | { readonly code: 'VALIDATION_FAILED'; readonly field: 'note' | 'status'; readonly message: string };

/**
 * Judges a move of a request.
 *
 * Why: ANSWERS customers Q5, Q12 and RESOLUTIONS b2c-13: open goes to in progress, completed or rejected; in progress goes to
 * completed or rejected; a closed request answers `409 REQUEST_CLOSED`; a rejection needs a non-blank note of at most 300
 * characters; an erasure request cannot be completed by hand until the account is anonymized (`409 ERASURE_NOT_DONE`: the
 * anonymization closes it); a request already in progress cannot go back to in progress.
 *
 * @param move the request and the target
 * @returns `undefined` when the move is allowed, else the refusal
 */
export function refuseMove(move: MoveContext): MoveRefusal | undefined {
  if (CLOSED_STATUSES.includes(move.from)) return { code: 'REQUEST_CLOSED' };
  const note = move.note?.trim() ?? '';
  if (note.length > MAX_REQUEST_NOTE_LENGTH) {
    return { code: 'VALIDATION_FAILED', field: 'note', message: `Use at most ${MAX_REQUEST_NOTE_LENGTH} characters.` };
  }
  if (move.to === 'rejected' && note === '') {
    return { code: 'VALIDATION_FAILED', field: 'note', message: 'Say why the request is rejected.' };
  }
  if (move.to === 'in_progress' && move.from === 'in_progress') {
    return { code: 'VALIDATION_FAILED', field: 'status', message: 'This request is already in progress.' };
  }
  if (move.to === 'completed' && move.kind === 'erasure' && !move.accountAnonymized)
    return { code: 'ERASURE_NOT_DONE' };
  return undefined;
}

/**
 * What a signed-in account asking for an erasure must be told when its rank is a merchant rank.
 *
 * Why: decision 064: a copy of the data is every account's right, but erasure (anonymizing) is only done for the retail rank: a
 * merchant account holds a wallet, a hold, API keys and a statement that anonymizing would have to destroy. The account is first moved
 * to the retail rank by staff, and then it can ask. The sentence is the one the shop shows as it is.
 */
export const MERCHANT_ERASURE_MESSAGE =
  'This account has a merchant rank. Ask us to move it to the retail rank first; then you can ask for erasure.';

/**
 * Judges an account's own request.
 *
 * Why: decision 064: export for every rank, erasure for the retail rank only; a refused request stores nothing.
 *
 * @param kind what the account asks for
 * @param rankKind the kind of the account's rank, read under the account's row lock
 * @returns `undefined` when the request may be recorded, else the sentence of the `409 CONFLICT` answer
 */
export function refuseOwnRequest(kind: DataRequestKind, rankKind: RankKind): string | undefined {
  return kind === 'erasure' && rankKind === 'merchant' ? MERCHANT_ERASURE_MESSAGE : undefined;
}
