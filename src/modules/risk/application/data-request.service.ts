// DataRequestService: the data-subject requests (GET/PATCH /admin/data-requests, POST /store/v1/me/data-export and /data-delete, map
// domain K, stage 18, RESOLUTIONS b2c-13, ANSWERS customers Q4, Q5 and Q12, decision 064): an account asks, staff move the request along
// before its 30-day deadline.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import { AccountDirectory, sessionStateOf } from '../../identity';
import { AuditService } from '../../platform';
import type { DataRequest, DataRequestKind, DataRequestStatus } from '../db/schema';
import { type MoveTarget, dueDateOf, refuseMove, refuseOwnRequest } from '../domain/data-requests';
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
  /** The account the request is about (any rank; a merchant's number is its account number). */
  readonly accountId: number;
  readonly kind: DataRequestKind;
  readonly status: DataRequestStatus;
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly completedAt: string | null;
  readonly handledBy: number | null;
  readonly fileId: number | null;
  readonly createdAt: string;
  readonly accountName: string;
}

/** What the account's own request answers. */
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
    accountId: r.accountId,
    kind: r.kind,
    status: r.status,
    requestedAt: r.requestedAt.toISOString(),
    dueAt: r.dueAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    handledBy: r.handledBy,
    fileId: r.fileId,
    createdAt: r.createdAt.toISOString(),
    accountName: row.accountName,
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
 * Why: the privacy law gives a person the right to a copy of their data and to its erasure, and the shop 30 days to answer. An account
 * of any rank asks for a copy (`POST /store/v1/me/data-export`); only the retail rank asks for erasure (`POST /store/v1/me/data-delete`):
 * a merchant rank is told to ask staff for the move to the retail rank first, and nothing is stored. Asking again while a request
 * of the same kind is still open returns that request instead of a second one. Staff see them in the console with the deadline and move
 * them: open to in progress, completed or rejected; a rejection needs a note (stored on the request and in the audit row); a closed
 * request cannot move (`409 REQUEST_CLOSED`); an erasure request is completed by anonymizing the account, not by hand (`409
 * ERASURE_NOT_DONE`), and an export request by downloading the export or by hand.
 *
 * Side effects: `request` locks the account row and inserts a `data_requests` row (the row lock serialises the taps of one account, so
 * two at once make one request); `move` updates the request and writes an `audit_logs` row.
 */
@Injectable()
export class DataRequestService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly accounts: AccountDirectory,
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
        accountAnonymized: row.accountStatus === 'anonymized',
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
        entityType: 'account',
        entityId: row.request.accountId,
        entityLabel: row.accountName,
        before: { request: `DSR-${id}`, kind: row.request.kind, status: row.request.status },
        after: { request: `DSR-${id}`, status: changed.status, ...(note === '' ? {} : { note }) },
      });
      return viewOf({ ...row, request: changed });
    });
  }

  /**
   * Closes the account's waiting requests of a kind because the work was done: an export was downloaded, or the account was
   * anonymized.
   *
   * Why: ANSWERS customers Q4: an export closes the open or in-progress export request, an anonymization the erasure request, both
   * `completed` with the time and the staff member. With no waiting request the action still runs.
   *
   * @param tx the caller's transaction
   * @param accountId the account (any rank)
   * @param kind which kind to close
   * @param staffId the staff member who acted
   * @returns the ids of the requests that were closed
   */
  async completePending(tx: DbExecutor, accountId: number, kind: DataRequestKind, staffId: number): Promise<number[]> {
    const closed = await completePendingRequests(tx, accountId, kind, staffId, this.clock.now());
    return closed.map((request) => request.id);
  }

  /**
   * Records an account's own request.
   *
   * Why: decision 064: every rank may ask for a copy; only the retail rank may ask for erasure. The account row is locked first
   * (the first lock of every path of an account), so the rank and the status are read as they are now: a rank change that ended just before
   * is seen, and two taps of the button at once queue on the row and make one request.
   *
   * @param accountId the signed-in account
   * @param kind `export` or `erasure`
   * @returns the new request, or the one already waiting for an answer
   * @throws {AppError} `UNAUTHORIZED` (401: no such login account, or it is erased), `ACCOUNT_SUSPENDED` (403), `CONFLICT` (409: an
   *   erasure asked by a merchant rank; nothing is stored)
   */
  async request(accountId: number, kind: DataRequestKind): Promise<MyRequestView> {
    const now = this.clock.now();
    return this.db.runInTransaction(async ({ tx }) => {
      const account = await this.accounts.lockForUpdate(tx, accountId);
      if (!account?.hasAccount) throw new AppError('UNAUTHORIZED');
      const state = sessionStateOf(account.status);
      if (state === 'gone') throw new AppError('UNAUTHORIZED');
      if (state === 'suspended') throw new AppError('ACCOUNT_SUSPENDED');
      const refusal = refuseOwnRequest(kind, account.rankKind);
      if (refusal !== undefined) throw new AppError('CONFLICT', { detail: refusal });
      const waiting = await findPendingRequest(tx, accountId, kind);
      if (waiting) return mineOf(waiting);
      const created = await insertDataRequest(tx, {
        accountId,
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
