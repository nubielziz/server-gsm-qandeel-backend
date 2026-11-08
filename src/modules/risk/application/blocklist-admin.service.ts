// BlocklistAdminService: the staff routes on the blocklist (GET/POST /admin/blocklist, GET/DELETE /admin/blocklist/:id, map domain K,
// stage 18, scenario b2c-chargeback). Every write is audited with the demo's phrases.
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { BlocklistEntry, BlocklistKind } from '../db/schema';
import {
  type AddableBlocklistKind,
  auditBlockDisplay,
  auditBlockLabel,
  normalizeBlockValue,
} from '../domain/blocklist-values';
import {
  type BlocklistRow,
  type BlocklistSortField,
  deleteEntry,
  findBlocklistRow,
  listBlocklistRows,
} from '../infra/blocklist.repository';
import { Blocklist } from './blocklist';

/** An entry as the console reads it: no hash, no `updatedAt`. */
export interface BlocklistEntryView {
  readonly id: number;
  readonly kind: BlocklistKind;
  readonly display: string;
  readonly reason: string;
  readonly expiresAt: string | null;
  readonly source: BlocklistEntry['source'];
  readonly createdBy: { readonly id: number; readonly name: string } | null;
  readonly createdAt: string;
}

/** What `POST /admin/blocklist` carries. */
export interface BlockInput {
  readonly kind: AddableBlocklistKind;
  readonly value: string;
  readonly reason: string;
}

function viewOf(row: BlocklistRow): BlocklistEntryView {
  const { entry } = row;
  return {
    id: entry.id,
    kind: entry.kind,
    display: entry.display,
    reason: entry.reason,
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    source: entry.source,
    createdBy:
      entry.createdBy === null || row.createdByName === null ? null : { id: entry.createdBy, name: row.createdByName },
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * The staff use cases of the blocklist.
 *
 * Why: ANSWERS risk Q4 and B79: `POST` takes a typed value, normalises it, hashes it and derives the display; a duplicate is `409
 * ALREADY_BLOCKED`; any entry, one the system added after a chargeback included, can be removed; both are audited (`added to
 * blocklist`, `removed from blocklist`, entity `blocklist`, label `<kind> <display>`).
 *
 * Side effects: `create` inserts a `blocklist_entries` row and an `audit_logs` row; `remove` deletes the row and audits it.
 */
@Injectable()
export class BlocklistAdminService {
  constructor(
    private readonly db: DbService,
    private readonly blocklist: Blocklist,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists the entries.
   *
   * @param query the parsed list request
   * @returns the page and its total
   */
  async list(query: ParsedListQuery<BlocklistSortField>): Promise<{ rows: BlocklistEntryView[]; total: number }> {
    const page = await listBlocklistRows(this.db.db, query);
    return { rows: page.rows.map(viewOf), total: page.total };
  }

  /**
   * Reads one entry.
   *
   * @param id the entry id
   * @returns the entry
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async get(id: number): Promise<BlocklistEntryView> {
    const row = await findBlocklistRow(this.db.db, id);
    if (!row) throw notFound();
    return viewOf(row);
  }

  /**
   * Adds a manual entry.
   *
   * @param staffId the signed-in staff member
   * @param input the kind, the typed value and the reason
   * @returns the new entry
   * @throws {AppError} `VALIDATION_FAILED` (422, on `value`), `ALREADY_BLOCKED` (409)
   */
  async create(staffId: number, input: BlockInput): Promise<BlocklistEntryView> {
    const value = normalizeBlockValue(input.kind, input.value);
    if (!value.ok) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'value', code: 'invalid_value', message: value.message }],
      });
    }
    return this.db.runInTransaction(async (work) => {
      const [entry] = await this.blocklist.add(work.tx, [
        { kind: input.kind, value: value.value, reason: input.reason, source: 'manual', createdBy: staffId },
      ]);
      if (!entry) throw new AppError('ALREADY_BLOCKED');
      await this.audit.record(work.tx, {
        action: 'added to blocklist',
        entityType: 'blocklist',
        entityId: entry.id,
        entityLabel: auditBlockLabel(entry),
        before: null,
        after: { kind: entry.kind, display: auditBlockDisplay(entry), reason: entry.reason },
      });
      const row = await findBlocklistRow(work.tx, entry.id);
      return viewOf(row!);
    });
  }

  /**
   * Removes an entry.
   *
   * @param id the entry id
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async remove(id: number): Promise<void> {
    await this.db.runInTransaction(async (work) => {
      const entry = await deleteEntry(work.tx, id);
      if (!entry) throw notFound();
      await this.audit.record(work.tx, {
        action: 'removed from blocklist',
        entityType: 'blocklist',
        entityId: entry.id,
        entityLabel: auditBlockLabel(entry),
        before: { kind: entry.kind, display: auditBlockDisplay(entry), source: entry.source },
        after: null,
      });
    });
  }
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No blocklist entry with this id.' });
}
