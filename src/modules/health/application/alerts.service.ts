// The alert use cases (map routes /admin/alerts*, feature 12b): list, show and acknowledge. Alerts are opened and closed by the evaluator, so staff only
// read them and acknowledge a firing one.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { AlertEvent } from '../db/schema';
import type { MetricKey } from '../domain/metric-registry';
import {
  type AlertListField,
  type AlertRow,
  acknowledgeAlert,
  findAlertRow,
  listAlertRows,
  lockAlert,
} from '../infra/alert-events.repository';
import { orUnavailable } from './database-guard';

/** An alert as the console reads it (`AlertEvent`). */
export interface AlertView {
  id: number;
  ruleId: number;
  rule: {
    id: number;
    key: string;
    name: string;
    metric: MetricKey;
    comparator: AlertEvent['comparator'];
    threshold: number;
    windowSeconds: number;
    unit: AlertEvent['unit'];
  };
  status: AlertEvent['status'];
  severity: AlertEvent['severity'];
  value: number;
  subjectType: AlertEvent['subjectType'];
  subjectId: number;
  subjectLabel: string | null;
  startedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: number; name: string } | null;
  resolvedAt: string | null;
  note: string | null;
  incidentId: number | null;
}

/**
 * Maps an alert row to the wire.
 *
 * @param row the alert with its rule key, acknowledger and incident
 * @returns the console's `AlertEvent`: the rule is the snapshot taken when the alert fired, `subjectId` is 0 for a subject with no id (B103)
 */
export function toAlertView({ alert, ruleKey, acknowledgedBy, incidentId }: AlertRow): AlertView {
  return {
    id: alert.id,
    ruleId: alert.ruleId,
    rule: {
      id: alert.ruleId,
      key: ruleKey,
      name: alert.ruleName,
      metric: alert.metric as MetricKey,
      comparator: alert.comparator,
      threshold: Number(alert.threshold),
      windowSeconds: alert.windowSeconds,
      unit: alert.unit,
    },
    status: alert.status,
    severity: alert.severity,
    value: Number(alert.value),
    subjectType: alert.subjectType,
    subjectId: alert.subjectId ?? 0,
    subjectLabel: alert.subjectLabel,
    startedAt: alert.startedAt.toISOString(),
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    note: alert.note,
    incidentId,
  };
}

const NOT_FOUND = () => new AppError('NOT_FOUND', { detail: 'No alert has this id.' });

/**
 * Reads and acknowledges alerts.
 *
 * Why: scenario system-alert step 6: a staff member acknowledges a firing alert, which stops the repeated messages and records who and when in
 * `acknowledged_by` and the audit log; the alert stays open (and counts on the health page, critical included) until the value is back in range
 * (ANSWERS Q14). The update is conditional on `status = 'firing'`, so a double click or two staff members acknowledge once and the other gets `409`.
 *
 * Side effects: `ack` updates `alert_events`, writes one `audit_logs` row and drops the cached health snapshot after the commit. Reads answer
 * `503 DATABASE_UNAVAILABLE` when Postgres cannot be reached (health-commissions-17).
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists alerts.
   *
   * @param query the parsed list request
   * @returns the page and the exact total
   * @throws {AppError} `DATABASE_UNAVAILABLE`
   */
  async list(query: ParsedListQuery<AlertListField>): Promise<{ rows: AlertView[]; total: number }> {
    const { rows, total } = await orUnavailable(() => listAlertRows(this.db.db, query));
    return { rows: rows.map(toAlertView), total };
  }

  /**
   * Shows one alert.
   *
   * @param id the alert id
   * @returns the alert
   * @throws {AppError} `NOT_FOUND`; `DATABASE_UNAVAILABLE`
   */
  async show(id: number): Promise<AlertView> {
    const row = await orUnavailable(() => findAlertRow(this.db.db, id));
    if (!row) throw NOT_FOUND();
    return toAlertView(row);
  }

  /**
   * Acknowledges a firing alert.
   *
   * @param staffId the staff member who acknowledges
   * @param id the alert id
   * @param note an optional note (the contract has trimmed it and limited it to 500 characters)
   * @returns the acknowledged alert
   * @throws {AppError} `NOT_FOUND`; `ALERT_RESOLVED` (409) when the server already closed it; `ALERT_ACKNOWLEDGED` (409, the detail names who) when it already was
   */
  async acknowledge(staffId: number, id: number, note: string | undefined): Promise<AlertView> {
    const now = this.clock.now();
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const alert = await lockAlert(tx, id);
      if (!alert) throw NOT_FOUND();
      if (alert.status === 'resolved') {
        throw new AppError('ALERT_RESOLVED', {
          detail: 'This alert closed on its own, so there is nothing to acknowledge.',
        });
      }
      const updated =
        alert.status === 'firing' ? await acknowledgeAlert(tx, id, staffId, note ? note : null, now) : undefined;
      if (!updated) {
        const row = await findAlertRow(tx, id);
        throw new AppError('ALERT_ACKNOWLEDGED', {
          detail: `${row?.acknowledgedBy?.name ?? 'Someone'} already acknowledged this alert.`,
        });
      }
      work.afterCommit(async () => {
        await this.cache.del(this.keys.healthSnapshot());
      });
      await this.audit.record(tx, {
        action: 'acknowledged alert',
        entityType: 'alert',
        entityId: id,
        entityLabel: alert.subjectLabel ? `${alert.ruleName} · ${alert.subjectLabel}` : alert.ruleName,
        before: { status: alert.status },
        after: { status: 'acknowledged', note: note ? note : null },
      });
      return toAlertView((await findAlertRow(tx, id))!);
    });
  }
}
