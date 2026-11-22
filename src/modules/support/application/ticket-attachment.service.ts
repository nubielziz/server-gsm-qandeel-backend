// TicketAttachmentService: the files of the support chat (feature 28, rule 8 and 10): the upload of the ticket page and of the console,
// the check when a message attaches files, the download link of a requester and of staff, and the deletion with an anonymized customer
// and after the retention of a resolved ticket.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError, type FieldError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import {
  AuditService,
  CUSTOMER_DAILY_QUOTA,
  type FileMeta,
  SUPPORT_SETTINGS,
  SettingsReader,
  StoredFiles,
  type UploadInput,
  assertUploadQuota,
  auditStaffFileOpening,
  cleanMediaType,
  cleanUploadName,
  lockUploadOwner,
  ticketDailyQuota,
} from '../../platform';
import type { SupportTicket } from '../db/schema';
import {
  type AttachProblem,
  type FileOwner,
  MAX_ATTACHMENT_BYTES,
  attachProblem,
  ticketUploadArea,
  uploadProblem,
} from '../domain/attachment-rules';
import {
  findTicket,
  lockTicketsPastAttachmentRetention,
  takeFileIdsOfTickets,
  ticketIdsOfCustomer,
  ticketMessageHoldsFile,
} from '../infra/ticket.repository';
import { isLockedForRequester, requesterLockedError } from './requester-lock';
import { TicketEvents } from './ticket-events';
import type { AttachmentFiles } from './ticket-views';

/** A stored attachment as the two upload routes answer it (the shape of the platform's upload routes). */
export interface UploadedAttachment {
  readonly id: number;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly sha256: string;
  readonly createdAt: string;
}

/** Who uploads: the requester of the ticket (through its link) or a staff member. */
export type Uploader = { readonly side: 'requester' } | { readonly side: 'staff'; readonly staffId: number };

/** What a retention run did. */
export interface AttachmentRetentionOutcome {
  /** The retention in force, in days (`0`: attachments are kept). */
  readonly days: number;
  /** Tickets whose attachments were removed. */
  readonly tickets: number;
  /** File rows deleted (a file another record still uses is kept). */
  readonly files: number;
}

/** Tickets one retention batch handles. */
export const RETENTION_BATCH_TICKETS = 200;
/** The most batches one retention run does; a larger backlog continues the next night. */
export const RETENTION_MAX_BATCHES = 25;

const DAY_MS = 86_400_000;

const ATTACH_MESSAGES: Readonly<Record<AttachProblem, string>> = {
  unknown_file: 'This file does not exist. Upload it again.',
  not_yours: 'Attach only files you uploaded yourself.',
  type: 'Attach a PDF, JPEG or PNG file.',
  too_large: 'Attach files of at most 5 MB.',
};

const notFound = (detail = 'No file with this id.') => new AppError('NOT_FOUND', { detail });

/**
 * Uploads, attaches, opens and deletes the attachments of tickets.
 *
 * Why: feature 28, rule 8: PDF, JPEG or PNG, 1 byte to 5 MiB, at most 5 a message, and the content must start with the
 * type's magic bytes (there is no virus scanner, so files are never shown inline and every download is a 5-minute presigned link with an
 * attachment disposition). A sender attaches only their own uploads: the ticket's customer (uploaded through the ticket link), the
 * merchant (the portal's `POST /client/files`, which takes any file, so the type and size are checked again here) or the staff member.
 * A requester's upload through the link is stored under the ticket's own area (`tickets-<id>`, staff uploads under `tickets`), and a
 * link writer attaches only files of that area: the link must not reach the customer's other files (receipts, other tickets' uploads).
 * A requester downloads only the files of public messages of their ticket; staff with `support:read` every file of the ticket. Rule 10:
 * anonymizing a customer deletes every attachment of their tickets (both sides' files; the texts stay, B175) and ends their ticket
 * streams; attachments are deleted `support.attachmentRetentionDays` (default 180, `0` keeps them) after their ticket was resolved.
 *
 * Side effects: `files` rows and objects (through `StoredFiles`), `ticket_messages.file_ids`, an `audit_logs` row for a staff upload, the
 * `ticket revoked` doorbells of an erasure.
 */
@Injectable()
export class TicketAttachmentService {
  constructor(
    private readonly db: DbService,
    private readonly files: StoredFiles,
    private readonly events: TicketEvents,
    private readonly settings: SettingsReader,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Stores one attachment for a ticket.
   *
   * @param ticketId the ticket (the one the link opened, or the console's)
   * @param uploader the ticket's requester (stored under the ticket's area `tickets-<id>`) or a staff member (area `tickets`)
   * @param input the multipart file part
   * @returns the stored file; its id goes into `fileIds` of the next message
   * @throws {AppError} `NOT_FOUND` (no such ticket, or a link of a ticket that has no customer); `TICKET_RESOLVED` (409: a requester's
   *   upload for a resolved ticket, which takes no message, so the file would be an orphan; staff may still upload); `VALIDATION_FAILED`
   *   (422 on `file`: `empty`, `type`, `quota`: a ticket link takes 20 files (50 MiB) and its customer 30 files (100 MiB) in 24 hours,
   *   decision 053; staff uploads have no quota); `PAYLOAD_TOO_LARGE` (over 5 MiB); `UNAVAILABLE` (the object store is down)
   */
  async upload(ticketId: number, uploader: Uploader, input: UploadInput): Promise<UploadedAttachment> {
    const mime = cleanMediaType(input.mime);
    const problem = uploadProblem(mime, input.data);
    if (problem === 'too_large') {
      throw new AppError('PAYLOAD_TOO_LARGE', {
        detail: `The file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB.`,
      });
    }
    if (problem === 'empty') {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The file is empty.',
        errors: [{ field: 'file', code: 'empty', message: 'The file is empty.' }],
      });
    }
    if (problem === 'type') {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Upload a PDF, JPEG or PNG file.',
        errors: [{ field: 'file', code: 'type', message: 'Upload a PDF, JPEG or PNG file.' }],
      });
    }
    return this.db.runInTransaction(async ({ tx }) => {
      const ticket = await findTicket(tx, ticketId);
      if (!ticket) throw notFound('No ticket has this id.');
      // B220: a resolved ticket is closed for its requester, so an upload for it could never be attached (no orphan files).
      if (uploader.side === 'requester' && isLockedForRequester(ticket)) throw requesterLockedError();
      const owner: FileOwner =
        uploader.side === 'staff'
          ? { type: 'staff', id: uploader.staffId }
          : { type: ticket.requesterType, id: ticket.requesterId };
      // Decision 053: a requester's upload counts against the ticket's quota and the customer's, checked under the owner's lock before the
      // object is written (the lock lasts until this transaction ends).
      if (uploader.side === 'requester') {
        await lockUploadOwner(tx, { type: ticket.requesterType, id: ticket.requesterId });
        await assertUploadQuota(
          tx,
          { type: ticket.requesterType, id: ticket.requesterId },
          [ticketDailyQuota(ticket.id), CUSTOMER_DAILY_QUOTA],
          input.data.length,
          this.clock.now(),
        );
      }
      const stored = await this.files.store(tx, {
        ownerType: owner.type,
        ownerId: owner.id,
        filename: cleanUploadName(input.filename),
        mime,
        bytes: input.data,
        // A requester's upload is bound to its ticket: a link writer may attach only these (see `attach`).
        area: uploader.side === 'staff' ? 'tickets' : ticketUploadArea(ticket.id),
      });
      if (uploader.side === 'staff') {
        await this.audit.record(tx, {
          action: 'attached file to ticket',
          entityType: 'ticket',
          entityId: ticket.id,
          entityLabel: `${ticket.number}, ${ticket.subject}`,
          after: { fileId: stored.id, filename: stored.filename, size: stored.size },
        });
      }
      return {
        id: stored.id,
        filename: stored.filename,
        size: stored.size,
        mime: stored.mime,
        sha256: stored.sha256,
        createdAt: stored.createdAt.toISOString(),
      };
    });
  }

  /**
   * Checks the files a new message wants to carry, inside the message's transaction.
   *
   * @param tx the message's transaction
   * @param sender who writes: the ticket's requester (`customer` or `client`) or the staff member
   * @param fileIds the ids the body named (duplicates are attached once)
   * @param onlyArea the area every file must have as well: the ticket's upload area for a ticket link's holder; `undefined` for a
   *   signed-in requester and for staff (the owner alone decides)
   * @returns the ids to store in `file_ids`, in order, and their files (to render the new message)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `fileIds`: `unknown_file`, `not_yours` (another owner's file, or one outside
   *   `onlyArea`), `type`, `too_large`)
   */
  async attach(
    tx: DbExecutor,
    sender: FileOwner,
    fileIds: readonly number[] | undefined,
    onlyArea?: string,
  ): Promise<{ ids: number[]; files: AttachmentFiles }> {
    const ids = [...new Set(fileIds ?? [])];
    if (ids.length === 0) return { ids, files: new Map() };
    const found = await this.files.metaOf(tx, ids);
    const problems = new Set<AttachProblem>();
    for (const id of ids) {
      const problem = attachProblem(found.get(id), sender, onlyArea);
      if (problem) problems.add(problem);
    }
    if (problems.size > 0) {
      const errors: FieldError[] = [...problems].map((code) => ({
        field: 'fileIds',
        code,
        message: ATTACH_MESSAGES[code],
      }));
      throw new AppError('VALIDATION_FAILED', { errors });
    }
    return { ids, files: found };
  }

  /**
   * Reads the files of the messages being rendered.
   *
   * @param db the database or a transaction
   * @param messages the messages (their `fileIds`)
   * @returns the stored files, by id
   */
  async filesOf(
    db: DbExecutor,
    messages: readonly { readonly fileIds: readonly number[] }[],
  ): Promise<Map<number, FileMeta>> {
    return this.files.metaOf(
      db,
      messages.flatMap((message) => message.fileIds),
    );
  }

  /**
   * Makes the download link of an attachment of a ticket.
   *
   * @param ticketId the ticket of the route
   * @param viewer `requester` (public messages only) or `staff` (every message)
   * @param fileId the file
   * @returns the presigned link (5 minutes, attachment disposition)
   * @throws {AppError} `NOT_FOUND` for a file that is in no message of that ticket the viewer may see, or that is gone
   *
   * Side effects: for `staff`, a file that is also an identity document or a payment proof writes the same `audit_logs` row as opening it from
   * its own page (decision 047); an ordinary attachment writes none.
   */
  async linkFor(ticketId: number, viewer: 'requester' | 'staff', fileId: number): Promise<string> {
    if (!(await ticketMessageHoldsFile(this.db.db, ticketId, fileId, viewer === 'requester'))) throw notFound();
    const link = await this.files.linkTo(this.db.db, fileId);
    if (link === undefined) throw notFound();
    // Decision 047: the rule of GET /admin/files/:id (the audited kinds), written before the link is handed out: no row, no link.
    if (viewer === 'staff') await auditStaffFileOpening(this.db, this.audit, fileId);
    return link;
  }

  /**
   * Deletes every attachment of an anonymized customer's tickets and ends their ticket streams.
   *
   * @param tx the anonymization's transaction
   * @param customerId the customer
   * @returns how many file rows were deleted
   */
  async eraseForCustomer(tx: DbExecutor, customerId: number): Promise<number> {
    const ticketIds = await ticketIdsOfCustomer(tx, customerId);
    const removed = await this.eraseForTickets(tx, ticketIds);
    for (const ticketId of ticketIds) this.events.revoked(ticketId);
    return removed;
  }

  /**
   * Applies the attachment retention: the files of tickets resolved longer ago than `support.attachmentRetentionDays` are deleted.
   *
   * Why: rule 10: files hold personal data and are not kept for ever; `0` keeps them. The tickets are locked in batches
   * of {@link RETENTION_BATCH_TICKETS} with `SKIP LOCKED`, so a repeat or a parallel run only finds fewer rows.
   *
   * @returns the retention in force and what was removed
   */
  async applyRetention(): Promise<AttachmentRetentionOutcome> {
    const setting = SUPPORT_SETTINGS.attachmentRetentionDays;
    const days = await this.settings.integer(setting.key, setting.fallback, setting);
    if (days === 0) return { days, tickets: 0, files: 0 };
    const cutoff = new Date(this.clock.nowMs() - days * DAY_MS);
    let tickets = 0;
    let files = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
      const done = await this.db.runInTransaction(async ({ tx }) => {
        const ids = await lockTicketsPastAttachmentRetention(tx, cutoff, RETENTION_BATCH_TICKETS);
        return { tickets: ids.length, files: ids.length === 0 ? 0 : await this.eraseForTickets(tx, ids) };
      });
      tickets += done.tickets;
      files += done.files;
      if (done.tickets < RETENTION_BATCH_TICKETS) break;
    }
    return { days, tickets, files };
  }

  /** Empties the attachments of the tickets' messages and deletes the files nothing else uses (objects after the commit). */
  private async eraseForTickets(tx: DbExecutor, ticketIds: readonly number[]): Promise<number> {
    const fileIds = await takeFileIdsOfTickets(tx, ticketIds);
    return (await this.files.remove(tx, fileIds)).length;
  }
}

/**
 * The owner a requester's files must have: the ticket's customer or merchant.
 *
 * @param ticket the ticket
 * @returns the owner as the `files` table names it
 */
export function requesterOwner(ticket: Pick<SupportTicket, 'requesterType' | 'requesterId'>): FileOwner {
  return { type: ticket.requesterType, id: ticket.requesterId };
}
