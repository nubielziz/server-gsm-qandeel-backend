// TicketAdminService: the use cases behind the support inbox routes (feature 17): list, read one ticket with its thread, and change its
// priority, assignee or status (resolve and reopen included). Replies and notes are TicketConversationService.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import type { CustomerContact } from '../../../common/customer-contact';
import { AppError, type FieldError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import { RankGroupReads } from '../../catalog';
import { AuditService } from '../../platform';
import type { SupportTicket, TicketPriority, TicketStatus } from '../db/schema';
import { replyChannelsOf } from '../domain/reply-channels';
import { slaDueAt } from '../domain/ticket-sla';
import { type WireTicketStatus, fromWireStatus, judgeStatusMove, toWireStatus } from '../domain/ticket-status';
import { findAssignableStaff, findRequester, findStaffName } from '../infra/support-foreign-reads';
import {
  type TicketSortField,
  findTicketRow,
  insertMessage,
  lastPublicMessage,
  lastPublicTimes,
  listMessageRows,
  listTicketRows,
  lockTicket,
  updateTicket,
} from '../infra/ticket.repository';
import { TicketAttachmentService } from './ticket-attachment.service';
import { TicketEvents } from './ticket-events';
import { type TicketDetailView, type TicketRowView, toDetailView, toTicketView } from './ticket-views';

/** The fields `PATCH /admin/support-tickets/:id` may change. */
export interface UpdateTicketInput {
  readonly priority?: TicketPriority | undefined;
  /** `null` unassigns. */
  readonly assigneeId?: number | null | undefined;
  readonly status?: WireTicketStatus | undefined;
}

/** The fields a request named, with the values the ticket has now (the snapshot of a request that changed nothing). */
function unchangedFields(ticket: SupportTicket, input: UpdateTicketInput): Record<string, unknown> {
  return {
    ...(input.priority === undefined ? {} : { priority: ticket.priority }),
    ...(input.assigneeId === undefined ? {} : { assigneeId: ticket.assigneeId }),
    ...(input.status === undefined ? {} : { status: toWireStatus(ticket.status) }),
  };
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No ticket has this id.' });

/** The label the audit log shows: the ticket number and its subject (the demo's `<id>, <subject>`). */
const labelOf = (ticket: Pick<SupportTicket, 'number' | 'subject'>) => `${ticket.number}, ${ticket.subject}`;

/**
 * Reads and changes support tickets for staff.
 *
 * Why: RULES support and RESOLUTIONS b2c-2: the inbox with its timers decided on the server, the thread embedded in the detail, and the
 * changes the console makes: priority (moves the reply target), assignee (an active staff member or none) and status (resolve writes
 * `resolved_at` and the internal system message; reopen clears `resolved_at`). Values equal to the current ones are ignored.
 * Every change is one audit entry in the demo's words. The ticket row is locked while it changes, so a reply and a resolve never both pass
 * the same check.
 *
 * Side effects: writes `support_tickets`, `ticket_messages` (the system message) and `audit_logs`; rings `ticket updated` after a change
 * (and `ticket message` for the system message of a resolve, which only staff see).
 */
@Injectable()
export class TicketAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly attachments: TicketAttachmentService,
    private readonly events: TicketEvents,
    private readonly ranks: RankGroupReads,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists tickets.
   *
   * @param query the parsed list request
   * @param contact what the caller may see of an account's address (decision 047; it also decides whether `q` matches it)
   * @returns the page of inbox rows and the exact total
   */
  async list(
    query: ParsedListQuery<TicketSortField>,
    contact: CustomerContact,
  ): Promise<{ rows: TicketRowView[]; total: number }> {
    const now = this.clock.now();
    const retailGroupId = await this.ranks.retailGroupId(this.db.db);
    const { rows, total } = await listTicketRows(this.db.db, query, now, contact, retailGroupId);
    const times = await lastPublicTimes(
      this.db.db,
      rows.map((row) => row.ticket.id),
    );
    return {
      rows: rows.map((row) => toTicketView(row, times.get(row.ticket.id), now, contact, retailGroupId)),
      total,
    };
  }

  /**
   * Reads one ticket with its thread.
   *
   * @param id the ticket id
   * @param contact what the caller may see of an account's address (decision 047)
   * @returns the ticket, every message (internal notes included, each with its attachments) and the channels a reply may use
   * @throws {AppError} `NOT_FOUND`
   */
  async show(id: number, contact: CustomerContact): Promise<TicketDetailView> {
    const row = await findTicketRow(this.db.db, id);
    if (!row) throw notFound();
    const [times, messages, requester, retailGroupId] = await Promise.all([
      lastPublicTimes(this.db.db, [id]),
      listMessageRows(this.db.db, id, false),
      findRequester(this.db.db, row.ticket.requesterId),
      this.ranks.retailGroupId(this.db.db),
    ]);
    const files = await this.attachments.filesOf(
      this.db.db,
      messages.map((message) => message.message),
    );
    const channels = replyChannelsOf({ reachable: requester?.reachable ?? false });
    return toDetailView(row, times.get(id), messages, files, channels, this.clock.now(), contact, retailGroupId);
  }

  /**
   * Changes a ticket's priority, assignee or status.
   *
   * @param id the ticket id
   * @param input the keys to change
   * @param staffId the staff member making the change
   * @param contact what the caller may see of an account's address in the answer (decision 047)
   * @returns the updated inbox row
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `assigneeId` for anyone who is not an active staff member, on `status`
   *   for a move the ticket cannot make)
   */
  async update(
    id: number,
    input: UpdateTicketInput,
    staffId: number,
    contact: CustomerContact,
  ): Promise<TicketRowView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await lockTicket(tx, id);
      if (!before) throw notFound();
      const now = this.clock.now();
      const label = labelOf(before);

      const target: TicketStatus | undefined = input.status === undefined ? undefined : fromWireStatus(input.status);
      const newStatus = target !== undefined && target !== before.status ? target : undefined;
      const newPriority =
        input.priority !== undefined && input.priority !== before.priority ? input.priority : undefined;
      const reassign = input.assigneeId !== undefined && (input.assigneeId ?? null) !== before.assigneeId;

      const problems: FieldError[] = [];
      let assignee: { id: number; name: string } | undefined;
      if (reassign && input.assigneeId !== null && input.assigneeId !== undefined) {
        assignee = await findAssignableStaff(tx, input.assigneeId);
        if (!assignee) {
          problems.push({ field: 'assigneeId', code: 'not_assignable', message: 'Choose someone on the team.' });
        }
      }
      if (newStatus !== undefined) {
        const move = judgeStatusMove(before.status, newStatus);
        if (!move.ok) problems.push({ field: 'status', code: 'invalid_move', message: move.message });
      }
      if (problems.length > 0) throw new AppError('VALIDATION_FAILED', { errors: problems });

      if (newStatus === undefined && newPriority === undefined && !reassign) {
        // Nothing differs from what the ticket has (a second agent made the same change first): nothing is written but the audit entry,
        // because every staff mutation leaves one (the platform's enforcement) and the log should show the request was made.
        await this.audit.record(tx, {
          action: 'edited ticket',
          entityType: 'ticket',
          entityId: id,
          entityLabel: label,
          before: unchangedFields(before, input),
          after: unchangedFields(before, input),
        });
        return this.row(tx, id, now, contact);
      }

      const status = newStatus ?? before.status;
      const priority = newPriority ?? before.priority;
      const changes: Parameters<typeof updateTicket>[2] = { updatedAt: now };
      if (newPriority !== undefined) changes.priority = newPriority;
      if (reassign) changes.assigneeId = assignee?.id ?? null;
      if (newStatus !== undefined) {
        changes.status = newStatus;
        changes.resolvedAt = newStatus === 'resolved' ? now : null;
      }
      if (newStatus !== undefined || newPriority !== undefined) {
        // The reply target follows the thread, the status and the priority (RULES support 2); a resolved ticket waits for nobody.
        changes.slaDueAt = status === 'resolved' ? null : slaDueAt(status, priority, await lastPublicMessage(tx, id));
      }
      const after = await updateTicket(tx, id, changes);

      if (newPriority !== undefined) {
        await this.audit.record(tx, {
          action: 'changed priority of ticket',
          entityType: 'ticket',
          entityId: id,
          entityLabel: label,
          before: { priority: before.priority },
          after: { priority: after.priority },
        });
      }
      if (reassign) {
        const previous = before.assigneeId === null ? null : ((await findStaffName(tx, before.assigneeId)) ?? null);
        await this.audit.record(tx, {
          // The demo has one phrase for both: clearing the assignee is 'assigned ticket' with the assignee none (ANSWERS audit Q3).
          action: 'assigned ticket',
          entityType: 'ticket',
          entityId: id,
          entityLabel: label,
          before: { assigneeId: before.assigneeId, assignee: previous },
          after: { assigneeId: after.assigneeId, assignee: assignee?.name ?? null },
        });
      }
      if (newStatus !== undefined) {
        const reopened = before.status === 'resolved';
        await this.audit.record(tx, {
          action:
            newStatus === 'resolved' ? 'resolved ticket' : reopened ? 'reopened ticket' : 'changed status of ticket',
          entityType: 'ticket',
          entityId: id,
          entityLabel: label,
          before: { status: toWireStatus(before.status) },
          after: { status: toWireStatus(after.status) },
        });
        if (newStatus === 'resolved') await this.afterResolve(tx, id, staffId, now);
      }
      this.events.updated(id);
      return this.row(tx, id, now, contact);
    });
  }

  /**
   * What a resolve adds to the ticket: the internal system message.
   *
   * Why: RULES support 5: `Marked resolved by <staff>.` is written in the thread (internal), and staff see it live; the requester's streams
   * never render it (they get the `updated` of the resolve).
   */
  private async afterResolve(tx: DbExecutor, ticketId: number, staffId: number, now: Date): Promise<void> {
    const name = (await findStaffName(tx, staffId)) ?? 'staff';
    const message = await insertMessage(tx, {
      ticketId,
      authorType: 'system',
      authorId: null,
      body: `Marked resolved by ${name}.`,
      isInternal: true,
      createdAt: now,
    });
    this.events.message(ticketId, message.id);
  }

  /** Reads the inbox row of a ticket after a write (inside the transaction, so the new state is what it sees). */
  private async row(db: DbExecutor, id: number, now: Date, contact: CustomerContact): Promise<TicketRowView> {
    const row = await findTicketRow(db, id);
    if (!row) throw notFound();
    const times = await lastPublicTimes(db, [id]);
    return toTicketView(row, times.get(id), now, contact, await this.ranks.retailGroupId(db));
  }
}
