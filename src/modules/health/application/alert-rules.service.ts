// The alert rule use cases (map routes /admin/alert-rules*, feature 12b): list, show, add, change (switch, mute) and soft delete, each audited.
// Rules decide what the evaluator watches; deleting or switching one off closes its open alerts.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { DbService, type TransactionContext } from '../../../infra/db';
import { isUniqueViolation } from '../../../infra/db/pg-errors';
import { AuditService } from '../../platform';
import type { AlertChannel, AlertEvent, AlertRule } from '../db/schema';
import { conditionOf, isMuted } from '../domain/alert-evaluation';
import { type MetricKey, unitOf } from '../domain/metric-registry';
import { resolveOpenAlertsOfRule } from '../infra/alert-events.repository';
import {
  type AlertRuleListField,
  type AlertRuleRow,
  findRuleRow,
  insertRule,
  listRuleRows,
  lockRule,
  ruleKeyTaken,
  softDeleteRule,
  updateRuleRow,
} from '../infra/alert-rules.repository';
import { deleteStreaksOfRule } from '../infra/alert-streaks.repository';
import { AlertNotifier, noticeOf } from './alert-notifier';
import { orUnavailable } from './database-guard';

/** A rule as the console reads it (`AlertRule`, plus the computed `muted`). */
export interface AlertRuleView {
  id: number;
  key: string;
  name: string;
  metric: MetricKey;
  comparator: AlertRule['comparator'];
  threshold: number;
  windowSeconds: number;
  severity: AlertRule['severity'];
  channels: AlertChannel[];
  isActive: boolean;
  mutedUntil: string | null;
  unit: ReturnType<typeof unitOf>;
  open: boolean;
  muted: boolean;
  createdAt: string;
  updatedAt: string | null;
}

/** The fields of a new rule (the contract has validated them). */
export interface CreateRuleInput {
  readonly key: string;
  readonly name: string;
  readonly metric: MetricKey;
  readonly comparator: AlertRule['comparator'];
  readonly threshold: number;
  readonly windowSeconds: number;
  readonly severity: AlertRule['severity'];
  readonly channels: AlertChannel[];
  readonly isActive?: boolean | undefined;
}

/** The fields of a change: only the ones present are applied; `mutedUntil: null` unmutes. */
export interface UpdateRuleInput extends Partial<CreateRuleInput> {
  readonly mutedUntil?: string | null | undefined;
}

const KEY_TAKEN = () =>
  new AppError('VALIDATION_FAILED', {
    errors: [{ field: 'key', code: 'duplicate', message: 'A rule with this key already exists.' }],
  });
const NOT_FOUND = () => new AppError('NOT_FOUND', { detail: 'No alert rule has this id.' });

/**
 * Maps a rule row to the wire.
 *
 * @param row the rule and its `open` flag
 * @param now the clock's time (a mute is on while `mutedUntil` is after it)
 * @returns the console's `AlertRule`
 */
export function toRuleView({ rule, open }: AlertRuleRow, now: Date): AlertRuleView {
  return {
    id: rule.id,
    key: rule.key,
    name: rule.name,
    metric: rule.metric as MetricKey,
    comparator: rule.comparator,
    threshold: Number(rule.threshold),
    windowSeconds: rule.windowSeconds,
    severity: rule.severity,
    channels: rule.channels as AlertChannel[],
    isActive: rule.isActive,
    mutedUntil: rule.mutedUntil?.toISOString() ?? null,
    unit: unitOf(rule.metric),
    open,
    muted: isMuted(rule.mutedUntil, now),
    createdAt: rule.createdAt.toISOString(),
    // The row's `updated_at` is bookkeeping; "edited" means a staff member changed it.
    updatedAt: rule.updatedBy === null ? null : rule.updatedAt.toISOString(),
  };
}

/** What the audit log keeps of a rule. */
const snapshot = (rule: AlertRule): Record<string, unknown> => ({
  key: rule.key,
  name: rule.name,
  metric: rule.metric,
  comparator: rule.comparator,
  threshold: Number(rule.threshold),
  windowSeconds: rule.windowSeconds,
  severity: rule.severity,
  channels: rule.channels,
  isActive: rule.isActive,
  mutedUntil: rule.mutedUntil?.toISOString() ?? null,
});

/** The audit verb: `changed alert rule`, or the narrower verb when a switch or a mute is all that changed. */
function changeVerb(before: AlertRule, after: AlertRule, keys: readonly string[], now: Date): string {
  if (keys.length === 1 && keys[0] === 'isActive' && before.isActive !== after.isActive) {
    return after.isActive ? 'turned on alert rule' : 'turned off alert rule';
  }
  if (keys.length === 1 && keys[0] === 'mutedUntil') {
    return isMuted(after.mutedUntil, now) ? 'muted alert rule' : 'unmuted alert rule';
  }
  return 'changed alert rule';
}

/**
 * Reads and changes alert rules.
 *
 * Why: the console's Alerts and incidents tab lists the rules, adds and edits them, switches them on and off, mutes one during maintenance (`muted_until`)
 * and deletes them (ANSWERS system-health Q29 to Q31). The metric comes from a fixed registry and the server sets the unit from it (B101). A deleted
 * rule is soft-deleted (`deleted_at`, B102) so the alerts it fired keep their rule, and its open alerts are resolved. Switching a rule off, deleting
 * it, or changing its metric resolves the open alerts of the old condition, and the "resolved" message of each goes out (scenario system-alert step 10:
 * whoever got the page is told it is over), written in the same transaction as the change.
 *
 * Side effects: writes `alert_rules` and, when alerts are closed, `alert_events` and their `notifications` rows; one `audit_logs` row per write; drops the
 * cached health snapshot after the commit when an alert closed. Reads answer `503 DATABASE_UNAVAILABLE` when Postgres cannot be reached
 * (health-commissions-17).
 */
@Injectable()
export class AlertRulesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly notifier: AlertNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the rules that are not deleted.
   *
   * @param query the parsed list request
   * @returns the page and the exact total
   * @throws {AppError} `DATABASE_UNAVAILABLE`
   */
  async list(query: ParsedListQuery<AlertRuleListField>): Promise<{ rows: AlertRuleView[]; total: number }> {
    const { rows, total } = await orUnavailable(() => listRuleRows(this.db.db, query));
    const now = this.clock.now();
    return { rows: rows.map((row) => toRuleView(row, now)), total };
  }

  /**
   * Shows one rule.
   *
   * @param id the rule id
   * @returns the rule
   * @throws {AppError} `NOT_FOUND` for an unknown or deleted rule; `DATABASE_UNAVAILABLE`
   */
  async show(id: number): Promise<AlertRuleView> {
    const row = await orUnavailable(() => findRuleRow(this.db.db, id));
    if (!row) throw NOT_FOUND();
    return toRuleView(row, this.clock.now());
  }

  /**
   * Adds a rule.
   *
   * @param staffId the staff member who adds it
   * @param input the validated fields
   * @returns the new rule (`open` false)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `key` when another rule that is not deleted has it)
   */
  async create(staffId: number, input: CreateRuleInput): Promise<AlertRuleView> {
    const now = this.clock.now();
    return this.db.runInTransaction(async ({ tx }) => {
      if (await ruleKeyTaken(tx, input.key)) throw KEY_TAKEN();
      let rule: AlertRule;
      try {
        rule = await insertRule(tx, {
          key: input.key,
          name: input.name,
          metric: input.metric,
          comparator: input.comparator,
          threshold: input.threshold.toFixed(4),
          windowSeconds: input.windowSeconds,
          severity: input.severity,
          channels: input.channels,
          isActive: input.isActive ?? true,
          mutedUntil: null,
          createdBy: staffId,
          createdAt: now,
        });
      } catch (error) {
        // A parallel request passed the pre-check; the partial unique index has the last word.
        if (isUniqueViolation(error, 'alert_rules_key_uq')) throw KEY_TAKEN();
        throw error;
      }
      await this.audit.record(tx, {
        action: 'added alert rule',
        entityType: 'alert_rule',
        entityId: rule.id,
        entityLabel: rule.name,
        after: snapshot(rule),
      });
      return toRuleView({ rule, open: false }, now);
    });
  }

  /**
   * Changes a rule.
   *
   * @param staffId the staff member who changes it
   * @param id the rule id
   * @param changes the fields to change
   * @returns the updated rule
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` (422 on `key` for a taken key, on `mutedUntil` for a time that is not in the future)
   */
  async update(staffId: number, id: number, changes: UpdateRuleInput): Promise<AlertRuleView> {
    const now = this.clock.now();
    let mutedUntil: Date | null | undefined;
    if (changes.mutedUntil !== undefined) {
      mutedUntil = changes.mutedUntil === null ? null : new Date(changes.mutedUntil);
      if (mutedUntil !== null && mutedUntil.getTime() <= now.getTime()) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            {
              field: 'mutedUntil',
              code: 'invalid',
              message: 'Mute until a time in the future, or send null to unmute.',
            },
          ],
        });
      }
    }
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const before = await lockRule(tx, id);
      if (!before) throw NOT_FOUND();
      if (changes.key !== undefined && (await ruleKeyTaken(tx, changes.key, id))) throw KEY_TAKEN();
      let after: AlertRule;
      try {
        after = await updateRuleRow(tx, id, {
          ...(changes.key === undefined ? {} : { key: changes.key }),
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.metric === undefined ? {} : { metric: changes.metric }),
          ...(changes.comparator === undefined ? {} : { comparator: changes.comparator }),
          ...(changes.threshold === undefined ? {} : { threshold: changes.threshold.toFixed(4) }),
          ...(changes.windowSeconds === undefined ? {} : { windowSeconds: changes.windowSeconds }),
          ...(changes.severity === undefined ? {} : { severity: changes.severity }),
          ...(changes.channels === undefined ? {} : { channels: changes.channels }),
          ...(changes.isActive === undefined ? {} : { isActive: changes.isActive }),
          ...(mutedUntil === undefined ? {} : { mutedUntil }),
          updatedBy: staffId,
          updatedAt: now,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'alert_rules_key_uq')) throw KEY_TAKEN();
        throw error;
      }
      // A stretch of evaluations belongs to the rule as it was judged: off, on again or judged differently, the window starts again.
      if (before.isActive !== after.isActive || conditionOf(before) !== conditionOf(after))
        await deleteStreaksOfRule(tx, id);
      // An alert of the old condition (the rule is off, or watches another metric) has nothing left to measure.
      if ((before.isActive && !after.isActive) || before.metric !== after.metric) {
        const closed = await resolveOpenAlertsOfRule(tx, id, now);
        await this.announceResolved(
          work,
          after,
          closed,
          before.isActive && !after.isActive ? 'The rule was switched off.' : 'The rule now watches another metric.',
        );
        if (closed.length > 0)
          work.afterCommit(async () => {
            await this.cache.del(this.keys.healthSnapshot());
          });
      }
      const sent = Object.entries(changes)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
      await this.audit.record(tx, {
        action: changeVerb(before, after, sent, now),
        entityType: 'alert_rule',
        entityId: id,
        entityLabel: after.name,
        before: snapshot(before),
        after: snapshot(after),
      });
      return toRuleView({ rule: after, open: (await findRuleRow(tx, id))?.open ?? false }, now);
    });
  }

  /**
   * Deletes a rule (soft): it stops alerting, its open alerts are resolved, its history stays.
   *
   * @param staffId the staff member who deletes it
   * @param id the rule id
   * @throws {AppError} `NOT_FOUND` for an unknown or already deleted rule
   */
  async remove(staffId: number, id: number): Promise<void> {
    const now = this.clock.now();
    await this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const rule = await lockRule(tx, id);
      if (!rule) throw NOT_FOUND();
      await softDeleteRule(tx, id, now, staffId);
      await deleteStreaksOfRule(tx, id);
      const closed = await resolveOpenAlertsOfRule(tx, id, now);
      await this.announceResolved(work, rule, closed, 'The rule was deleted.');
      if (closed.length > 0)
        work.afterCommit(async () => {
          await this.cache.del(this.keys.healthSnapshot());
        });
      await this.audit.record(tx, {
        action: 'deleted alert rule',
        entityType: 'alert_rule',
        entityId: id,
        entityLabel: rule.name,
        before: snapshot(rule),
      });
    });
  }

  /**
   * Writes the "resolved" message of every alert a rule change just closed, in the change's transaction.
   *
   * Why: an alert closed because its rule was switched off or deleted is over for the people who were paged, so they get the same message as for a
   * recovery, with the reason as its detail. The value reported is the one the alert fired with: nothing was measured since.
   */
  private async announceResolved(
    work: Pick<TransactionContext, 'tx'>,
    rule: AlertRule,
    closed: readonly AlertEvent[],
    reason: string,
  ): Promise<void> {
    for (const alert of closed) await this.notifier.resolved(work, noticeOf(rule, alert, Number(alert.value), reason));
  }
}
