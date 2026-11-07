// AuditLogAdminService: the read side of the audit log for the console (map domain G, stage 2): the filtered list and one entry.
import { Injectable } from '@nestjs/common';
import type { JsonObject, ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { AuditLog } from '../db/schema';
import { findAuditRow, listAuditRows } from '../infra/audit-log.repository';

/** An audit entry as the console reads it. */
export interface AuditLogView {
  readonly id: number;
  readonly createdAt: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: number;
  readonly actorType: AuditLog['actorType'];
  readonly actorId: number | null;
  readonly actorName: string | null;
  readonly entityLabel: string | null;
  readonly before: JsonObject | null;
  readonly after: JsonObject | null;
  readonly ip: string | null;
}

function toView(row: AuditLog): AuditLogView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorType: row.actorType,
    actorId: row.actorId,
    // '' is the snapshot of "nobody" (the system, or an account without a name): the console then says "System".
    actorName: row.actorName === '' ? null : row.actorName,
    entityLabel: row.entityLabel === '' ? null : row.entityLabel,
    // The snapshots were written as JSON by `redactForAudit` and live in jsonb columns: the cast only names that.
    before: row.before as JsonObject | null,
    after: row.after as JsonObject | null,
    ip: row.ip,
  };
}

/**
 * Reads the audit log.
 *
 * Why: the console's audit page lists who did what to which record (scenario admin-team, ip-rules and every admin write).
 * The names are snapshots written with each entry, so a rename or a deleted account does not rewrite history
 * (RESOLUTIONS identity-platform-7). Secrets were masked when the entry was written (`redactForAudit`).
 *
 * Side effects: none (reads only; the table is append-only).
 *
 * @see docs/contract/endpoints/platform.md (GET /admin/audit-logs)
 */
@Injectable()
export class AuditLogAdminService {
  constructor(private readonly db: DbService) {}

  /**
   * Lists audit entries.
   *
   * @param query the parsed list request with the `from` and `to` days
   * @returns the page (newest first by default) and the exact total for the filter
   */
  async list(
    query: ParsedListQuery<'createdAt' | 'id', { from?: string | undefined; to?: string | undefined }>,
  ): Promise<{ rows: AuditLogView[]; total: number }> {
    const { rows, total } = await listAuditRows(this.db.db, query);
    return { rows: rows.map(toView), total };
  }

  /**
   * Shows one audit entry.
   *
   * @param id the entry id
   * @returns the entry
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async show(id: number): Promise<AuditLogView> {
    const row = await findAuditRow(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No audit entry has this id.' });
    return toView(row);
  }
}
