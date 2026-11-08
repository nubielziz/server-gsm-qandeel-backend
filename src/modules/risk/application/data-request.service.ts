// DataRequestService: the data-subject requests (GET/PATCH /admin/data-requests, POST /store/v1/me/data-export and /data-delete, map
// domain K, stage 18, RESOLUTIONS b2c-13, ANSWERS customers Q4, Q5 and Q12): a customer asks, staff move the request along before its
// 30-day deadline.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { DataRequest, DataRequestKind, DataRequestStatus } from '../db/schema';
import { type MoveTarget, dueDateOf, refuseMove } from '../domain/data-requests';
import {
  type DataRequestRow,
  type DataRequestSortField,
  findDataRequestRow,
  completePendingRequests,
  findPendingRequest,
  insertDataRequest,
  listDataRequestRows,
  updateDataRequest,
} from '../infra/data-request.repository';

/** A request as the console reads it. */
export interface DataRequestView {
  readonly id: number;
  readonly customerId: number;
  readonly kind: DataRequestKind;
  readonly status: DataRequestStatus;
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly completedAt: string | null;
  readonly handledBy: number | null;
  readonly fileId: number | null;
  readonly createdAt: string;
  readonly customerName: string;
}

/** What the customer's own request answers. */
export interface MyRequestView {
  readonly id: number;
  readonly kind: DataRequestKind;
  readonly status: DataRequestStatus;
  readonly requestedAt: string;
  readonly dueAt: string;
}

function viewOf(row: DataRequestRow): DataRequestView {
  const r = row.request;
  return {
    id: r.id,
    customerId: r.customerId,
    kind: r.kind,
    status: r.status,
    requestedAt: r.requestedAt.toISOString(),
    dueAt: r.dueAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    handledBy: r.handledBy,
    fileId: r.fileId,
    createdAt: r.createdAt.toISOString(),
    customerName: row.customerName,
  };
}

function mineOf(r: DataRequest): MyRequestView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    requestedAt: r.requestedAt.toISOString(),
    dueAt: r.dueAt.toISOString(),
  };
}

/**
 * Data-subject requests.
 *
 * Why: the privacy law gives a customer the right to a copy of their data and to its erasure, and the shop 30 days to answer. The
 * customer asks from the storefront account (`POST /store/v1/me/data-export` and `/data-delete`); asking again while a request of
 * the same kind is still open returns that request instead of a second one. Staff see them in the console with the deadline and move
 * them: open to in progress, completed or rejected; a rejection needs a note (stored on the request and in the audit row); a closed
 * request cannot move (`409 REQUEST_CLOSED`); an erasure request is completed by anonymizing the customer, not by hand (`409
 * ERASURE_NOT_DONE`), and an export request by downloading the export or by hand.
 *
 * Side effects: `request` inserts a `data_requests` row (serialised per customer and kind by an advisory lock); `move` updates it
 * and writes an `audit_logs` row.
 */
@Injectable()
export class DataRequestService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the requests.
   *
   * @param query the parsed list request
   * @returns the page and its total
   */
  async list(query: ParsedListQuery<DataRequestSortField>): Promise<{ rows: DataRequestView[]; total: number }> {
    const page = await listDataRequestRows(this.db.db, query);
    return { rows: page.rows.map(viewOf), total: page.total };
  }

  /**
   * Reads one request.
   *
   * @param id the request id
   * @returns the request
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async get(id: number): Promise<DataRequestView> {
    const row = await findDataRequestRow(this.db.db, id);
    if (!row) throw notFound();
    return viewOf(row);
  }

  /**
   * Moves a request along.
   *
   * @param staffId the signed-in staff member
   * @param id the request id
   * @param input the new status and the note
   * @returns the request after the move
   * @throws {AppError} `NOT_FOUND` (404), `REQUEST_CLOSED` (409), `ERASURE_NOT_DONE` (409), `VALIDATION_FAILED` (422, on `note` or
   *   `status`)
   */
  async move(
    staffId: number,
    id: number,
    input: { readonly status: MoveTarget; readonly note?: string | undefined },
  ): Promise<DataRequestView> {
    const now = this.clock.now();
    return this.db.runInTransaction(async ({ tx }) => {
      const row = await findDataRequestRow(tx, id, true);
      if (!row) throw notFound();
      const refusal = refuseMove({
        kind: row.request.kind,
        from: row.request.status,
        to: input.status,
        note: input.note,
        customerAnonymized: row.customerStatus === 'anonymized',
      });
      if (refusal) {
        if (refusal.code === 'VALIDATION_FAILED') {
          throw new AppError('VALIDATION_FAILED', {
            errors: [{ field: refusal.field, code: 'invalid', message: refusal.message }],
          });
        }
        throw new AppError(refusal.code);
      }
      const note = input.note?.trim() ?? '';
      const changed = await updateDataRequest(tx, id, {
        status: input.status,
        note: note === '' ? row.request.note : note,
        handledBy: staffId,
        completedAt: input.status === 'completed' ? now : null,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action:
          input.status === 'in_progress'
            ? 'started data request of'
            : input.status === 'completed'
              ? 'completed data request of'
              : 'rejected data request of',
        entityType: 'customer',
        entityId: row.request.customerId,
        entityLabel: row.customerName,
        before: { request: `DSR-${id}`, kind: row.request.kind, status: row.request.status },
        after: { request: `DSR-${id}`, status: changed.status, ...(note === '' ? {} : { note }) },
      });
      return viewOf({ ...row, request: changed });
    });
  }

  /**
   * Closes the customer's waiting requests of a kind because the work was done: an export was downloaded, or the customer was
   * anonymized.
   *
   * Why: ANSWERS customers Q4: an export closes the open or in-progress export request, an anonymization the erasure request, both
   * `completed` with the time and the staff member. With no waiting request the action still runs.
   *
   * @param tx the caller's transaction
   * @param customerId the customer
   * @param kind which kind to close
   * @param staffId the staff member who acted
   * @returns the ids of the requests that were closed
   */
  async completePending(tx: DbExecutor, customerId: number, kind: DataRequestKind, staffId: number): Promise<number[]> {
    const closed = await completePendingRequests(tx, customerId, kind, staffId, this.clock.now());
    return closed.map((request) => request.id);
  }

  /**
   * Records a customer's request.
   *
   * @param customerId the signed-in customer
   * @param kind `export` or `erasure`
   * @returns the new request, or the one already waiting for an answer
   */
  async request(customerId: number, kind: DataRequestKind): Promise<MyRequestView> {
    const now = this.clock.now();
    return this.db.runInTransaction(async ({ tx }) => {
      // Two taps on the button at once must make one request: serialise per customer and kind.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`data_request:${customerId}:${kind}`}, 0))`);
      const waiting = await findPendingRequest(tx, customerId, kind);
      if (waiting) return mineOf(waiting);
      const created = await insertDataRequest(tx, {
        customerId,
        kind,
        status: 'open',
        requestedAt: now,
        dueAt: dueDateOf(now),
        createdAt: now,
        updatedAt: now,
      });
      return mineOf(created);
    });
  }
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No data request with this id.' });
}
