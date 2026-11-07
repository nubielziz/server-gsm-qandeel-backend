// FileAccessService: the file download use cases (map domain G, stage 5): a short-lived presigned link to a stored file, for staff
// (any file) and for a merchant (its own files only). The routes redirect to the link; the API never proxies the bytes.
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { DEFAULT_PRESIGN_SECONDS, StorageService } from '../../../infra/storage';
import { findFile, ownsOrderFile } from '../infra/file.repository';

/** How long a download link lives: 5 minutes (MISMATCHES B154). */
export const FILE_LINK_SECONDS = DEFAULT_PRESIGN_SECONDS;

/**
 * Makes download links.
 *
 * Why: B154 and contract GET /admin/files/:id: files hold personal data (KYC documents, result files), so the API checks who may read
 * one and hands out a link that expires after 5 minutes, with the stored name as the download name. A merchant may read a file only
 * if it is its own upload (`owner_type client`, `owner_id` the merchant) or the input or result file of its own order; anything else,
 * an unknown id included, is `404`, never `403`, so ids cannot be probed. The access is logged at info without the file name.
 *
 * Side effects: none on data; one log line; the signature is computed locally (the object is not checked).
 *
 * @see docs/contract/MISMATCHES.md (B154)
 */
@Injectable()
export class FileAccessService {
  private readonly logger = new Logger(FileAccessService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  /**
   * The link for a staff member, who may read any file.
   *
   * @param staffId the staff member (for the log)
   * @param fileId the file id
   * @returns the presigned URL
   * @throws {AppError} `NOT_FOUND` (404) for an unknown id
   */
  async linkForStaff(staffId: number, fileId: number): Promise<string> {
    const file = await findFile(this.db.db, fileId);
    if (!file) throw new AppError('NOT_FOUND', { detail: 'No file with this id.' });
    this.logger.log(`file ${fileId} opened by staff ${staffId}`);
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

  private link(file: { key: string; filename: string }): Promise<string> {
    return this.storage.presignGet(file.key, { expiresInSeconds: FILE_LINK_SECONDS, filename: file.filename });
  }
}
