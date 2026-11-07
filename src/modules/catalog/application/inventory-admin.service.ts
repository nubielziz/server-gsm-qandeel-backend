// InventoryAdminService: the use cases of the code inventory routes (map domain B, stage 5): the masked list, the import with
// duplicate detection and the void action. A code is stored encrypted with a keyed hash and its last four characters; the clear
// text is never logged, returned or kept after the import call.
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { EncryptionService, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { AppError } from '../../../common/errors';
import { AuditService } from '../../platform';
import type { InventoryCodeStatus } from '../db/schema';
import {
  INVENTORY_CODE_AAD,
  batchRefOf,
  inventoryCodeHashInput,
  lastFour,
  maskedCode,
  prepareCodes,
} from '../domain/inventory-codes';
import { insertCodeRows, listInventoryRows, nextBatchNumber, voidAvailableCodes } from '../infra/inventory.repository';
import { lockLiveService } from '../infra/service.repository';

/** Rows inserted per statement during an import. */
const IMPORT_CHUNK = 1_000;

/** A stocked code as the console reads it. */
export interface InventoryView {
  readonly id: number;
  readonly maskedCode: string;
  readonly serviceId: number;
  readonly service: { id: number; name: string };
  readonly status: InventoryCodeStatus;
  readonly orderId: number | null;
  readonly batchRef: string;
  readonly createdAt: string;
}

/** What an import counted. */
export interface ImportResult {
  readonly imported: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly batchRef: string;
}

/** What a void counted. */
export interface VoidResult {
  readonly voided: number;
  readonly skipped: number;
}

/**
 * Manages the stock of digital codes.
 *
 * Why: some services deliver a pre-bought code (decision 025: reserved at placement, sold on completion). Staff import codes in
 * batches and void unsold ones (RESOLUTIONS catalog-15, MISMATCHES B18, RULES services 9). Each code is AES-GCM encrypted
 * (decision 019, context `inventory_codes.code_enc`) with an HMAC of the code (`code_hash`, domain-separated from every other
 * token) so duplicates are found without decrypting, and its last four characters in clear for the mask. The service row is
 * locked `FOR SHARE` during an import, so a delete (which decides between archive and delete from what refers to it) waits.
 *
 * Side effects: inserts or updates `inventory_codes`, draws from `inventory_batch_ref_seq`, writes `audit_logs` (entity
 * `service`, or `inventory_code` for a void).
 *
 * @see docs/contract/endpoints/catalog.md (the inventory sections)
 */
@Injectable()
export class InventoryAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Lists stocked codes, masked.
   *
   * @param query the parsed list request
   * @returns the page of codes and the exact total
   */
  async list(query: ParsedListQuery<'createdAt' | 'id'>): Promise<{ rows: InventoryView[]; total: number }> {
    const { rows, total } = await listInventoryRows(this.db.db, query);
    return {
      rows: rows.map((row) => ({
        id: row.id,
        maskedCode: maskedCode(row.codeLast4),
        serviceId: row.serviceId,
        service: { id: row.serviceId, name: row.serviceName },
        status: row.status,
        orderId: row.orderId,
        batchRef: row.batchRef,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
    };
  }

  /**
   * Imports codes into a service.
   *
   * @param staffId the staff member who imports (recorded as `created_by`)
   * @param serviceId the service the codes belong to
   * @param input the pasted lines and an optional batch reference
   * @returns how many codes were stored, counted as duplicates and rejected, and the batch reference used
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived service)
   */
  async import(
    staffId: number,
    serviceId: number,
    input: { codes: string[]; batchRef?: string | undefined },
  ): Promise<ImportResult> {
    return this.db.runInTransaction(async ({ tx }) => {
      const service = await lockLiveService(tx, serviceId, 'share');
      if (!service) throw new AppError('NOT_FOUND', { detail: 'No service has this id.' });
      const prepared = prepareCodes(input.codes);
      const batchRef = input.batchRef ?? batchRefOf(await nextBatchNumber(tx));

      let imported = 0;
      for (let start = 0; start < prepared.codes.length; start += IMPORT_CHUNK) {
        const chunk = prepared.codes.slice(start, start + IMPORT_CHUNK).map((code) => ({
          serviceId,
          codeEnc: this.encryption.encrypt(code, INVENTORY_CODE_AAD),
          codeHash: this.hashOf(code),
          codeLast4: lastFour(code),
          status: 'available' as const,
          batchRef,
          createdBy: staffId,
        }));
        imported += await insertCodeRows(tx, chunk);
      }
      const result = {
        imported,
        duplicates: prepared.repeated + (prepared.codes.length - imported),
        rejected: prepared.rejected,
        batchRef,
      };
      await this.audit.record(tx, {
        action: 'imported inventory codes',
        entityType: 'service',
        entityId: serviceId,
        entityLabel: service.name,
        // Counts only: a clear code never reaches the audit log.
        after: { ...result },
      });
      return result;
    });
  }

  /**
   * Voids unsold codes.
   *
   * @param ids the code ids to withdraw
   * @returns how many became void and how many were skipped (reserved, sold, already void or unknown)
   */
  async void(ids: readonly number[]): Promise<VoidResult> {
    const distinct = [...new Set(ids)];
    return this.db.runInTransaction(async ({ tx }) => {
      const voidedIds = await voidAvailableCodes(tx, distinct);
      const result = { voided: voidedIds.length, skipped: distinct.length - voidedIds.length };
      await this.audit.record(tx, {
        action: 'voided inventory codes',
        entityType: 'inventory_code',
        entityLabel: `${result.voided} ${result.voided === 1 ? 'code' : 'codes'}`,
        after: { ...result, voidedIds },
      });
      return result;
    });
  }

  /** The keyed hash of a code (see {@link inventoryCodeHashInput}). */
  private hashOf(code: string): string {
    return this.tokens.hash(inventoryCodeHashInput(code));
  }
}
