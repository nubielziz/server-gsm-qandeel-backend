// SupplierConnectionService: the two staff actions that talk to a supplier (stage 6): test the connection and sync now.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { findSupplier, updateSupplier } from '../infra/supplier.repository';
import { SupplierClient } from './supplier-client';
import { type SyncResult, writeCallLog } from './supplier-sync';
import { SYNC_WAIT_MARGIN_MS, SupplierSyncRequests } from './supplier-sync-requests';

/** What `POST /admin/suppliers/:id/test` answers. */
export interface TestResult {
  readonly ok: boolean;
  readonly message: string;
  readonly httpStatus: number | null;
  readonly durationMs: number | null;
  readonly accountName: string | null;
  readonly balance: string | null;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No supplier has this id.' });

/**
 * Tests a supplier connection and syncs a supplier on staff's request.
 *
 * Why: orders-suppliers-6 and the test route's rule: a failure on the supplier's side is an answer (`ok: false` with a readable
 * message), never a problem; the sync waits for the worker's job and answers its counts, `409 SUPPLIER_UNAVAILABLE` when the supplier
 * failed during it, `504 SUPPLIER_TIMEOUT` when the wait ran out while the job goes on.
 *
 * Side effects: `test` calls `accountinfo`, writes a `supplier_api_logs` row, the supplier's balance when it worked, and an audit row;
 * `sync` queues a job (which writes the services, the balance and the logs) and writes an audit row.
 */
@Injectable()
export class SupplierConnectionService {
  constructor(
    private readonly db: DbService,
    private readonly client: SupplierClient,
    private readonly audit: AuditService,
    private readonly syncs: SupplierSyncRequests,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Tests the connection with `accountinfo`.
   *
   * @param id the supplier id
   * @returns whether it worked and what the supplier said
   * @throws {AppError} `NOT_FOUND`
   */
  async test(id: number): Promise<TestResult> {
    const supplier = await findSupplier(this.db.db, id);
    if (!supplier) throw notFound();
    const call = await this.client.accountInfo(supplier);
    await this.db.runInTransaction(async ({ tx }) => {
      await writeCallLog(tx, supplier.id, null, call.record, this.clock.now());
      if (call.ok) {
        await updateSupplier(tx, supplier.id, { balance: call.value.credit, balanceCheckedAt: this.clock.now() });
      }
      await this.audit.record(tx, {
        action: call.ok ? 'tested connection to' : 'tested connection to (failed)',
        entityType: 'supplier',
        entityId: supplier.id,
        entityLabel: supplier.name,
        after: { ok: call.ok, httpStatus: call.record.httpStatus, error: call.record.error },
      });
    });
    const httpStatus = call.record.httpStatus === 0 ? null : call.record.httpStatus;
    if (!call.ok) {
      return {
        ok: false,
        message: call.message,
        httpStatus,
        durationMs: call.record.durationMs,
        accountName: null,
        balance: null,
      };
    }
    return {
      ok: true,
      message: `Connected: balance ${call.value.credit} ${call.value.currency ?? supplier.currency}`,
      httpStatus,
      durationMs: call.record.durationMs,
      accountName: call.value.mail,
      balance: call.value.credit,
    };
  }

  /**
   * Syncs the supplier's services and balance now.
   *
   * @param id the supplier id
   * @returns the counts and the balance
   * @throws {AppError} `NOT_FOUND`, `SUPPLIER_DISABLED`, `SUPPLIER_UNAVAILABLE`, `SUPPLIER_TIMEOUT`
   */
  async sync(id: number): Promise<SyncResult> {
    const supplier = await findSupplier(this.db.db, id);
    if (!supplier) throw notFound();
    if (supplier.status === 'disabled') {
      throw new AppError('SUPPLIER_DISABLED', { detail: `${supplier.name} is disabled: enable it to sync.` });
    }
    const answer = await this.syncs.request(id, supplier.timeoutMs + SYNC_WAIT_MARGIN_MS);
    if (answer.state === 'waiting') {
      throw new AppError('SUPPLIER_TIMEOUT', {
        detail: 'The sync is taking longer than expected and continues in the background; refresh in a minute.',
      });
    }
    const { outcome } = answer;
    if (!outcome.ok) throw new AppError(outcome.code, { detail: outcome.detail });
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, {
        action: 'synced services from',
        entityType: 'supplier',
        entityId: supplier.id,
        entityLabel: supplier.name,
        after: {
          services: outcome.result.services,
          added: outcome.result.added,
          changed: outcome.result.changed,
          removed: outcome.result.removed,
        },
      }),
    );
    return outcome.result;
  }
}
