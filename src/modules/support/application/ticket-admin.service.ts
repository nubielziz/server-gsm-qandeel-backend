// TicketAdminService: the use cases behind the support inbox routes (feature 17): list, read one ticket with its thread, and change its
// priority, assignee or status (resolve and reopen included). Replies and notes are TicketConversationService.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { DbService, type DbExecutor, type TransactionContext } from '../../../infra/db';
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
  markSurveySent,
  updateTicket,
} from '../infra/ticket.repository';
import { TicketMailOutbox } from './ticket-mail-outbox';
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

/** The closing sentence of the system message written with a survey (RULES support 5). It is only text: `survey_sent_at` is the record. */
const SURVEY_SENTENCE = 'A satisfaction survey is emailed to the customer.';

/** The label the audit log shows: the ticket number and its subject (the demo's `<id>, <subject>`). */
const labelOf = (ticket: Pick<SupportTicket, 'number' | 'subject'>) => `${ticket.number}, ${ticket.subject}`;

/**
 * Reads and changes support tickets for staff.
 *
 * Why: RULES support and RESOLUTIONS b2c-2: the inbox with its timers decided on the server, the thread embedded in the detail, and the
 * changes the console makes: priority (moves the reply target), assignee (an active staff member or none) and status (resolve writes
 * `resolved_at`, the internal system message and the survey; reopen clears `resolved_at`). Values equal to the current ones are ignored.
 * Every change is one audit entry in the demo's words. The ticket row is locked while it changes, so a reply and a resolve never both pass
 * the same check.
 *
 * Side effects: writes `support_tickets`, `ticket_messages` (the system message), `outbox_events` (the survey's `support.ticket_mail`) and
 * `audit_logs`.
 */
@Injectable()
export class TicketAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: TicketMailOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists tickets.
   *
   * @param query the parsed list request
   * @returns the page of inbox rows and the exact total
   */
  async list(query: ParsedListQuery<TicketSortField>): Promise<{ rows: TicketRowView[]; total: number }> {
    const now = this.clock.now();
    const { rows, total } = await listTicketRows(this.db.db, query, now);
    const times = await lastPublicTimes(
      this.db.db,
      rows.map((row) => row.ticket.id),
    );
    return { rows: rows.map((row) => toTicketView(row, times.get(row.ticket.id), now)), total };
  }

  /**
   * Reads one ticket with its thread.
   *
   * @param id the ticket id
   * @returns the ticket, every message (internal notes included) and the channels a reply may use
   * @throws {AppError} `NOT_FOUND`
   */
  async show(id: number): Promise<TicketDetailView> {
    const row = await findTicketRow(this.db.db, id);
    if (!row) throw notFound();
    const [times, messages, requester] = await Promise.all([
      lastPublicTimes(this.db.db, [id]),
      listMessageRows(this.db.db, id, false),
      findRequester(this.db.db, row.ticket.requesterType, row.ticket.requesterId),
    ]);
    const channels = replyChannelsOf({
      requesterType: row.ticket.requesterType,
      reachable: requester?.reachable ?? false,
      telegramChatId: requester?.telegramChatId ?? null,
    });
    return toDetailView(row, times.get(id), messages, channels, this.clock.now());
  }

  /**
   * Changes a ticket's priority, assignee or status.
   *
   * @param id the ticket id
   * @param input the keys to change
   * @param staffId the staff member making the change
   * @returns the updated inbox row
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `assigneeId` for anyone who is not an active staff member, on `status`
   *   for a move the ticket cannot make)
   */
  async update(id: number, input: UpdateTicketInput, staffId: number): Promise<TicketRowView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
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
        return this.row(tx, id, now);
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
        if (newStatus === 'resolved') await this.afterResolve(work, after, staffId, now);
      }
      return this.row(tx, id, now);
    });
  }

  /**
   * What a resolve adds to the ticket: the internal system message and the satisfaction survey.
   *
   * Why: RULES support 5: `Marked resolved by <staff>. A satisfaction survey is emailed to the customer.` is written in the thread
   * (internal), and the survey goes to the customer through the notification service. A merchant's ticket has no ticket page, so it gets
   * no survey and the message says so. The survey is sent once per ticket: one resolved again after a reopen is not asked a second time,
   * rated or not (`support_tickets.survey_sent_at` is the record, set here under a guard, so the second message is only
   * `Marked resolved by <staff>.`).
   */
  private async afterResolve(
    work: Pick<TransactionContext, 'tx'>,
    ticket: SupportTicket,
    staffId: number,
    now: Date,
  ): Promise<void> {
    const { tx } = work;
    const customer = ticket.requesterType === 'customer';
    const requester = customer ? await findRequester(tx, 'customer', ticket.requesterId) : undefined;
    const askable =
      customer &&
      ticket.csatScore === null &&
      ticket.surveySentAt === null &&
      ticket.token !== null &&
      requester?.reachable === true;
    // The guarded update is the record that the survey was queued; it runs in this transaction, with the event and the message below.
    const survey = askable && (await markSurveySent(tx, ticket.id, now));
    const name = (await findStaffName(tx, staffId)) ?? 'staff';
    await insertMessage(tx, {
      ticketId: ticket.id,
      authorType: 'system',
      authorId: null,
      body: survey ? `Marked resolved by ${name}. ${SURVEY_SENTENCE}` : `Marked resolved by ${name}.`,
      isInternal: true,
      createdAt: now,
    });
    if (survey) await this.mail.survey(work, ticket);
  }

  /** Reads the inbox row of a ticket after a write (inside the transaction, so the new state is what it sees). */
  private async row(db: DbExecutor, id: number, now: Date): Promise<TicketRowView> {
    const row = await findTicketRow(db, id);
    if (!row) throw notFound();
    const times = await lastPublicTimes(db, [id]);
    return toTicketView(row, times.get(id), now);
  }
}
