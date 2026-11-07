// AuditService: the one way to write audit_logs (platform module). Services call it inside their transaction for every
// admin write; the actor and the IP come from the request context the session guards filled in.
import { Injectable } from '@nestjs/common';
import { countAuditRecord, getRequestContext } from '../../../common/request-context';
import type { DbExecutor } from '../../../infra/db';
import { type AuditLog, auditLogs } from '../db/schema';
import { type AuditEntityType, isAuditEntityType } from './audit-entity-types';
import { redactForAudit } from './audit-redaction';

/**
 * What a service tells the audit log about one change.
 *
 * Why: the console's audit screen shows who did what to which record, with the state before and after (route
 * `GET /admin/audit-logs`, MISMATCHES B10).
 */
export interface AuditEntry {
  /**
   * The demo's lower-case verb phrase, completed by `entityLabel` on screen (`<actor> <action> <entityLabel>`, ANSWERS audit
   * Q3): `suspended admin`, `adjusted wallet of`, `changed group of`, `turned on the IP restriction for the admin console`.
   */
  readonly action: string;
  /** The kind of record, from the closed list `AUDIT_ENTITY_TYPES`: `staff`, `session`, `ip_rule`, `setting`, `order`, ... */
  readonly entityType: AuditEntityType;
  /**
   * The id of the record. Leave it out for an action without a numeric record (a settings change, a queue pause): the
   * row then stores `0`, and `entityLabel` names the target.
   */
  readonly entityId?: number;
  /** A name snapshot of the record (or of the target when there is no id), so a later rename does not change history. */
  readonly entityLabel?: string;
  /** The state before the change; `null` or left out for a create. Secrets are redacted. */
  readonly before?: Record<string, unknown> | null;
  /** The state after the change; `null` or left out for a delete. Secrets are redacted. */
  readonly after?: Record<string, unknown> | null;
}

const MAX_ACTION_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;

/**
 * Writes the audit log.
 *
 * Why: "every admin write writes audit_logs" (CLAUDE.md, architecture § 3). The row is written on the caller's
 * transaction, so a rolled-back change leaves no row and a committed change always has one. The table is append-only
 * (trigger), so a mistake can only be corrected by a new row.
 *
 * Side effects: inserts one `audit_logs` row; marks the current request as audited, which the audit enforcement checks.
 *
 * @see docs/contract/endpoints/platform.md (GET /admin/audit-logs)
 */
@Injectable()
export class AuditService {
  /**
   * Records one change.
   *
   * @param tx the transaction of the use case (pass `tx` from `runInTransaction`)
   * @param entry what happened
   * @returns the stored row
   * @throws {RangeError} when the entry is malformed (an empty or oversize action, an entity type outside
   *   `AUDIT_ENTITY_TYPES`, an entity id that is not a whole number from 0): a programming error that rolls the transaction
   *   back
   */
  async record(tx: DbExecutor, entry: AuditEntry): Promise<AuditLog> {
    const entityId = entry.entityId ?? 0;
    if (entry.action.trim() === '' || entry.action.length > MAX_ACTION_LENGTH) {
      throw new RangeError(`An audit action must be 1-${MAX_ACTION_LENGTH} characters`);
    }
    if (!isAuditEntityType(entry.entityType)) {
      throw new RangeError(`An audit entity type must be one of AUDIT_ENTITY_TYPES, got "${String(entry.entityType)}"`);
    }
    if (!Number.isSafeInteger(entityId) || entityId < 0) {
      throw new RangeError(`An audit entity id must be a whole number from 0, got ${entityId}`);
    }

    const context = getRequestContext();
    const [row] = await tx
      .insert(auditLogs)
      .values({
        // No actor means the system acted (a job, a scheduled check).
        actorType: context?.actor?.type ?? 'system',
        actorId: context?.actor?.id ?? null,
        // A snapshot, like entity_label: renamed or deleted accounts still read correctly (identity-platform-7).
        actorName: (context?.actor?.name ?? '').slice(0, MAX_LABEL_LENGTH),
        action: entry.action,
        entityType: entry.entityType,
        entityId,
        entityLabel: (entry.entityLabel ?? '').slice(0, MAX_LABEL_LENGTH),
        before: entry.before ? redactForAudit(entry.before) : null,
        after: entry.after ? redactForAudit(entry.after) : null,
        ip: context?.ip ?? null,
      })
      .returning();
    countAuditRecord();
    return row!;
  }
}
