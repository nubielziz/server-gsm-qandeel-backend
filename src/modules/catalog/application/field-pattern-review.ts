// FieldPatternReview: clears the stored order-field patterns that are outside the supported form (decision 051): one pass, asked for once by
// migration 0048 through the outbox, run by the worker (job `field_patterns_review`).
import { Injectable, Logger } from '@nestjs/common';
import { fieldPatternProblem } from '../../../common/field-pattern';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { clearFieldPattern, fieldPatternsAfter } from '../infra/service.repository';

/** The outbox event migration 0048 writes once: "review the stored field patterns". */
export const FIELD_PATTERNS_REVIEW_EVENT = 'catalog.field_patterns_review';

/** The job that event becomes on the `maintenance` queue. */
export const FIELD_PATTERNS_REVIEW_JOB = 'field_patterns_review';

/** The audit phrase of a cleared pattern (`<actor> <action> <entityLabel>`, the system as the actor). */
export const FIELD_PATTERN_CLEARED_AUDIT_ACTION = 'cleared an unsupported field pattern of';

/** Fields read in one page of the pass. */
const FIELD_PAGE = 500;

/** What one pass did. */
export interface FieldPatternReviewResult {
  /** The fields with a pattern it read. */
  readonly checked: number;
  /** The patterns it cleared. */
  readonly cleared: number;
}

/**
 * Reviews the patterns stored before the supported form existed.
 *
 * Why: decision 051: the order check no longer runs a pattern outside the supported form, so such a pattern would be a field that looks
 * protected to staff and is not. The pass clears each one (the field then has no pattern, also in the portal's own check) and records it:
 * an audit row of the service with the old pattern in `before`, and one warning line. Patterns saved after the release are checked at save,
 * so this pass has work only for rows written before it (and the migration asks for it once). Each clearing is its own transaction
 * and names the old text (`where regex = <old>`): a pattern a staff member saved meanwhile is left as saved, and a repeat finds nothing to do.
 *
 * Side effects: per cleared pattern, updates `service_fields.regex` and writes one `audit_logs` row by `system`; one warning log line.
 * It moves no catalog price version and sends no search signal (a staff save of the fields does neither).
 *
 * @see docs/queues.md (maintenance, `field_patterns_review`)
 */
@Injectable()
export class FieldPatternReview {
  private readonly logger = new Logger(FieldPatternReview.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Walks every field with a pattern, in id order, and clears the ones outside the supported form.
   *
   * @returns how many fields it read and how many patterns it cleared
   */
  async run(): Promise<FieldPatternReviewResult> {
    let checked = 0;
    let cleared = 0;
    let afterId = 0;
    for (;;) {
      const page = await fieldPatternsAfter(this.db.db, afterId, FIELD_PAGE);
      if (page.length === 0) break;
      for (const row of page) {
        afterId = row.id;
        checked += 1;
        const problem = fieldPatternProblem(row.regex);
        if (problem === undefined) continue;
        const changed = await this.db.runInTransaction(async ({ tx }) => {
          if (!(await clearFieldPattern(tx, row.id, row.regex))) return false;
          await this.audit.record(tx, {
            action: FIELD_PATTERN_CLEARED_AUDIT_ACTION,
            entityType: 'service',
            entityId: row.serviceId,
            entityLabel: row.serviceName,
            before: { field: row.key, regex: row.regex },
            after: { field: row.key, regex: '' },
          });
          return true;
        });
        if (!changed) continue;
        cleared += 1;
        this.logger.warn(
          `Service ${row.serviceId}: the pattern of field ${row.key} is outside the supported form (${problem.reason}) and was cleared.`,
        );
      }
    }
    return { checked, cleared };
  }
}
