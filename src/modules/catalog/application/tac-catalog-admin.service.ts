// The TAC catalog routes' use cases (map stage 14, routes /admin/tac-catalog): list, read, add and correct an entry, each write
// audited. The TAC is the first 8 digits of an IMEI: the storefront's IMEI check (feature 14a) reads it to name the device.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { TacEntrySchema } from '../contracts/tac-catalog.contracts';
import type { TacCatalogEntry } from '../db/schema';
import { checkReleaseYear, tacInUseMessage, wireReleaseYear } from '../domain/tac-input';
import { imeiChecksUsingTac } from '../infra/tac-foreign-reads.repository';
import {
  type TacSortField,
  findTacByTac,
  findTacEntry,
  insertTacEntry,
  listTacRows,
  updateTacRow,
} from '../infra/tac-catalog.repository';

/** A TAC entry on the wire. */
export type WireTacEntry = z.output<typeof TacEntrySchema>;

/** The fields of a new entry. */
export interface CreateTacInput {
  readonly tac: string;
  readonly brand: string;
  readonly model: string;
  readonly marketingName?: string | undefined;
  readonly releaseYear?: number | undefined;
}

/** The fields a correction may carry. */
export type UpdateTacInput = Partial<CreateTacInput>;

const TAC_UNIQUE_INDEX = 'tac_catalog_tac_uq';

const notFound = () => new AppError('NOT_FOUND', { detail: 'No TAC entry has this id.' });

const tacTaken = (tac: string) => {
  const message = `The TAC ${tac} is already in the catalog.`;
  return new AppError('TAC_TAKEN', { detail: message, errors: [{ field: 'tac', code: 'taken', message }] });
};

/** The audit snapshot of an entry: what staff change. */
function snapshotOf(row: TacCatalogEntry): Record<string, unknown> {
  return {
    tac: row.tac,
    brand: row.brand,
    model: row.model,
    marketingName: row.marketingName,
    releaseYear: wireReleaseYear(row.releaseYear),
  };
}

/**
 * Reads and changes TAC entries.
 *
 * Why: the TAC catalog tab of the Storefront page (RULES storefront, catalog-7, catalog-8). A TAC appears once (`409 TAC_TAKEN`
 * on `tac`); a TAC an IMEI check already used keeps its value (`422` on `tac`), because the check's TAC is history; the release
 * year follows the clock's year and an unknown year is stored null and sent as 0.
 *
 * Side effects: `create` and `update` write `tac_catalog` and one audit row each.
 */
@Injectable()
export class TacCatalogAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists TAC entries.
   *
   * @param query the parsed list request
   * @returns the page and the number matching the filters
   */
  async list(query: ParsedListQuery<TacSortField>): Promise<{ rows: WireTacEntry[]; total: number }> {
    const { rows, total } = await listTacRows(this.db.db, query);
    return { rows: rows.map(toWire), total };
  }

  /**
   * Reads one entry.
   *
   * @param id the entry id
   * @returns the entry
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async get(id: number): Promise<WireTacEntry> {
    const row = await findTacEntry(this.db.db, id);
    if (!row) throw notFound();
    return toWire(row);
  }

  /**
   * Adds an entry.
   *
   * @param input the cleaned fields
   * @returns the new entry
   * @throws {AppError} `VALIDATION_FAILED` (422 on `releaseYear`), `TAC_TAKEN` (409 on `tac`)
   */
  async create(input: CreateTacInput): Promise<WireTacEntry> {
    const now = this.clock.now();
    this.assertYear(input.releaseYear, now);
    const row = await this.db
      .runInTransaction(async ({ tx }) => {
        if (await findTacByTac(tx, input.tac)) throw tacTaken(input.tac);
        const created = await insertTacEntry(tx, {
          tac: input.tac,
          brand: input.brand,
          model: input.model,
          marketingName: input.marketingName ?? '',
          releaseYear: input.releaseYear ?? null,
          source: 'manual',
          createdAt: now,
          updatedAt: now,
        });
        await this.audit.record(tx, {
          action: 'added TAC entry',
          entityType: 'tac_entry',
          entityId: created.id,
          entityLabel: `${created.tac} ${created.brand} ${created.model}`,
          after: snapshotOf(created),
        });
        return created;
      })
      .catch((error: unknown) => {
        // Two requests with the same TAC at once: the unique constraint is the last word.
        if (isUniqueViolation(error, TAC_UNIQUE_INDEX)) throw tacTaken(input.tac);
        throw error;
      });
    return toWire(row);
  }

  /**
   * Corrects an entry.
   *
   * @param id the entry id
   * @param input the fields to change
   * @returns the entry after the change
   * @throws {AppError} `NOT_FOUND` (404), `VALIDATION_FAILED` (422 on `releaseYear`, or on `tac` when IMEI checks use the old
   *   one), `TAC_TAKEN` (409 on `tac`)
   */
  async update(id: number, input: UpdateTacInput): Promise<WireTacEntry> {
    const now = this.clock.now();
    this.assertYear(input.releaseYear, now);
    const row = await this.db
      .runInTransaction(async ({ tx }) => {
        const current = await findTacEntry(tx, id, true);
        if (!current) throw notFound();
        const changes: Partial<TacCatalogEntry> = {};
        if (input.tac !== undefined && input.tac !== current.tac) {
          const used = await imeiChecksUsingTac(tx, current.tac);
          if (used > 0) {
            const message = tacInUseMessage(used, current.tac);
            throw new AppError('VALIDATION_FAILED', {
              detail: message,
              errors: [{ field: 'tac', code: 'in_use', message }],
            });
          }
          if (await findTacByTac(tx, input.tac)) throw tacTaken(input.tac);
          changes.tac = input.tac;
        }
        if (input.brand !== undefined) changes.brand = input.brand;
        if (input.model !== undefined) changes.model = input.model;
        if (input.marketingName !== undefined) changes.marketingName = input.marketingName;
        if (input.releaseYear !== undefined) changes.releaseYear = input.releaseYear;
        const updated =
          Object.keys(changes).length > 0 ? await updateTacRow(tx, id, { ...changes, updatedAt: now }) : current;
        await this.audit.record(tx, {
          action: 'edited TAC entry',
          entityType: 'tac_entry',
          entityId: id,
          entityLabel: `${updated.tac} ${updated.brand} ${updated.model}`,
          before: snapshotOf(current),
          after: snapshotOf(updated),
        });
        return updated;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, TAC_UNIQUE_INDEX) && input.tac !== undefined) throw tacTaken(input.tac);
        throw error;
      });
    return toWire(row);
  }

  private assertYear(year: number | undefined, now: Date): void {
    if (year === undefined) return;
    const problem: FieldError | undefined = checkReleaseYear(year, now.getUTCFullYear());
    if (problem) throw new AppError('VALIDATION_FAILED', { detail: problem.message, errors: [problem] });
  }
}

function toWire(row: TacCatalogEntry): WireTacEntry {
  return {
    id: row.id,
    tac: row.tac,
    brand: row.brand,
    model: row.model,
    marketingName: row.marketingName,
    releaseYear: wireReleaseYear(row.releaseYear),
    source: row.source,
  };
}
