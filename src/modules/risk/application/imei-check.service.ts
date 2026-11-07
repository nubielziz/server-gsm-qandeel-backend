// ImeiCheckService: the storefront IMEI check (feature 14a, stage 14): checksum, TAC lookup and the encrypted and hashed record of
// every check. The blacklist and lock lookup through a supplier is stage 18.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { EncryptionService, TokenService } from '../../../infra/crypto';
import { TacDirectory, type TacRef } from '../../catalog';
import { StorefrontQuotes } from '../../storefront';
import type { ImeiCheck, ImeiCheckSource } from '../db/schema';
import { IMEI_CHECK_AAD, basicResult, imeiHashInput, readImei } from '../domain/imei-check';
import { insertCheck } from '../infra/imei-check.repository';

/** What the route hands in: the typed IMEI, the optional service, and what the request knows about the visitor. */
export interface ImeiCheckRequest {
  readonly imei: string;
  readonly serviceId?: number | undefined;
  /** The visitor's address (decision 018's trusted proxy address). */
  readonly ip: string;
  /** The country a trusted proxy reported, or `null` (RESOLUTIONS b2c-3). */
  readonly country: string | null;
}

/** What the check found, as the route answers. */
export interface ImeiCheckOutcome {
  readonly imei: string;
  readonly status: ImeiCheck['status'];
  readonly checks: { readonly checksum: 'valid'; readonly tac: 'known' | 'unknown' };
  readonly device: TacRef | null;
  readonly cached: boolean;
  readonly checkedAt: string;
}

/**
 * Runs the IMEI check of the storefront.
 *
 * Why: the map's `POST /store/v1/imei/check` (stage 14): the checksum and the TAC are decided here, from the buyer's own input;
 * what the supplier would say about blacklist and lock is stage 18, so a check says `unknown` for status. The IMEI is personal
 * data: it is stored only as AES-GCM text (`imei_enc`) with a keyed hash (`imei_hash`, decision 019), and never appears in a log
 * line, an error or a metric. Every check writes its own row and is never answered from another visitor's check: the basic check
 * costs nothing to run again, and reusing a stored result would tell a stranger that, and when, someone else checked the same
 * IMEI. `cached_until` and `cached: true` belong to the paid supplier check of stage 18.
 *
 * Side effects: inserts one `imei_checks` row per check.
 */
@Injectable()
export class ImeiCheckService {
  constructor(
    private readonly db: DbService,
    private readonly tacs: TacDirectory,
    private readonly quotes: StorefrontQuotes,
    private readonly encryption: EncryptionService,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Checks an IMEI.
   *
   * @param request the typed IMEI, the optional service and the visitor's address and country
   * @returns the outcome: checksum, TAC lookup and the device (`cached` is always false for this check)
   * @throws {AppError} `INVALID_IMEI` (on `imei`) when the length, the digits or the Luhn check digit are wrong;
   *   `VALIDATION_FAILED` (on `serviceId`) when the service is not one the shop sells (not sellable, or no listing switched on)
   */
  async check(request: ImeiCheckRequest): Promise<ImeiCheckOutcome> {
    const reading = readImei(request.imei);
    if (!reading.ok) {
      throw new AppError('INVALID_IMEI', {
        detail: 'This is not a valid IMEI. Check the 15 digits (dial *#06# on the phone).',
        errors: [{ field: 'imei', code: 'invalid_imei', message: 'Enter a valid 15-digit IMEI.' }],
      });
    }
    const db = this.db.db;
    if (request.serviceId !== undefined) await this.assertSellable(request.serviceId);

    const now = this.clock.now();
    const imeiHash = this.tokens.hash(imeiHashInput(reading.imei));
    const tac = await this.tacs.find(db, reading.tac);

    const source: ImeiCheckSource = request.serviceId === undefined ? 'storefront_free' : 'pre_order';
    const row = await insertCheck(db, {
      imeiHash,
      imeiEnc: this.encryption.encrypt(reading.imei, IMEI_CHECK_AAD),
      tac: tac?.tac ?? null,
      brand: tac?.brand ?? '',
      model: tac?.model ?? '',
      country: request.country,
      checkType: 'basic',
      status: 'unknown',
      result: basicResult(tac !== undefined),
      serviceId: request.serviceId ?? null,
      source,
      ip: request.ip,
      cachedUntil: null,
      // Business times come from the injected clock, not the column default (decision 031).
      createdAt: now,
      updatedAt: now,
    });
    return outcomeOf(reading.imei, row, tac);
  }

  /**
   * A pre-order check names a service the shop sells (sellable for the retail group and with a switched-on listing, the same
   * rule as the public catalog and the checkout); anything else is the buyer's input error.
   */
  private async assertSellable(serviceId: number): Promise<void> {
    const db = this.db.db;
    const retailGroupId = await this.quotes.retailGroupId(db);
    const sellable =
      retailGroupId === undefined
        ? undefined
        : (await this.quotes.listedSellable(db, [serviceId], retailGroupId)).get(serviceId);
    if (!sellable) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'serviceId', code: 'not_available', message: 'This service is not available.' }],
      });
    }
  }
}

function outcomeOf(imei: string, row: ImeiCheck, tac: TacRef | undefined): ImeiCheckOutcome {
  return {
    imei,
    status: row.status,
    checks: { checksum: 'valid', tac: tac === undefined ? 'unknown' : 'known' },
    device: tac ?? null,
    cached: false,
    checkedAt: row.createdAt.toISOString(),
  };
}
