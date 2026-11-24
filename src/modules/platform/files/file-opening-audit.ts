// The audit rows of a staff member opening a stored file of an audited kind (platform module, decision 047): one rule for every route that
// opens files for staff (GET /admin/files/:id and the file route of a support ticket).
import type { DbService } from '../../../infra/db';
import type { AuditService } from '../audit/audit.service';
import { fileReferencesOf } from '../infra/file.repository';
import { type FileReferences, auditedKindsOf, fileKindsOf } from './file-kinds';

/**
 * Writes the audit rows for a staff member who opens a file, when the file is an identity document or a payment proof.
 *
 * Why: decision 047: who opened which identity document or payment proof is in the audit log of the account or the payment, whichever
 * page the staff member opened the file from. The kinds come from {@link auditedKindsOf}, so every route applies the same rule. The rows are
 * written in a short transaction of their own, before the caller makes the link: no row, no link. Decision 061: the documents stored
 * before the document check was retired stay readable and stay audited; nothing creates a new one.
 *
 * Side effects: one `audit_logs` row per audited kind the file has (`account` for an identity document, `payment` for a payment proof);
 * none for any other file.
 *
 * @param db the database
 * @param audit the audit writer
 * @param fileId the file being opened
 * @param refs what uses the file, when the caller has read it already (else it is read here)
 * @returns true when a row was written
 */
export async function auditStaffFileOpening(
  db: DbService,
  audit: AuditService,
  fileId: number,
  refs?: FileReferences,
): Promise<boolean> {
  const found = refs ?? (await fileReferencesOf(db.db, fileId));
  const audited = auditedKindsOf(fileKindsOf(found));
  if (audited.length === 0) return false;
  await db.runInTransaction(async ({ tx }) => {
    for (const kind of audited) {
      if (kind === 'identity_document' && found.identityDocument !== undefined) {
        await audit.record(tx, {
          action: 'opened an identity document of',
          // Decision 064: one word for every account (merchants kept their numbers, so the stored client id is the account id).
          entityType: 'account',
          entityId: found.identityDocument.clientId,
          entityLabel: found.identityDocument.clientName,
          // The key keeps the name of the old rows, so the audit log reads the same before and after decision 061.
          after: { fileId, kycSubmissionId: found.identityDocument.submissionId },
        });
      } else if (kind === 'payment_proof' && found.paymentId !== undefined) {
        await audit.record(tx, {
          action: 'opened the payment proof of',
          entityType: 'payment',
          entityId: found.paymentId,
          // The money module's label of a payment (paymentRef).
          entityLabel: `PAY-${found.paymentId}`,
          after: { fileId },
        });
      }
    }
  });
  return true;
}
