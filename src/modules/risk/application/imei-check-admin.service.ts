// ImeiCheckAdminService: the staff log of IMEI checks (GET /admin/imei-checks and /:id, map domain K, stage 18, RESOLUTIONS b2c-3 and
// b2c-4). It decrypts the IMEI while it is stored and shows the mask once it was erased.
import { Injectable, Logger } from '@nestjs/common';
import type { JsonObject, ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { EncryptionService, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { type PermissionHolder, grants } from '../../identity';
import { IMEI_CHECK_AAD, imeiHashInput } from '../domain/imei-check';
import { maskedImei } from '../domain/imei-mask';
import type { ImeiCheck, ImeiCheckSource, ImeiCheckStatus, ImeiCheckType } from '../db/schema';
import {
  type ImeiCheckRow,
  type ImeiCheckSortField,
  findImeiCheckRow,
  imeiSearchCondition,
  listImeiCheckRows,
} from '../infra/imei-check-admin.repository';

/**
 * The permission whose holders read the IMEI digits of the check log.
 *
 * Why: decision 047: the people who decide held orders read the digits; other risk readers read the stored mask (the TAC and bullets).
 */
export const IMEI_DIGITS_PERMISSION = 'risk:decide';

/** A check as the console reads it. */
export interface ImeiCheckView {
  readonly id: number;
  readonly imei: string;
  readonly brand: string;
  readonly model: string;
  readonly checkType: ImeiCheckType;
  readonly status: ImeiCheckStatus;
  readonly source: ImeiCheckSource;
  readonly country: string | null;
  readonly ip: string | null;
  readonly orderId: number | null;
  readonly customer: { readonly id: number; readonly name: string } | null;
  readonly supplier: { readonly id: number; readonly name: string } | null;
  readonly result: JsonObject | null;
  readonly cost: string;
  readonly price: string;
  readonly cachedUntil: string | null;
  readonly createdAt: string;
}

/**
 * Reads the IMEI log for staff.
 *
 * Why: the console's IMEI checks tab. `imei` is the decrypted 15 digits while `imei_enc` is set, and the mask (the TAC and bullets)
 * after the retention job or an anonymization erased it. The IMEI is personal data: it is decrypted only to answer a staff
 * request and never logged. Decision 047: only a caller who holds `risk:decide` gets the digits; for any other caller nothing is decrypted
 * and `imei` is the mask. The filters and the IMEI search stay as they are.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class ImeiCheckAdminService {
  private readonly logger = new Logger(ImeiCheckAdminService.name);

  constructor(
    private readonly db: DbService,
    private readonly encryption: EncryptionService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Lists the checks.
   *
   * @param query the parsed list request; `q` is understood as an IMEI (15 digits), a TAC (8 to 14 digits, or a prefix) or text
   *   matched against brand and model
   * @param caller the signed-in staff member (the digits need `risk:decide`, decision 047)
   * @returns the page and its total
   */
  async list(
    query: ParsedListQuery<ImeiCheckSortField>,
    caller: PermissionHolder,
  ): Promise<{ rows: ImeiCheckView[]; total: number }> {
    const condition = query.search
      ? imeiSearchCondition(query.search.text, (imei) => this.tokens.lookupHash(imeiHashInput(imei)))
      : undefined;
    const page = await listImeiCheckRows(this.db.db, query, { condition });
    const reveal = grants(caller.permissions, IMEI_DIGITS_PERMISSION);
    return { rows: page.rows.map((row) => this.viewOf(row, reveal)), total: page.total };
  }

  /**
   * Reads one check.
   *
   * @param id the check id
   * @param caller the signed-in staff member (the digits need `risk:decide`, decision 047)
   * @returns the check
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async get(id: number, caller: PermissionHolder): Promise<ImeiCheckView> {
    const row = await findImeiCheckRow(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No IMEI check with this id.' });
    return this.viewOf(row, grants(caller.permissions, IMEI_DIGITS_PERMISSION));
  }

  /** Builds the view; without `reveal` the stored mask is used and nothing is decrypted (decision 047). */
  private viewOf(row: ImeiCheckRow, reveal: boolean): ImeiCheckView {
    const { check } = row;
    return {
      id: check.id,
      imei: reveal ? this.imeiOf(check) : maskedImei(check.tac),
      brand: check.brand,
      model: check.model,
      checkType: check.checkType,
      status: check.status,
      source: check.source,
      country: check.country,
      ip: check.ip,
      orderId: row.orderId,
      customer:
        check.customerId === null || row.customerName === null
          ? null
          : { id: check.customerId, name: row.customerName },
      supplier:
        check.supplierId === null || row.supplierName === null
          ? null
          : { id: check.supplierId, name: row.supplierName },
      // A jsonb column only ever holds JSON.
      result: check.result as JsonObject,
      cost: check.cost,
      price: check.price,
      cachedUntil: check.cachedUntil?.toISOString() ?? null,
      createdAt: check.createdAt.toISOString(),
    };
  }

  /** The digits while they are stored; the mask when erased, or when the ciphertext cannot be read (logged without the value). */
  private imeiOf(check: ImeiCheck): string {
    if (check.imeiEnc === null) return maskedImei(check.tac);
    try {
      return this.encryption.decrypt(check.imeiEnc, IMEI_CHECK_AAD);
    } catch {
      this.logger.error(`The stored IMEI of check ${check.id} could not be decrypted.`);
      return maskedImei(check.tac);
    }
  }
}
