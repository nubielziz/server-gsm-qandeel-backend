// FileAccessService: the file download use cases (map domain G, stage 5): a short-lived presigned link to a stored file, for staff
// (by the kinds of record that use it, decision 047) and for a merchant (its own files only). The routes redirect to the link; the API never proxies the bytes.
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { DEFAULT_PRESIGN_SECONDS, StorageService } from '../../../infra/storage';
import { AuditService } from '../audit/audit.service';
import { fileKindsOf, permissionsForFile } from '../files/file-kinds';
import { auditStaffFileOpening } from '../files/file-opening-audit';
import { fileReferencesOf, findFile, isUnreferencedClientUpload, ownsOrderFile } from '../infra/file.repository';
import { identityApi } from '../notifications/identity-api';

/** How long a download link lives: 5 minutes (MISMATCHES B154). */
export const FILE_LINK_SECONDS = DEFAULT_PRESIGN_SECONDS;

/**
 * The staff member who opens a file: the id for the log and the audit row, the permissions of the role.
 *
 * Why: decision 047: the download needs the read permission of every kind of record that uses the file, so the service needs more than the id.
 */
export interface StaffFileCaller {
  readonly staffId: number;
  readonly permissions: readonly string[];
}

/**
 * Makes download links.
 *
 * Why: B154 and contract GET /admin/files/:id: files hold personal data (KYC documents, result files), so the API checks who may read
 * one and hands out a link that expires after 5 minutes, with the stored name as the download name. A merchant may read a file only
 * if it is its own upload (`owner_type client`, `owner_id` the merchant) or the input or result file of its own order; anything else,
 * an unknown id included, is `404`, never `403`, so ids cannot be probed. A REST v1 key reaches less than the portal session: only the files
 * of the merchant's own orders and its uploads no record uses yet (`linkForKey`). The access is logged at info without the file name.
 *
 * Decision 047: a staff member needs `files:read` and also the read permission of every kind of record that uses the file (`kyc:read` for
 * an identity document, `payments:read` for a payment receipt, `disputes:read`, `orders:read`, `invoices:read`, `support:read`,
 * `customers:privacy` for a data export). An upload no record uses yet needs `kyc:read` when a merchant owns it and `customers:read` when a
 * customer does; the pictures of listings and payment methods (public anyway) need only `files:read`. Every download of an identity document or
 * a payment receipt writes an audit row under the merchant or the payment, in a short transaction before the link is made.
 *
 * Side effects: `audit_logs` rows for the two audited kinds; one log line; the signature is computed locally (the object is not checked).
 *
 * @see docs/contract/MISMATCHES.md (B154)
 */
@Injectable()
export class FileAccessService {
  private readonly logger = new Logger(FileAccessService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The link for a staff member who holds `files:read` (the route's guard) and the read permission of every kind of record that uses the file.
   *
   * @param caller the staff member: id (for the log and the audit row) and the permissions of the role
   * @param fileId the file id
   * @returns the presigned URL
   * @throws {AppError} `NOT_FOUND` (404) for an unknown id; `FORBIDDEN` (403) naming the first permission the caller lacks
   */
  async linkForStaff(caller: StaffFileCaller, fileId: number): Promise<string> {
    const file = await findFile(this.db.db, fileId);
    if (!file) throw new AppError('NOT_FOUND', { detail: 'No file with this id.' });
    const refs = await fileReferencesOf(this.db.db, fileId);
    const kinds = fileKindsOf(refs);
    const needed = permissionsForFile(kinds);
    // An upload no record uses yet still belongs to a merchant (a KYC document not submitted yet) or a customer (a receipt not attached).
    if (kinds.length === 0 && file.ownerType === 'client') needed.push('kyc:read');
    if (kinds.length === 0 && file.ownerType === 'customer') needed.push('customers:read');
    const identity = await identityApi();
    // Decision 047: each kind of record that uses the file adds its own read permission to files:read.
    for (const permission of needed) {
      if (!identity.grants(caller.permissions, permission)) throw identity.missingPermission(permission);
    }
    // Decision 047: who opened which identity document or payment proof is in the audit log (no row, no link); the ticket route writes the same row.
    await auditStaffFileOpening(this.db, this.audit, fileId, refs);
    this.logger.log(
      `file ${fileId}${kinds.length === 0 ? '' : ` (${kinds.join(', ')})`} opened by staff ${caller.staffId}`,
    );
    return this.link(file);
  }

  /**
   * The link for a merchant, who may read only its own files.
   *
   * @param clientId the signed-in merchant
   * @param fileId the file id
   * @returns the presigned URL
   * @throws {AppError} `NOT_FOUND` (404) for an unknown file or one that is not the merchant's
   */
  async linkForMerchant(clientId: number, fileId: number): Promise<string> {
    const file = await findFile(this.db.db, fileId);
    const own =
      file !== undefined &&
      ((file.ownerType === 'client' && file.ownerId === clientId) ||
        (await ownsOrderFile(this.db.db, clientId, fileId)));
    if (!file || !own) throw new AppError('NOT_FOUND', { detail: 'No file with this id.' });
    this.logger.log(`file ${fileId} opened by merchant ${clientId}`);
    return this.link(file);
  }

  /**
   * The link for the merchant behind an API key, who may read only the files of its orders and its uploads no record uses yet.
   *
   * Why: a key is shared with outside tools under a narrow scope, so `orders:read` must not reach the merchant's other documents (an identity
   * document of a KYC submission, a payment receipt, a ticket attachment, the evidence of a dispute, an invoice PDF, a data export). A file
   * that a record of those kinds uses stays that record's document, whether or not an order refers to it too, so that rule is applied first.
   * Only then: the file is the input or result file of one of the merchant's own orders, or an upload of the merchant that no record refers
   * to. The merchant portal keeps the wider {@link linkForMerchant}: its session is the merchant itself.
   *
   * @param clientId the merchant behind the key
   * @param fileId the file id
   * @returns the presigned URL
   * @throws {AppError} `NOT_FOUND` (404) for an unknown file, another merchant's file, or a document a record other than an order uses
   * @see GET /v1/files/:id
   */
  async linkForKey(clientId: number, fileId: number): Promise<string> {
    const file = await findFile(this.db.db, fileId);
    if (!file) throw new AppError('NOT_FOUND', { detail: 'No file with this id.' });
    const refs = await fileReferencesOf(this.db.db, fileId);
    // Every kind of record but an order makes the file a document of that record (a kind added later is refused by default).
    const usedAsDocument = fileKindsOf(refs).some((kind) => kind !== 'order_file');
    // An order refers to the file: it must be one of the merchant's own orders. Otherwise nothing refers to it: it must be the merchant's upload.
    const reachable =
      !usedAsDocument &&
      (refs.orderFile
        ? await ownsOrderFile(this.db.db, clientId, fileId)
        : await isUnreferencedClientUpload(this.db.db, clientId, fileId));
    if (!reachable) throw new AppError('NOT_FOUND', { detail: 'No file with this id.' });
    this.logger.log(`file ${fileId} opened by the key of merchant ${clientId}`);
    return this.link(file);
  }

  private link(file: { key: string; filename: string }): Promise<string> {
    return this.storage.presignGet(file.key, { expiresInSeconds: FILE_LINK_SECONDS, filename: file.filename });
  }
}
