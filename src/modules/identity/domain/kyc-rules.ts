// Rules of the identity verification (KYC) requests (map routes /admin/kyc-submissions*, /client/kyc, stage 8, MISMATCHES B161):
// the limits on what a merchant submits and on a staff decision. Pure.
import type { FieldError } from '../../../common/errors';

/** The most documents one request may carry (B161). */
export const MAX_KYC_FILES = 5;
/** The longest note a merchant adds to a request (B161). */
export const MAX_SUBMIT_NOTE = 500;
/** The longest note of a staff decision (identity.md: trimmed, max 300). */
export const MAX_DECISION_NOTE = 300;

/**
 * Checks the list of document ids a merchant submits.
 *
 * Why: B161: one to five distinct files; a duplicate or a wrong count is a `422` on `fileIds`. The existence, owner and type of
 * each file are checked by the service, which reads the files.
 *
 * @param ids the ids as sent
 * @returns the problems on `fileIds`, or an empty list
 */
export function checkFileIds(ids: readonly number[]): FieldError[] {
  if (ids.length === 0) return [{ field: 'fileIds', code: 'required', message: 'Attach at least one document.' }];
  if (ids.length > MAX_KYC_FILES) {
    return [{ field: 'fileIds', code: 'max', message: `Attach at most ${MAX_KYC_FILES} documents.` }];
  }
  if (new Set(ids).size !== ids.length) {
    return [{ field: 'fileIds', code: 'duplicate', message: 'Each document can be attached once.' }];
  }
  return [];
}

/**
 * Checks the note of a staff decision.
 *
 * Why: identity.md: a rejection needs a note (the merchant is shown the reason); an approval may carry one; both are at most 300
 * characters.
 *
 * @param decision `approve` or `reject`
 * @param note the note as sent, already trimmed
 * @returns the problem on `note`, or `undefined`
 */
export function checkDecisionNote(decision: 'approve' | 'reject', note: string): FieldError | undefined {
  if (decision === 'reject' && note === '') {
    return { field: 'note', code: 'required', message: 'Say why the request is rejected.' };
  }
  if (note.length > MAX_DECISION_NOTE) {
    return { field: 'note', code: 'length', message: `Keep the note to ${MAX_DECISION_NOTE} characters or fewer.` };
  }
  return undefined;
}
