// UploadJanitor: the daily deletion of stored files that nothing has used for 7 days (decision 053).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService, isForeignKeyViolation } from '../../../infra/db';
import { staleUnreferencedFileIds } from '../infra/file.repository';
import { StoredFiles } from './stored-files';

/** A file nothing references is deleted this many days after it was stored (decision 053). */
export const UPLOAD_JANITOR_AGE_DAYS = 7;
/** Candidates read per batch. */
export const UPLOAD_JANITOR_BATCH = 500;
/** Batches per run: at most 20 000 files; a larger backlog continues the next night. */
export const UPLOAD_JANITOR_MAX_BATCHES = 40;
const DAY_MS = 24 * 60 * 60_000;

/** What one run did. */
export interface UploadJanitorResult {
  /** File rows deleted (their objects go after each commit). */
  readonly deleted: number;
  /** Candidates that were kept: something started to use them meanwhile. */
  readonly kept: number;
}

/**
 * Deletes the stored files that nothing references and that are more than 7 days old.
 *
 * Why: decision 053. An upload nobody attaches (an abandoned receipt, a picture of an order that was refused, a generated document that lost its
 * reference) stayed for ever, and quotas count what is held. Every area counts: uploads, generated documents and old pictures. "Nothing
 * references it" is one list (`unreferenced` in the file repository: three array columns and every foreign key), and each delete is one
 * statement that repeats the whole test for that row, so only an attach that is not committed yet can race it; a foreign-key violation on a row
 * (something started to use it meanwhile) keeps that row and the run goes on. The object is deleted after the row's commit.
 *
 * Idempotent: a deleted row cannot be deleted twice, so a parallel run finds fewer rows.
 *
 * Side effects: deletes `files` rows (one statement each) and, after each commit, their objects in the storage bucket.
 */
@Injectable()
export class UploadJanitor {
  constructor(
    private readonly db: DbService,
    private readonly files: StoredFiles,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs the clean-up once.
   *
   * @returns how many rows were deleted and how many candidates were kept
   * @throws any database error other than a foreign-key violation (the job fails and the queue retries)
   */
  async run(): Promise<UploadJanitorResult> {
    const before = new Date(this.clock.nowMs() - UPLOAD_JANITOR_AGE_DAYS * DAY_MS);
    let afterId = 0;
    let deleted = 0;
    let kept = 0;
    for (let batch = 0; batch < UPLOAD_JANITOR_MAX_BATCHES; batch += 1) {
      const ids = await staleUnreferencedFileIds(this.db.db, before, afterId, UPLOAD_JANITOR_BATCH);
      if (ids.length === 0) break;
      afterId = ids[ids.length - 1] ?? afterId;
      for (const id of ids) {
        try {
          const removed = await this.db.runInTransaction(({ tx }) => this.files.remove(tx, [id]));
          if (removed.length > 0) deleted += 1;
          else kept += 1;
        } catch (error) {
          if (!isForeignKeyViolation(error)) throw error;
          kept += 1;
        }
      }
      if (ids.length < UPLOAD_JANITOR_BATCH) break;
    }
    return { deleted, kept };
  }
}
