// SupplierSync: the logic of the supplier-sync jobs (stage 6): the price sync (services and balance of one supplier), the balance check
// and the one-call log writer every supplier call uses. The worker's processors and the staff's `POST /admin/suppliers/:id/sync` (which
// waits for the job) both run `run`; a sync is one transaction and safe to repeat (resolution orders-suppliers-6, user rule 9).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService, type DbExecutor } from '../../../infra/db';
import { CatalogPriceVersion, recomputeEffectiveCost } from '../../catalog';
import { AuditService } from '../../platform';
import type { Supplier } from '../db/schema';
import { syncCounts } from '../domain/sync-plan';
import { insertLog } from '../infra/supplier-log.repository';
import {
  serviceIdsLinkedToSupplier,
  storedSupplierServices,
  upsertSupplierServices,
} from '../infra/supplier-catalogue.repository';
import { findSupplier, lockSupplier, updateSupplier } from '../infra/supplier.repository';
import { SupplierClient } from './supplier-client';
import type { CallRecord } from './supplier-driver';

/** What a sync did, as `POST /admin/suppliers/:id/sync` answers it. */
export interface SyncResult {
  readonly services: number;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly balance: string;
  readonly balanceCheckedAt: string;
}

/** How a sync ended. A failure is a value, not an exception, so the API can answer with the right code. */
export type SyncOutcome =
  | { readonly ok: true; readonly result: SyncResult }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'SUPPLIER_DISABLED' | 'SUPPLIER_UNAVAILABLE';
      readonly detail: string;
    };

/**
 * Writes one supplier call to `supplier_api_logs`.
 *
 * Why: orders-suppliers-3 and health-commissions-8: every call writes a row with non-null `http_status` (0 without an answer),
 * `duration_ms`, `error` ('' when fine) and the outcome `ok | error | timeout`; the bodies were redacted by the driver.
 *
 * @param db the database or the transaction of the change the call caused
 * @param supplierId the supplier
 * @param orderId the order the call belongs to, or `null` for a test or a sync
 * @param record what the driver left behind
 * @param at the clock's time (decision 031: the windows of the health figures read it)
 * @returns the log row's id
 */
export function writeCallLog(
  db: DbExecutor,
  supplierId: number,
  orderId: number | null,
  record: CallRecord,
  at: Date,
): Promise<number> {
  return insertLog(db, {
    supplierId,
    orderId,
    action: record.action,
    request: record.request,
    response: record.response,
    httpStatus: record.httpStatus,
    durationMs: record.durationMs,
    error: record.error,
    outcome: record.outcome,
    createdAt: at,
  });
}

/**
 * Syncs suppliers.
 *
 * Why: scenario system-alert and user rule 9: the sync reads the supplier's services (`imeiservicelist`) and our balance
 * (`accountinfo`), upserts `supplier_services` (a changed credit sets `price_changed_at`, a service no longer listed becomes
 * unavailable), recomputes the effective cost of every linked service and, when one moved, moves the catalog price version after the
 * commit, so price lists, the price floor and the price change scan follow. Both calls are logged with no order. Nothing is written
 * unless both calls worked.
 *
 * Side effects: two `supplier_api_logs` rows; one transaction that writes `supplier_services`, `suppliers` (balance, check time,
 * `prices_synced_at`), `services` (effective cost) and, when asked, `audit_logs`; the catalog price version after the commit.
 */
@Injectable()
export class SupplierSync {
  constructor(
    private readonly db: DbService,
    private readonly client: SupplierClient,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Syncs one supplier's services and balance.
   *
   * @param supplierId the supplier
   * @param options `audit`: write the audit row (a scheduled run; the staff route writes its own)
   * @returns the counts, or why it failed
   */
  async run(supplierId: number, options: { audit: boolean }): Promise<SyncOutcome> {
    const supplier = await findSupplier(this.db.db, supplierId);
    if (!supplier) return { ok: false, code: 'NOT_FOUND', detail: 'No supplier has this id.' };
    if (supplier.status === 'disabled') {
      return { ok: false, code: 'SUPPLIER_DISABLED', detail: `${supplier.name} is disabled: enable it to sync.` };
    }
    const list = await this.client.serviceList(supplier);
    await writeCallLog(this.db.db, supplier.id, null, list.record, this.clock.now());
    if (!list.ok) return this.unavailable(supplier, list.message);
    const account = await this.client.accountInfo(supplier);
    await writeCallLog(this.db.db, supplier.id, null, account.record, this.clock.now());
    if (!account.ok) return this.unavailable(supplier, account.message);

    const now = this.clock.now();
    const counts = await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const locked = await lockSupplier(tx, supplier.id);
      if (!locked) throw new Error('The supplier disappeared during its sync.');
      const stored = await storedSupplierServices(tx, supplier.id);
      const found = syncCounts(stored, list.value);
      await upsertSupplierServices(tx, supplier.id, list.value, now);
      const moved = await recomputeEffectiveCost(tx, await serviceIdsLinkedToSupplier(tx, supplier.id));
      if (moved.length > 0) this.priceVersion.bumpAfterCommit(work);
      await updateSupplier(tx, supplier.id, {
        balance: account.value.credit,
        balanceCheckedAt: now,
        pricesSyncedAt: now,
      });
      if (options.audit) {
        await this.audit.record(tx, {
          action: 'synced services from',
          entityType: 'supplier',
          entityId: supplier.id,
          entityLabel: supplier.name,
          after: { ...found, balance: account.value.credit },
        });
      }
      return found;
    });
    return { ok: true, result: { ...counts, balance: account.value.credit, balanceCheckedAt: now.toISOString() } };
  }

  /**
   * Asks a supplier for our balance and saves it (the 30-minute check).
   *
   * @param supplierId the supplier
   * @returns true when the balance was refreshed
   */
  async checkBalance(supplierId: number): Promise<boolean> {
    const supplier = await findSupplier(this.db.db, supplierId);
    if (!supplier || supplier.status === 'disabled') return false;
    const account = await this.client.accountInfo(supplier);
    await writeCallLog(this.db.db, supplier.id, null, account.record, this.clock.now());
    if (!account.ok) return false;
    await updateSupplier(this.db.db, supplier.id, {
      balance: account.value.credit,
      balanceCheckedAt: this.clock.now(),
    });
    return true;
  }

  private unavailable(supplier: Supplier, message: string): SyncOutcome {
    return { ok: false, code: 'SUPPLIER_UNAVAILABLE', detail: `${supplier.name} did not take the sync: ${message}` };
  }
}
