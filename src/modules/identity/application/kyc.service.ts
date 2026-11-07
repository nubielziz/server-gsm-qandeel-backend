// KycService: the verification (KYC) use cases of staff (map routes /admin/kyc-submissions*) and of the merchant portal (/client/kyc,
// MISMATCHES B161). The documents are files the merchant uploaded; the decision sets the merchant's `kyc_status`.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import { AuditService, PROOF_MIME_TYPES, StoredFiles } from '../../platform';
import type { KycSubmission } from '../db/schema';
import { MAX_SUBMIT_NOTE, checkDecisionNote, checkFileIds } from '../domain/kyc-rules';
import {
  type KycSortField,
  findKyc,
  insertKyc,
  latestKycOf,
  listKycRows,
  clientKycStatus,
  loadKycParties,
  lockClient,
  setClientKycStatus,
  updateKyc,
} from '../infra/kyc.repository';

/** A verification request on the wire for staff. */
export interface WireKycSubmission {
  readonly id: number;
  readonly clientId: number;
  readonly status: KycSubmission['status'];
  readonly fileIds: number[];
  readonly files: Array<{ id: number; filename: string; mime: string; size: number }>;
  readonly reviewedAt: string | null;
  readonly note: string;
  readonly createdAt: string;
  readonly client: {
    id: number;
    name: string;
    email: string;
    country: string;
    status: 'active' | 'pending' | 'suspended';
  };
  readonly reviewedBy: { id: number; name: string } | null;
}

/** The merchant's view of its verification. */
export interface WireMyKyc {
  readonly status: 'none' | 'pending' | 'approved' | 'rejected';
  readonly submission: {
    readonly id: number;
    readonly status: KycSubmission['status'];
    readonly note: string | null;
    readonly documents: Array<{ fileId: number; filename: string; mime: string; size: number }>;
    readonly submittedAt: string;
    readonly reviewedAt: string | null;
  } | null;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No verification request has this id.' });

/**
 * Verification requests for staff and for the merchant.
 *
 * Why: B161 and ANSWERS merchants Q9: a merchant uploads documents (files it owns) and submits them; one request is under review
 * at a time (a partial unique index also guarantees it); staff approve or reject, which sets the request and `clients.kyc_status`
 * to the same word and never changes `clients.status`; the rejection note is shown to the merchant. Merchant submissions write no
 * audit row (B121); staff decisions are audited.
 *
 * Side effects: `submit` inserts a `kyc_submissions` row and sets `clients.kyc_status` to pending; `decide` updates both and
 * writes an audit row.
 *
 * @see docs/contract/endpoints/identity.md
 */
@Injectable()
export class KycService {
  constructor(
    private readonly db: DbService,
    private readonly files: StoredFiles,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists verification requests.
   *
   * @param query the parsed list request
   * @returns the page and the number matching the filters
   */
  async list(query: ParsedListQuery<KycSortField>): Promise<{ rows: WireKycSubmission[]; total: number }> {
    const { rows, total } = await listKycRows(this.db.db, query);
    return { rows: await this.wireOf(this.db.db, rows), total };
  }

  /**
   * Reads one request.
   *
   * @param id the request id
   * @returns the request
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<WireKycSubmission> {
    const row = await findKyc(this.db.db, id);
    if (!row) throw notFound();
    return (await this.wireOf(this.db.db, [row]))[0]!;
  }

  /**
   * Approves or rejects a pending request.
   *
   * @param staffId the staff member who decides
   * @param id the request id
   * @param input the decision and the note (required for a rejection)
   * @returns the request after the decision
   * @throws {AppError} `NOT_FOUND`; `ALREADY_DECIDED` when it is not pending; `VALIDATION_FAILED` on `note`
   */
  async decide(
    staffId: number,
    id: number,
    input: { decision: 'approve' | 'reject'; note?: string | undefined },
  ): Promise<WireKycSubmission> {
    const note = input.note?.trim() ?? '';
    const problem = checkDecisionNote(input.decision, note);
    if (problem) throw new AppError('VALIDATION_FAILED', { errors: [problem] });
    await this.db.runInTransaction(async ({ tx }) => {
      const current = await findKyc(tx, id, true);
      if (!current) throw notFound();
      if (current.status !== 'pending') {
        throw new AppError('ALREADY_DECIDED', { detail: `This request was already ${current.status}.` });
      }
      const status = input.decision === 'approve' ? 'approved' : 'rejected';
      const now = this.clock.now();
      await updateKyc(tx, id, { status, note, reviewedBy: staffId, reviewedAt: now, updatedAt: now });
      await setClientKycStatus(tx, current.clientId, status, now);
      const party = (await loadKycParties(tx, [current.clientId], [])).clients.get(current.clientId);
      await this.audit.record(tx, {
        action: input.decision === 'approve' ? 'approved verification of' : 'rejected verification of',
        entityType: 'kyc_submission',
        entityId: id,
        entityLabel: party?.name ?? `merchant ${current.clientId}`,
        before: { status: 'pending' },
        after: { status, note },
      });
    });
    return this.get(id);
  }

  /**
   * Reads the merchant's own verification.
   *
   * @param clientId the signed-in merchant
   * @returns its status and its latest request
   */
  async mine(clientId: number): Promise<WireMyKyc> {
    return this.myView(this.db.db, clientId);
  }

  /**
   * Submits documents for review.
   *
   * @param clientId the signed-in merchant
   * @param input the files it uploaded and an optional note
   * @returns its status (pending) and the new request
   * @throws {AppError} `CONFLICT` while a request is under review; `ALREADY_DECIDED` once verified; `VALIDATION_FAILED` on `fileIds`
   *   or `note`
   */
  async submit(clientId: number, input: { fileIds: readonly number[]; note?: string | undefined }): Promise<WireMyKyc> {
    const note = input.note?.trim() ?? '';
    const errors: FieldError[] = checkFileIds(input.fileIds);
    if (note.length > MAX_SUBMIT_NOTE) {
      errors.push({
        field: 'note',
        code: 'length',
        message: `Keep the note to ${MAX_SUBMIT_NOTE} characters or fewer.`,
      });
    }
    if (errors.length > 0) throw new AppError('VALIDATION_FAILED', { errors });
    await this.db.runInTransaction(async ({ tx }) => {
      const client = await lockClient(tx, clientId);
      if (!client) throw new AppError('UNAUTHORIZED');
      if (client.kycStatus === 'approved') {
        throw new AppError('ALREADY_DECIDED', { detail: 'Your identity is already verified.' });
      }
      if (client.kycStatus === 'pending') {
        throw new AppError('CONFLICT', { detail: 'Your documents are already under review.' });
      }
      const documentErrors: FieldError[] = [];
      for (const [index, fileId] of input.fileIds.entries()) {
        const file = await this.files.findOwned(tx, fileId, { type: 'client', id: clientId });
        if (!file || !PROOF_MIME_TYPES.includes(file.mime)) {
          documentErrors.push({
            field: `fileIds.${index}`,
            code: 'invalid',
            message: 'Upload each document as a PDF, JPEG or PNG file first.',
          });
        }
      }
      if (documentErrors.length > 0) throw new AppError('VALIDATION_FAILED', { errors: documentErrors });
      const now = this.clock.now();
      await insertKyc(tx, {
        clientId,
        status: 'pending',
        fileIds: [...input.fileIds],
        submittedNote: note,
        createdAt: now,
        updatedAt: now,
      });
      await setClientKycStatus(tx, clientId, 'pending', now);
    });
    return this.myView(this.db.db, clientId);
  }

  private async myView(db: DbExecutor, clientId: number): Promise<WireMyKyc> {
    const [latest, party] = await Promise.all([latestKycOf(db, clientId), clientKycStatus(db, clientId)]);
    if (!latest) return { status: party, submission: null };
    const files = await this.files.metaOf(db, latest.fileIds);
    return {
      status: party,
      submission: {
        id: latest.id,
        status: latest.status,
        note: latest.status === 'rejected' && latest.note !== '' ? latest.note : null,
        documents: latest.fileIds.flatMap((fileId) => {
          const file = files.get(fileId);
          return file ? [{ fileId: file.id, filename: file.filename, mime: file.mime, size: file.size }] : [];
        }),
        submittedAt: latest.createdAt.toISOString(),
        reviewedAt: latest.reviewedAt?.toISOString() ?? null,
      },
    };
  }

  private async wireOf(db: DbExecutor, rows: readonly KycSubmission[]): Promise<WireKycSubmission[]> {
    const [parties, files] = await Promise.all([
      loadKycParties(
        db,
        rows.map((row) => row.clientId),
        rows.flatMap((row) => (row.reviewedBy === null ? [] : [row.reviewedBy])),
      ),
      this.files.metaOf(
        db,
        rows.flatMap((row) => row.fileIds),
      ),
    ]);
    return rows.map((row) => {
      const client = parties.clients.get(row.clientId);
      return {
        id: row.id,
        clientId: row.clientId,
        status: row.status,
        fileIds: [...row.fileIds],
        files: row.fileIds.flatMap((fileId) => {
          const file = files.get(fileId);
          return file ? [{ id: file.id, filename: file.filename, mime: file.mime, size: file.size }] : [];
        }),
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
        client: {
          id: row.clientId,
          name: client?.name ?? '',
          email: client?.email ?? '',
          country: client?.country ?? '',
          status: (client?.status ?? 'pending') as 'active' | 'pending' | 'suspended',
        },
        reviewedBy:
          row.reviewedBy === null
            ? null
            : { id: row.reviewedBy, name: parties.staff.get(row.reviewedBy) ?? `Staff ${row.reviewedBy}` },
      };
    });
  }
}
