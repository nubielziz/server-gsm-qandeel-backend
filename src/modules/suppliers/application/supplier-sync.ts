// SupplierSync: the logic of the supplier-sync jobs (stage 6): the price sync (services and balance of one supplier), the balance check
// and the one-call log writer every supplier call uses. The worker's processors and the staff's `POST /admin/suppliers/:id/sync` (which
// waits for the job) both run `run`; a sync is one transaction and safe to repeat (resolution orders-suppliers-6, user rule 9).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { isMainInputKey, resolvedSupplierKey } from '../../../common/dhru';
import { DbService, type DbExecutor, type TransactionContext, pgErrorInfo } from '../../../infra/db';
import { CatalogPriceVersion, ServiceImporter, recomputeEffectiveCost } from '../../catalog';
import { AuditService } from '../../platform';
import type { Supplier } from '../db/schema';
import { fieldsToRequire, mainInputField } from '../domain/import-plan';
import { supplierMainInput } from '../domain/supplier-main-input';
import { syncCounts } from '../domain/sync-plan';
import {
  type AlignmentCandidate,
  alignmentCandidates,
  liveServiceInfo,
  lockLiveServiceRow,
} from '../infra/foreign-reads.repository';
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
  /**
   * Services this sync brought in line with what their supplier asks for (feature 33), each counted once: an IMEI service made a
   * `server` service with the supplier's main box first (decision 042), fields the supplier requires made required, or both.
   */
  readonly adopted: number;
  readonly balance: string;
  readonly balanceCheckedAt: string;
}

/**
 * Whether the sync may adopt a candidate's main box: it is an `imei` service, its supplier service has a main box, and neither a field
 * (its supplier key, or its key when that is empty) nor the link's field map already names the box `IMEI` (decision 042; the
 * dispatcher's rule, `resolvedSupplierKey`).
 *
 * @param row the candidate as `alignmentCandidates` reads it
 * @returns true when the service should become a server service with the supplier's box first
 */
export function adoptable(row: AlignmentCandidate): boolean {
  if (row.type !== 'imei' || supplierMainInput(row.raw) === null) return false;
  if (row.fields.some((field) => isMainInputKey(resolvedSupplierKey(field)))) return false;
  return !Object.values(row.fieldMap).some((mapped) => typeof mapped === 'string' && isMainInputKey(mapped));
}

/** The audit phrase of an adopted service (`<actor> <action> <entityLabel>`, the system as the actor). */
export const ADOPTED_AUDIT_ACTION = "adopted the supplier's input";

/** The audit phrase of a service whose supplier-required fields were made required (feature 33, the system as the actor). */
export const REQUIRED_AUDIT_ACTION = "made the supplier's required fields required";

/** The fields of a candidate its supplier requires but that are optional (`fieldsToRequire` with the candidate's own data). */
const toRequire = (row: AlignmentCandidate): string[] => fieldsToRequire(row.fields, row.fieldMap, row.customFields);

/** Whether the sync has anything to do for a candidate: adopt its main box, make fields required, or both. */
const needsAlignment = (row: AlignmentCandidate): boolean => adoptable(row) || toRequire(row).length > 0;

/** How a sync ended. A failure is a value, not an exception, so the API can answer with the right code. */
export type SyncOutcome =
  | {
      readonly ok: true;
      readonly result: SyncResult;
      /** Service entries left out of this sync: no id, no name, or no price from 0 to 1000000000 (decision 051). */
      readonly skipped: number;
      /** True when the supplier reported a balance outside -1000000000 to 1000000000, so the stored balance was kept (decision 051). */
      readonly balanceSkipped: boolean;
    }
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

/** The error text of a call log row stored without its bodies (decision 051). */
export const CALL_RECORD_NOT_STORED = 'The record of this call could not be stored in full.';

const callLogger = new Logger('SupplierCallLog');

/**
 * Writes one supplier call to the log without ever failing the caller.
 *
 * Why: decision 051: the call is made and cannot be undone, so a log row that the database refuses (text it cannot hold, for example) must
 * never keep the answer from being recorded on its order. The record is written; when that fails a minimal row is written (the action,
 * status, time and outcome, no bodies, a fixed error text); when that fails too, one error line names the SQLSTATE and the function goes
 * on. For the pool only, never inside a transaction (a failed statement poisons it).
 *
 * @param db the pool (`this.db.db`)
 * @param supplierId the supplier
 * @param orderId the order the call belongs to, or `null` for a test or a sync
 * @param record what the driver left behind
 * @param at the clock's time
 * @param onNotStored called once with the error of the full record when it could not be written, whether or not the minimal row then
 *   was (the dispatch hands it to the error reporter, as it did before decision 051); a hook that throws is ignored
 * @returns the log row's id, or `null` when no row could be written
 */
export async function writeCallLogSafely(
  db: DbExecutor,
  supplierId: number,
  orderId: number | null,
  record: CallRecord,
  at: Date,
  onNotStored?: (error: unknown) => void,
): Promise<number | null> {
  try {
    return await writeCallLog(db, supplierId, orderId, record, at);
  } catch (error) {
    // Retried below with a minimal row. Nothing of the error is logged here (its text may hold the values that were refused); the caller
    // may hand it to its error reporter.
    try {
      onNotStored?.(error);
    } catch {
      // A failing hook must not stop the order path either.
    }
  }
  try {
    return await writeCallLog(
      db,
      supplierId,
      orderId,
      { ...record, request: { action: record.action }, response: null, error: CALL_RECORD_NOT_STORED },
      at,
    );
  } catch (error) {
    callLogger.error(
      `The call log row of supplier ${supplierId}${orderId === null ? '' : ` for order ${orderId}`} could not be written (SQLSTATE ${
        pgErrorInfo(error)?.code ?? 'unknown'
      }).`,
    );
    return null;
  }
}

/**
 * Syncs suppliers.
 *
 * Why: scenario system-alert and user rule 9: the sync reads the supplier's services (`imeiservicelist`) and our balance
 * (`accountinfo`), upserts `supplier_services` (a changed credit sets `price_changed_at`, a service no longer listed becomes
 * unavailable), recomputes the effective cost of every linked service and, when one moved, moves the catalog price version after the
 * commit, so price lists, the price floor and the price change scan follow. Both calls are logged with no order. Nothing is written
 * unless both calls worked. In the same transaction it adopts the supplier's main box (decision 042): an IMEI service made before,
 * whose only active link points at a service of this supplier with a main box that is not an IMEI, becomes a `server` service with
 * that box first (`ServiceImporter.adoptMainInput`); and on every such service (its only active link at this supplier) it makes required
 * the fields the supplier requires that the import made optional (`ServiceImporter.requireFields`, feature 33). A field is never made
 * optional, so a staff member who makes one optional again sees the next sync make it required again.
 *
 * Side effects: two `supplier_api_logs` rows; one transaction that writes `supplier_services`, `suppliers` (balance, check time,
 * `prices_synced_at`), `services` (effective cost; type and category of an adopted one), `service_fields` and `service_categories` (an
 * adoption; `required` of a repaired field), `outbox_events` (`catalog.services_changed` per adoption) and `audit_logs` (when asked, and
 * one row per adoption and one per service whose fields were made required);
 * the catalog price version after the commit.
 *
 * Decision 051: a service whose price is not a number from 0 to 1000000000 is left out of the list (so the sync marks the stored row
 * unavailable), and a balance outside -1000000000 to 1000000000 is not saved (the stored balance stays); each is counted in one warning of
 * the log, and neither stops the sync. The two calls' log rows go through `writeCallLogSafely`.
 */
@Injectable()
export class SupplierSync {
  private readonly logger = new Logger(SupplierSync.name);

  constructor(
    private readonly db: DbService,
    private readonly client: SupplierClient,
    private readonly audit: AuditService,
    private readonly priceVersion: CatalogPriceVersion,
    private readonly importer: ServiceImporter,
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
    await writeCallLogSafely(this.db.db, supplier.id, null, list.record, this.clock.now());
    if (!list.ok) return this.unavailable(supplier, list.message);
    const account = await this.client.accountInfo(supplier);
    await writeCallLogSafely(this.db.db, supplier.id, null, account.record, this.clock.now());
    if (!account.ok) return this.unavailable(supplier, account.message);

    const { services, skipped } = list.value;
    const balance = account.value.credit;
    if (skipped > 0) {
      this.logger.warn(
        `Supplier ${supplier.id}: ${skipped} service ${skipped === 1 ? 'entry was' : 'entries were'} left out of the sync (no id, no name, or no price from 0 to 1000000000).`,
      );
    }
    if (balance === null) {
      this.logger.warn(
        `Supplier ${supplier.id} reported a balance outside -1000000000 to 1000000000; the stored balance is kept.`,
      );
    }

    const now = this.clock.now();
    const done = await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const locked = await lockSupplier(tx, supplier.id);
      if (!locked) throw new Error('The supplier disappeared during its sync.');
      const stored = await storedSupplierServices(tx, supplier.id);
      const found = syncCounts(stored, services);
      await upsertSupplierServices(tx, supplier.id, services, now);
      const moved = await recomputeEffectiveCost(tx, await serviceIdsLinkedToSupplier(tx, supplier.id));
      if (moved.length > 0) this.priceVersion.bumpAfterCommit(work);
      const adopted = await this.alignServices(work, supplier.id);
      await updateSupplier(
        tx,
        supplier.id,
        balance === null ? { pricesSyncedAt: now } : { balance, balanceCheckedAt: now, pricesSyncedAt: now },
      );
      if (options.audit) {
        await this.audit.record(tx, {
          action: 'synced services from',
          entityType: 'supplier',
          entityId: supplier.id,
          entityLabel: supplier.name,
          after: { ...found, adopted, balance: balance ?? locked.balance, skipped, balanceSkipped: balance === null },
        });
      }
      return { counts: { ...found, adopted }, balance: locked.balance, balanceCheckedAt: locked.balanceCheckedAt };
    });
    return {
      ok: true,
      result: {
        ...done.counts,
        balance: balance ?? done.balance,
        balanceCheckedAt: (balance === null ? (done.balanceCheckedAt ?? now) : now).toISOString(),
      },
      skipped,
      balanceSkipped: balance === null,
    };
  }

  /**
   * Asks a supplier for our balance and saves it (the 30-minute check).
   *
   * @param supplierId the supplier
   * @returns true when the balance was refreshed (false when the call failed or the supplier reported a balance outside the range)
   */
  async checkBalance(supplierId: number): Promise<boolean> {
    const supplier = await findSupplier(this.db.db, supplierId);
    if (!supplier || supplier.status === 'disabled') return false;
    const account = await this.client.accountInfo(supplier);
    await writeCallLogSafely(this.db.db, supplier.id, null, account.record, this.clock.now());
    if (!account.ok) return false;
    if (account.value.credit === null) {
      this.logger.warn(
        `Supplier ${supplier.id} reported a balance outside -1000000000 to 1000000000; the stored balance is kept.`,
      );
      return false;
    }
    await updateSupplier(this.db.db, supplier.id, {
      balance: account.value.credit,
      balanceCheckedAt: this.clock.now(),
    });
    return true;
  }

  /**
   * Brings the services of this supplier in line with what it asks for, in the sync's transaction (decision 042, feature 33): adopts the
   * main box on the IMEI services made before (brief section 6), then makes required the fields the supplier requires that the import
   * made optional. One audit row per change, each service counted once.
   *
   * @returns how many services changed
   */
  private async alignServices(work: TransactionContext, supplierId: number): Promise<number> {
    const { tx } = work;
    const wanted = (await alignmentCandidates(tx, supplierId)).filter(needsAlignment);
    if (wanted.length === 0) return 0;
    // Locks: the supplier row is held since the start of the sync. `recomputeEffectiveCost` above already updated, and so locked, the
    // linked service rows whose effective cost moved, in no fixed order; here the candidates are locked in id order (a row already
    // held is a no-op). A deadlock with another writer is possible in principle: Postgres aborts one side, and the sync job retries
    // (a staff sync answers an error). Then everything is read again under the locks, so a staff change of the links or the fields
    // (which locks the service row first) either finished before or waits for this commit.
    for (const row of wanted) await lockLiveServiceRow(tx, row.serviceId);
    const candidates = (
      await alignmentCandidates(
        tx,
        supplierId,
        wanted.map((row) => row.serviceId),
      )
    ).filter(needsAlignment);
    let changed = 0;
    let adoptedAny = false;
    for (const row of candidates) {
      let touched = false;
      const main = adoptable(row) ? supplierMainInput(row.raw) : null;
      if (main !== null) {
        const field = mainInputField(main, new Set(row.fields.map((existing) => existing.key)));
        const done = await this.importer.adoptMainInput(tx, { serviceId: row.serviceId, field });
        if (done !== null) {
          touched = true;
          adoptedAny = true;
          await this.audit.record(tx, {
            action: ADOPTED_AUDIT_ACTION,
            entityType: 'service',
            entityId: done.serviceId,
            entityLabel: done.name,
            before: { type: done.before.type, categoryId: done.before.categoryId },
            after: {
              type: done.after.type,
              categoryId: done.after.categoryId,
              field: { key: field.key, label: field.label, supplierKey: field.supplierKey },
            },
          });
        }
      }
      // After an adoption too: the main box field is new and required; the service's other fields keep their keys.
      const raised = await this.importer.requireFields(tx, { serviceId: row.serviceId, keys: toRequire(row) });
      if (raised.length > 0) {
        touched = true;
        await this.audit.record(tx, {
          action: REQUIRED_AUDIT_ACTION,
          entityType: 'service',
          entityId: row.serviceId,
          entityLabel: (await liveServiceInfo(tx, row.serviceId))?.name ?? '',
          before: { optionalFields: raised },
          after: { requiredFields: raised },
        });
      }
      if (touched) changed += 1;
    }
    // A type and a category are what merchants see: cached price lists start over, as after a staff edit. A field's `required` is
    // not (a staff save of the fields moves nothing either).
    if (adoptedAny) this.priceVersion.bumpAfterCommit(work);
    return changed;
  }

  private unavailable(supplier: Supplier, message: string): SyncOutcome {
    return { ok: false, code: 'SUPPLIER_UNAVAILABLE', detail: `${supplier.name} did not take the sync: ${message}` };
  }
}
