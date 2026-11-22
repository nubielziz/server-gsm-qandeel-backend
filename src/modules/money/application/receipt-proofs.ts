// One transfer receipt backs one live top-up payment (decision 049): the check both receipt routes run before they insert a payment.
import { AppError } from '../../../common/errors';
import type { DbExecutor } from '../../../infra/db';
import type { StoredFiles } from '../../platform';
import { liveReceiptPaymentExists, lockReceiptContent } from '../infra/payment.repository';

/**
 * The refusal of a receipt that already backs a payment: `422` on `fileId`, code `taken`.
 *
 * Why: decision 049: the receipt forms show a field error on the file, and `taken` is the code they already know.
 *
 * @returns the error to throw
 */
export function receiptTaken(): AppError {
  return new AppError('VALIDATION_FAILED', {
    errors: [
      {
        field: 'fileId',
        code: 'taken',
        message: 'This receipt already backs another payment. Upload the receipt of this transfer.',
      },
    ],
  });
}

/**
 * Refuses a receipt file whose bytes already back a pending or approved top-up payment.
 *
 * Why: decision 049: staff review a receipt, and one receipt can pay one top-up only, whoever uploaded it and under whichever file id;
 * every file keeps the SHA-256 of its bytes, so a copy uploaded again is found too. A rejected payment does not hold its receipt. The
 * content is locked before the copies are listed, so two uploads of the same bytes at once are judged one after the other (a copy stored
 * while the first one waits is listed by the second).
 *
 * Side effects: takes the content's advisory lock (`lockReceiptContent`) until the caller's transaction ends. Call it inside the
 * transaction that inserts the payment, after the invoice row lock and the ownership check.
 *
 * @param tx the transaction that inserts the payment
 * @param files the platform's file service
 * @param fileId the receipt the caller checked
 * @throws {AppError} `VALIDATION_FAILED` on `fileId` (`taken`)
 */
export async function assertReceiptUnused(tx: DbExecutor, files: StoredFiles, fileId: number): Promise<void> {
  const sha256 = await files.sha256Of(tx, fileId);
  if (sha256 === undefined) return; // the caller found the file a moment ago; its foreign key decides if it vanished
  await lockReceiptContent(tx, sha256);
  const copies = await files.idsWithSha256(tx, sha256);
  if (await liveReceiptPaymentExists(tx, copies)) throw receiptTaken();
}
