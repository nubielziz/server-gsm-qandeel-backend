// BulkReplyService: the bulk reply of the console (map domain D, stage 5): match pasted `IMEI CODE` lines to open orders, then
// complete the matched orders, each through the same reply transition as a single reply.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import {
  type BulkReplyLineStatus,
  MAX_BULK_ITEMS,
  type MatchCandidate,
  isRecentRejection,
  matchLine,
  ownerKey,
  parseBulkLines,
  squash,
} from '../domain/bulk-reply';
import { type InputMatchRow, findOrdersByInputs } from '../infra/order-read.repository';
import { ORDER_AUDIT_ACTIONS, type StaffActor } from './order-actions.service';
import { OrderTransitions } from './order-transitions';
import type { NamedRef } from './order-views';

/** One pasted line after matching. */
export interface BulkReplyLineView {
  readonly line: number;
  readonly raw: string;
  readonly imei: string | null;
  readonly code: string | null;
  readonly orderId: number | null;
  readonly status: BulkReplyLineStatus;
  /** The merchant of the matched order (`null` unless the line is matched to a merchant's order). */
  readonly client: NamedRef | null;
  /** The storefront customer of the matched order (`null` unless the line is matched to a storefront order). */
  readonly customer: NamedRef | null;
  /** The service of the matched order (`null` unless the line is matched). */
  readonly service: NamedRef | null;
}

/** The result of applying a bulk reply. */
export interface BulkReplyResultView {
  readonly applied: number;
  readonly failed: Array<{ orderId: number; title: string }>;
}

/** The most text one paste may hold: far above 500 lines, far below a memory problem. */
export const MAX_PASTE_CHARACTERS = 200_000;

/**
 * Matches and applies bulk replies.
 *
 * Why: ANSWERS orders Q13 and RESOLUTIONS orders-suppliers-2: the preview matches `orders.imei` with whitespace removed, for
 * non-empty inputs only, and matches a line only when the order it completes is the one order its input can mean (`matchLine`);
 * the apply handles at most 500 items, each as its own `reply` (own transaction, same checks and ledger), so
 * a refused item goes to `failed` with its readable reason and never turns the call into an error.
 *
 * Side effects: `preview` changes nothing. `apply` runs one reply transaction per item (order, ledger, events, outbox, audit) and
 * writes one summary `audit_logs` row for the request (even when every item failed, so the request is always audited).
 */
@Injectable()
export class BulkReplyService {
  constructor(
    private readonly db: DbService,
    private readonly transitions: OrderTransitions,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads the pasted text and matches each line to an order.
   *
   * Why: a line is matched only when exactly one order with its input is open and no order with that input but another buyer or
   * another service is open or was cancelled or rejected in the last 7 days (`matchLine`); a matched line names the buyer and the
   * service of the order it completes, so staff see whose order a result goes to.
   *
   * @param text the pasted lines
   * @returns one entry per non-blank line, with the buyer and the service of a matched order
   * @throws {AppError} `VALIDATION_FAILED` on `text` when nothing was pasted or the paste is over 500 lines
   */
  async preview(text: string): Promise<{ lines: BulkReplyLineView[] }> {
    if (text.length > MAX_PASTE_CHARACTERS) throw this.tooLong();
    const parsed = parseBulkLines(text);
    if (parsed.length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Paste at least one line.',
        errors: [{ field: 'text', code: 'required', message: 'Paste at least one line.' }],
      });
    }
    if (parsed.length > MAX_BULK_ITEMS) throw this.tooLong();
    const inputs = [...new Set(parsed.flatMap((line) => (line.imei === null ? [] : [squash(line.imei)])))];
    const found = await findOrdersByInputs(this.db.db, inputs);
    const now = this.clock.now();
    const byInput = new Map<string, MatchCandidate[]>();
    const byId = new Map<number, InputMatchRow>();
    for (const order of found) {
      const list = byInput.get(order.squashed) ?? [];
      list.push({
        id: order.id,
        open: order.status === 'pending' || order.status === 'processing',
        owner: ownerKey(order),
        recentlyRejected: isRecentRejection(order, now),
      });
      byInput.set(order.squashed, list);
      byId.set(order.id, order);
    }
    return {
      lines: parsed.map((line) => {
        const { status, orderId } = matchLine(line, line.imei === null ? [] : (byInput.get(squash(line.imei)) ?? []));
        const order = orderId === null ? undefined : byId.get(orderId);
        return {
          line: line.line,
          raw: line.raw,
          imei: line.imei,
          code: line.code,
          orderId,
          status,
          client:
            order === undefined || order.clientId === null
              ? null
              : { id: order.clientId, name: order.clientName ?? '' },
          customer:
            order === undefined || order.customerId === null
              ? null
              : { id: order.customerId, name: order.customerName ?? '' },
          service: order === undefined ? null : { id: order.serviceId, name: order.serviceName },
        };
      }),
    };
  }

  /**
   * Completes each matched order with its code.
   *
   * @param staff the acting staff member
   * @param items the orders and their reply codes (the contract checks the cap of 500)
   * @returns how many were completed and which were refused, with the reason
   */
  async apply(
    staff: StaffActor,
    items: ReadonlyArray<{ orderId: number; code: string }>,
  ): Promise<BulkReplyResultView> {
    let applied = 0;
    const failed: Array<{ orderId: number; title: string }> = [];
    // One order after the other: each is its own transaction, and a long run must not hold a hundred connections.
    for (const item of items) {
      try {
        await this.db.runInTransaction(({ tx }) =>
          this.transitions.apply(tx, {
            orderId: item.orderId,
            action: { kind: 'reply' },
            actor: { type: 'staff', id: staff.staffId },
            code: item.code,
            audit: ORDER_AUDIT_ACTIONS.reply,
          }),
        );
        applied += 1;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        failed.push({ orderId: item.orderId, title: error.detail ?? error.title });
      }
    }
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, {
        action: ORDER_AUDIT_ACTIONS.bulkApply,
        entityType: 'order',
        entityLabel: `${applied} of ${items.length} orders`,
        after: { applied, failed: failed.length },
      }),
    );
    return { applied, failed };
  }

  private tooLong(): AppError {
    return new AppError('VALIDATION_FAILED', {
      detail: `Paste at most ${MAX_BULK_ITEMS} lines at a time.`,
      errors: [{ field: 'text', code: 'too_many', message: `Paste at most ${MAX_BULK_ITEMS} lines at a time.` }],
    });
  }
}
