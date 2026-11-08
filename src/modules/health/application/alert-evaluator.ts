// The alert evaluator (feature 12b, scenario system-alert steps 3, 4 and 10; system-integrity steps 2 and 7): compares every active rule with
// the value of its metric over its window and opens or closes `alert_events`. Idempotent: running it twice in a row changes nothing.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { AlertEvent, AlertRule } from '../db/schema';
import {
  type AlertSubject,
  type EvaluationDecision,
  type Streak,
  conditionOf,
  decide,
  isMuted,
  judgeHeld,
  judgeMeasured,
  reminderRound,
  round4,
  subjectKeyOf,
} from '../domain/alert-evaluation';
import { ledgerDetail } from '../domain/alert-message';
import { METRICS, type MetricKey, type WindowMode, isMetricKey, unitOf } from '../domain/metric-registry';
import {
  type OpenAlertRef,
  firingAlertsOfRules,
  insertAlertIfNoOpen,
  lockAlert,
  openAlertsOfRules,
  resolveAlertRow,
} from '../infra/alert-events.repository';
import { activeRules, lockActiveRuleForShare } from '../infra/alert-rules.repository';
import { type SubjectStreak, replaceStreaks, streaksOfRule } from '../infra/alert-streaks.repository';
import { lastAccountDifferences } from '../infra/integrity-runs.repository';
import { AlertNotifier, noticeOf } from './alert-notifier';
import { type Reading, AlertMetricReader } from './alert-metrics';
import { isDatabaseDown } from './database-guard';

/** What one evaluation run did (stored as the `result` of its `job_runs` row). */
export interface EvaluationReport {
  /** Active rules looked at. */
  readonly rules: number;
  /** Rules whose metric could be read. */
  readonly evaluated: number;
  /** Rules whose metric could not be read this time (Prometheus down, a store not answering). */
  readonly unevaluated: number;
  /** The keys of those rules. */
  readonly unevaluatedRules: string[];
  /** Alerts opened. */
  readonly fired: number;
  /** Alerts closed (value back in range, or the subject is gone). */
  readonly resolved: number;
}

/**
 * Fires and resolves alerts.
 *
 * Why: the map's step 3 evaluates `alert_rules` every minute over the last window and creates `alert_events` in state `firing` for the subject, unless
 * the rule is muted; step 10 closes the alert by itself when the value is back in range, an acknowledged one included (only acknowledging stops the
 * reminders, ANSWERS Q14). One open alert per rule and subject is a database rule (partial unique index), so two overlapping runs open it once, and
 * only the run that opened it notifies: an open alert never pages twice. The rule is snapshotted onto the alert when it fires (health-commissions-5).
 *
 * The rule's window has three meanings (`WindowMode` of the metric registry): a rate or percentile is measured over it, fires at once and resolves only
 * after three consecutive ok minutes (the `clear` stretch of `alert_streaks`, RULES health 8); a reading of the moment (a balance, a queue age, a count,
 * a usage) must hold for the whole window before it fires and before it resolves, with the start of the stretch kept in `alert_streaks`; the integrity
 * run's mismatch count is judged as soon as the run is recorded.
 *
 * The messages are written by the {@link AlertNotifier} in the same transaction as the change they report (insert, resolve, reminder), so a page is never
 * lost between the change and the send. A firing alert that nobody acknowledged repeats its message each reminder interval (30 minutes, a lead default:
 * the map names none), counted from the moment it fired; a mute or an acknowledgement stops the reminders.
 *
 * A rule can be switched off, deleted, muted or edited while a run is reading its metric, so an alert is opened in a transaction that first locks the
 * rule as it is now and opens nothing for a rule that is off, deleted, muted or judged differently any more.
 *
 * Side effects: inserts and updates `alert_events` and `alert_streaks`; the {@link AlertNotifier} inserts `notifications` rows and outbox events in the transaction of
 * each opened, repeated or closed alert (a database failure rolls the change back and the next run does it again). All times come from the injected clock
 * (decision 031).
 */
@Injectable()
export class AlertEvaluator {
  private readonly logger = new Logger(AlertEvaluator.name);

  constructor(
    private readonly db: DbService,
    private readonly reader: AlertMetricReader,
    private readonly notifier: AlertNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Evaluates every active rule.
   *
   * @returns what the run did
   * @throws whatever the database throws when it cannot be reached (the run is then recorded as failed and retried)
   */
  evaluateAll(): Promise<EvaluationReport> {
    return this.evaluate(() => true);
  }

  /**
   * Evaluates the active rules on one metric.
   *
   * Why: the integrity job calls this right after it records a run, so a mismatch fires (and a clean run resolves) the `ledger.mismatch_count`
   * alert at once instead of at the next minute's tick (scenario system-integrity step 7).
   *
   * @param metric the registry key
   * @returns what the run did
   */
  evaluateMetric(metric: MetricKey): Promise<EvaluationReport> {
    return this.evaluate((rule) => rule.metric === metric);
  }

  private async evaluate(include: (rule: AlertRule) => boolean): Promise<EvaluationReport> {
    const now = this.clock.now();
    const rules = (await activeRules(this.db.db)).filter(include);
    const open = await openAlertsOfRules(
      this.db.db,
      rules.map((rule) => rule.id),
    );
    const openByRule = Map.groupBy(open, (alert) => alert.ruleId);
    // Two rules on one metric and window read it once.
    const readings = new Map<string, Promise<Reading[]>>();
    const report = {
      rules: rules.length,
      evaluated: 0,
      unevaluated: 0,
      unevaluatedRules: [] as string[],
      fired: 0,
      resolved: 0,
    };

    for (const rule of rules) {
      let values: Reading[];
      let streaks = new Map<string, Streak>();
      let mode: WindowMode;
      try {
        if (!isMetricKey(rule.metric))
          throw new Error(`The rule "${rule.key}" watches an unknown metric "${rule.metric}".`);
        const cacheKey = `${rule.metric}|${rule.windowSeconds}`;
        const pending = readings.get(cacheKey) ?? this.reader.read(rule.metric, rule.windowSeconds, now);
        readings.set(cacheKey, pending);
        values = await pending;
        mode = METRICS[rule.metric].window;
        if (mode !== 'run') streaks = await streaksOfRule(this.db.db, rule.id);
      } catch (error) {
        // Postgres being down fails the whole run; any other source failing only skips the rules that need it.
        if (isDatabaseDown(error)) throw error;
        report.unevaluated += 1;
        report.unevaluatedRules.push(rule.key);
        const why = error instanceof AppError ? error.code : error instanceof Error ? error.message : String(error);
        this.logger.warn(`Rule "${rule.key}" (${rule.metric}) could not be evaluated: ${why}`);
        continue;
      }
      report.evaluated += 1;
      const changes = await this.apply(rule, mode, values, openByRule.get(rule.id) ?? [], streaks, now);
      report.fired += changes.fired;
      report.resolved += changes.resolved;
    }
    // The reminders are due whatever a rule's metric says now (even when it could not be read), so they come last.
    await this.remind(rules, now);
    return report;
  }

  /**
   * Applies the readings of one rule: opens the alerts that are due, closes the ones whose value recovered or whose subject is gone, and (for a
   * measured recovery or a reading of the moment) rewrites the stretches that are still running.
   */
  private async apply(
    rule: AlertRule,
    mode: WindowMode,
    readings: readonly Reading[],
    open: readonly OpenAlertRef[],
    streaks: ReadonlyMap<string, Streak>,
    now: Date,
  ): Promise<{ fired: number; resolved: number }> {
    const muted = isMuted(rule.mutedUntil, now);
    const threshold = Number(rule.threshold);
    const condition = conditionOf(rule);
    const openByKey = new Map(open.map((alert) => [alert.subjectKey, alert]));
    const seen = new Set<string>();
    const running: SubjectStreak[] = [];
    let fired = 0;
    let resolved = 0;

    for (const reading of readings) {
      const key = subjectKeyOf(reading.subject);
      seen.add(key);
      const existing = openByKey.get(key);
      const facts = {
        value: reading.value,
        comparator: rule.comparator,
        threshold,
        open: existing !== undefined,
        muted,
      };
      let decision: EvaluationDecision;
      if (mode === 'run') {
        decision = decide(facts);
      } else {
        const judged = (mode === 'held' ? judgeHeld : judgeMeasured)({
          ...facts,
          windowSeconds: rule.windowSeconds,
          streak: streaks.get(key) ?? null,
          condition,
          now,
        });
        decision = judged.decision;
        if (judged.streak) running.push({ ...judged.streak, subjectKey: key });
      }
      if (decision === 'fire') {
        const detail = rule.metric === 'ledger.mismatch_count' ? await this.mismatchDetail() : null;
        const opened = await this.openAlert(rule, reading.subject, key, reading.value!, now, detail);
        if (opened) fired += 1;
      } else if (decision === 'resolve' && existing) {
        if (await this.closeAlert(rule, existing.id, reading.value, now, null)) resolved += 1;
      }
    }
    // An alert whose subject has no reading any more (a supplier was disabled or deleted, a queue was removed) has nothing left to measure.
    for (const [key, alert] of openByKey) {
      if (seen.has(key)) continue;
      if (
        await this.closeAlert(
          rule,
          alert.id,
          null,
          now,
          'Its subject no longer exists, so there is nothing left to measure.',
        )
      )
        resolved += 1;
    }
    if (mode !== 'run') await this.keepStreaks(rule, condition, running, now);
    return { fired, resolved };
  }

  /**
   * Repeats the message of every firing alert whose reminder interval has passed.
   *
   * Why: RULES health 6 and scenario system-alert step 4: the message is repeated "only after the reminder interval until acknowledged". The
   * round (whole intervals since the alert fired) is in the notification's dedupe key, so this runs every minute and writes one message per
   * round and channel. Each alert is reminded in its own transaction that first locks the alert (an acknowledgement in flight wins: the alert is
   * then no longer firing) and the rule as it is now (a rule that was switched off, deleted or muted meanwhile is not reminded).
   */
  private async remind(rules: readonly AlertRule[], now: Date): Promise<void> {
    const due = (
      await firingAlertsOfRules(
        this.db.db,
        rules.map((rule) => rule.id),
      )
    ).filter((alert) => reminderRound(alert.startedAt, now) >= 1);
    for (const alert of due) {
      await this.db.runInTransaction(async (work) => {
        const { tx } = work;
        const live = await lockActiveRuleForShare(tx, alert.ruleId);
        const current = await lockAlert(tx, alert.id);
        if (!live || isMuted(live.mutedUntil, now) || current?.status !== 'firing') return;
        const round = reminderRound(current.startedAt, now);
        await this.notifier.reminded(work, noticeOf(live, current, Number(current.value), null), round);
      });
    }
  }

  /**
   * Stores the stretches that are still running after an evaluation.
   *
   * Why: the rule may have been switched off, deleted or edited since this run read it; the rule service has deleted its stretches then, and writing
   * these back would resurrect a window that belongs to the old rule. Like {@link AlertEvaluator.openAlert}, the write takes the rule's lock first and
   * does nothing when the rule is not the one this run judged.
   */
  private async keepStreaks(
    rule: AlertRule,
    condition: string,
    running: readonly SubjectStreak[],
    now: Date,
  ): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const live = await lockActiveRuleForShare(tx, rule.id);
      if (live && conditionOf(live) === condition) await replaceStreaks(tx, rule.id, running, now);
    });
  }

  /**
   * Opens the alert of one subject, if the rule still says so, and writes its message in the same transaction.
   *
   * Why: the rule this run read may have changed since (switched off, deleted, muted, edited) while its metric was being read, and nothing would ever
   * close an alert opened from the stale copy: later runs skip an inactive rule and no route resolves an alert. The transaction locks the rule as it is
   * now (`for share`, which waits for a change in flight and is waited for by the next one), checks it again, and builds the snapshot from that row.
   * The notifier writes the notifications in this transaction too: if the alert committed, its page is queued; if the page could not be written, the
   * alert is not opened and the next run tries again.
   *
   * @returns the new alert and the rule it was opened from, or `undefined` when the rule no longer allows it or the subject already has an open alert
   */
  private async openAlert(
    rule: AlertRule,
    subject: AlertSubject,
    subjectKey: string,
    value: number,
    now: Date,
    detail: string | null,
  ): Promise<{ alert: AlertEvent; rule: AlertRule } | undefined> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const live = await lockActiveRuleForShare(tx, rule.id);
      if (!live || isMuted(live.mutedUntil, now)) return undefined;
      // Judged by another threshold, comparator, metric or window than the one this value was compared with: the next run judges it again.
      if (conditionOf(live) !== conditionOf(rule) || live.windowSeconds !== rule.windowSeconds) return undefined;
      const alert = await insertAlertIfNoOpen(tx, this.snapshot(live, subject, subjectKey, value, now));
      if (!alert) return undefined;
      await this.notifier.fired(work, noticeOf(live, alert, value, detail));
      return { alert, rule: live };
    });
  }

  /**
   * Closes one open alert and writes its "resolved" message in the same transaction.
   *
   * @param rule the rule the alert belongs to (its channels are where the message goes)
   * @param alertId the alert
   * @param value the value that closed it; `null` when there is none (the subject is gone), then the value it fired with is reported
   * @param now the clock's time
   * @param detail why it closed, when not simply because the value recovered
   * @returns whether this call closed it (another run may have)
   */
  private async closeAlert(
    rule: AlertRule,
    alertId: number,
    value: number | null,
    now: Date,
    detail: string | null,
  ): Promise<boolean> {
    return this.db.runInTransaction(async (work) => {
      const alert = await resolveAlertRow(work.tx, alertId, now);
      if (!alert) return false;
      await this.notifier.resolved(work, noticeOf(rule, alert, value ?? Number(alert.value), detail));
      return true;
    });
  }

  /** The account and difference the newest integrity run found, for the message of a ledger mismatch (scenario system-integrity step 2). */
  private async mismatchDetail(): Promise<string | null> {
    const { findings, count } = await lastAccountDifferences(this.db.db);
    const text = ledgerDetail(findings, count);
    return text === '' ? null : text;
  }

  /** The row of a new alert: the rule as it is now (name, metric, comparator, threshold, window, unit, severity), the value and the subject. */
  private snapshot(rule: AlertRule, subject: AlertSubject, subjectKey: string, value: number, now: Date) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      metric: rule.metric,
      comparator: rule.comparator,
      threshold: rule.threshold,
      windowSeconds: rule.windowSeconds,
      unit: unitOf(rule.metric),
      status: 'firing' as const,
      severity: rule.severity,
      value: round4(value).toFixed(4),
      subjectType: subject.type,
      subjectId: subject.id,
      subjectLabel: subject.label,
      subjectKey,
      startedAt: now,
    };
  }
}
