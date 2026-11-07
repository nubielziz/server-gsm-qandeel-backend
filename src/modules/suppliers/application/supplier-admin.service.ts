// SupplierAdminService: the use cases of `/admin/suppliers` (stage 6): add, change and delete a supplier. Rules: a name is unique ignoring
// case, the key is stored encrypted with a hint, the parameter format follows the driver, and a supplier anything refers to is never
// deleted (resolutions orders-suppliers-4, -8, -9).
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor, isUniqueViolation } from '../../../infra/db';
import { EncryptionService } from '../../../infra/crypto';
import { OrderSupplierMoves } from '../../orders';
import { AuditService } from '../../platform';
import { type Supplier, type SupplierDriver, type SupplierParamFormat, type SupplierStatus } from '../db/schema';
import {
  insertSupplier,
  lockSupplier,
  supplierBlockers,
  supplierNameTaken,
  updateSupplier,
  deleteSupplierRow,
} from '../infra/supplier.repository';
import { SUPPLIER_KEY_AAD } from './supplier-client';
import { type SupplierDetailView, SupplierReader } from './supplier-reader';

/** The fields of `POST /admin/suppliers`. */
export interface CreateSupplierInput {
  readonly name: string;
  readonly driver: string;
  readonly baseUrl: string;
  readonly username: string;
  readonly apiKey: string;
  readonly currency: string;
  readonly lowBalanceAlert?: string | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly rateLimitPerMin?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

/** The fields `PATCH /admin/suppliers/:id` may change. */
export type UpdateSupplierInput = Partial<CreateSupplierInput> & { readonly status?: SupplierStatus | undefined };

/** How many characters of the key the console is shown. */
const KEY_HINT_LENGTH = 5;

const PARAM_FORMATS: Readonly<Record<SupplierDriver, SupplierParamFormat>> = { dhru: 'dhru_xml', rest: 'json' };

function invalid(field: string, message: string, code = 'invalid'): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
}

const nameTaken = () => invalid('name', 'A supplier with this name already exists.', 'duplicate');
const notFound = () => new AppError('NOT_FOUND', { detail: 'No supplier has this id.' });

/** The address without trailing slashes (`https://host/`). */
const cleanUrl = (url: string): string => url.replace(/\/+$/, '');

/** What the audit trail keeps of a supplier: never the key, only its hint. */
const snapshot = (supplier: Supplier) => ({
  name: supplier.name,
  driver: supplier.driver,
  baseUrl: supplier.baseUrl,
  username: supplier.username,
  apiKeyHint: supplier.apiKeyHint,
  currency: supplier.currency,
  status: supplier.status,
  lowBalanceAlert: supplier.lowBalanceAlert,
  maxConcurrency: supplier.maxConcurrency,
  rateLimitPerMin: supplier.rateLimitPerMin,
  timeoutMs: supplier.timeoutMs,
});

/** The audit verb phrase of a change: the switch has its own words, anything else is an edit. */
function changeVerb(before: Supplier, after: Supplier, keys: readonly string[]): string {
  if (keys.length === 1 && keys[0] === 'status') {
    if (after.status === 'paused') return 'paused supplier';
    if (after.status === 'disabled') return 'disabled supplier';
    return before.status === 'paused' ? 'resumed supplier' : 'enabled supplier';
  }
  return 'edited supplier';
}

/**
 * Manages supplier connections.
 *
 * Why: orders-suppliers-9: server defaults for what the console leaves out, `driver` is `dhru` or `rest` (422 on the field), the
 * parameter format is derived from it; orders-suppliers-4: the key is AES-GCM text with a key id and `api_key_hint` is its first 5
 * characters, written together, never decrypted on read; orders-suppliers-8: delete is refused with `SUPPLIER_IN_USE` while an
 * order, a service link, an order call log row or an IMEI check refers to the supplier, and otherwise removes the logs of its
 * tests and syncs with it.
 *
 * Side effects: writes `suppliers` (and, on delete, `supplier_api_logs`) and `audit_logs` (entity `supplier`; the key is never in them).
 */
@Injectable()
export class SupplierAdminService {
  constructor(
    private readonly db: DbService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly orders: OrderSupplierMoves,
    private readonly reader: SupplierReader,
  ) {}

  /**
   * Adds a supplier.
   *
   * @param input the console's fields
   * @returns the new supplier's detail (active, balance 0, no history or links)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `name` for a name already used, on `driver`)
   */
  async create(input: CreateSupplierInput): Promise<SupplierDetailView> {
    const driver = this.driverOf(input.driver);
    return this.db.runInTransaction(async ({ tx }) => {
      if (await supplierNameTaken(tx, input.name)) throw nameTaken();
      let supplier: Supplier;
      try {
        supplier = await insertSupplier(tx, {
          name: input.name,
          driver,
          baseUrl: cleanUrl(input.baseUrl),
          username: input.username,
          apiKeyEnc: this.encryption.encrypt(input.apiKey, SUPPLIER_KEY_AAD),
          apiKeyHint: input.apiKey.slice(0, KEY_HINT_LENGTH),
          paramFormat: PARAM_FORMATS[driver],
          currency: input.currency,
          ...(input.lowBalanceAlert === undefined ? {} : { lowBalanceAlert: input.lowBalanceAlert }),
          ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
          ...(input.rateLimitPerMin === undefined ? {} : { rateLimitPerMin: input.rateLimitPerMin }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
      await this.audit.record(tx, {
        action: 'added supplier',
        entityType: 'supplier',
        entityId: supplier.id,
        entityLabel: supplier.name,
        after: snapshot(supplier),
      });
      return (await this.reader.detail(supplier.id, tx))!;
    });
  }

  /**
   * Changes a supplier.
   *
   * @param id the supplier id
   * @param changes the keys to change
   * @returns the updated supplier's detail
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `name` for a name already used, on `driver`)
   */
  async update(id: number, changes: UpdateSupplierInput): Promise<SupplierDetailView> {
    const driver = changes.driver === undefined ? undefined : this.driverOf(changes.driver);
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await lockSupplier(tx, id);
      if (!before) throw notFound();
      if (changes.name !== undefined && (await supplierNameTaken(tx, changes.name, id))) throw nameTaken();
      let after: Supplier | undefined;
      try {
        after = await updateSupplier(tx, id, {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(driver === undefined ? {} : { driver, paramFormat: PARAM_FORMATS[driver] }),
          ...(changes.baseUrl === undefined ? {} : { baseUrl: cleanUrl(changes.baseUrl) }),
          ...(changes.username === undefined ? {} : { username: changes.username }),
          ...(changes.apiKey === undefined
            ? {}
            : {
                apiKeyEnc: this.encryption.encrypt(changes.apiKey, SUPPLIER_KEY_AAD),
                apiKeyHint: changes.apiKey.slice(0, KEY_HINT_LENGTH),
              }),
          ...(changes.currency === undefined ? {} : { currency: changes.currency }),
          ...(changes.lowBalanceAlert === undefined ? {} : { lowBalanceAlert: changes.lowBalanceAlert }),
          ...(changes.maxConcurrency === undefined ? {} : { maxConcurrency: changes.maxConcurrency }),
          ...(changes.rateLimitPerMin === undefined ? {} : { rateLimitPerMin: changes.rateLimitPerMin }),
          ...(changes.timeoutMs === undefined ? {} : { timeoutMs: changes.timeoutMs }),
          ...(changes.status === undefined ? {} : { status: changes.status }),
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
      const keys = Object.entries(changes)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
      await this.audit.record(tx, {
        action: changeVerb(before, after!, keys),
        entityType: 'supplier',
        entityId: id,
        entityLabel: after!.name,
        before: snapshot(before),
        after: snapshot(after!),
      });
      return (await this.reader.detail(id, tx))!;
    });
  }

  /**
   * Deletes a supplier nothing refers to.
   *
   * @param id the supplier id
   * @throws {AppError} `NOT_FOUND`; `SUPPLIER_IN_USE` (409) with what still refers to it
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const supplier = await lockSupplier(tx, id);
      if (!supplier) throw notFound();
      await this.assertUnused(tx, supplier);
      await deleteSupplierRow(tx, id);
      await this.audit.record(tx, {
        action: 'deleted supplier',
        entityType: 'supplier',
        entityId: id,
        entityLabel: supplier.name,
        before: snapshot(supplier),
      });
    });
  }

  /** Refuses the delete with the most useful reason first: open orders, order history, links, call history, IMEI checks. */
  private async assertUnused(tx: DbExecutor, supplier: Supplier): Promise<void> {
    const usage = await this.orders.usageOf(tx, supplier.id);
    const blockers = await supplierBlockers(tx, supplier.id);
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    let detail: string | undefined;
    if (usage.open > 0) {
      detail = `${supplier.name} has ${plural(usage.open, 'open order')}. Disable it instead: it keeps its history.`;
    } else if (usage.total > 0) {
      detail = `${supplier.name} has order history. Disable it instead: it keeps its history.`;
    } else if (blockers.links > 0) {
      detail = `${plural(blockers.links, 'service')} still use ${supplier.name}. Unlink them first.`;
    } else if (blockers.orderCalls > 0) {
      detail = `${supplier.name} has the call history of orders. Disable it instead.`;
    } else if (blockers.imeiChecks > 0) {
      detail = `${supplier.name} was used for IMEI checks. Disable it instead.`;
    }
    if (detail !== undefined) throw new AppError('SUPPLIER_IN_USE', { detail });
  }

  private driverOf(value: string): SupplierDriver {
    if (value === 'dhru' || value === 'rest') return value;
    throw invalid('driver', 'Use dhru or rest.', 'invalid_choice');
  }
}
