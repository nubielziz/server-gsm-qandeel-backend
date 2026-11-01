// System health tables (map domain G): periodic checks, alert rules and events, incidents and job runs.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigId,
  createdAt,
  fk,
  inList,
  jsonList,
  jsonObject,
  money,
  pk,
  textList,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { staffUsers } from '../../identity/db/schema';
import { paymentGateways } from '../../money/db/schema';
import { suppliers } from '../../suppliers/db/schema';

/**
 * Result of one periodic health check.
 *
 * Why: the console's System health wire enum (GET /admin/system/checks).
 */
export const CHECK_STATUSES = ['ok', 'degraded', 'down', 'unknown'] as const;

/** One value of {@link CHECK_STATUSES}. */
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/**
 * How an alert rule compares the measured value with its threshold.
 *
 * Why: the console's alert rule wire enum (GET /admin/alert-rules).
 */
export const ALERT_COMPARATORS = ['gt', 'gte', 'lt', 'lte'] as const;

/** One value of {@link ALERT_COMPARATORS}. */
export type AlertComparator = (typeof ALERT_COMPARATORS)[number];

/**
 * Severity of an alert rule and of the alerts it raises.
 *
 * Why: the console's alert wire enum (GET /admin/alerts).
 */
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;

/** One value of {@link ALERT_SEVERITIES}. */
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * Channels an alert rule notifies through.
 *
 * Why: the console's alert rule wire enum.
 */
export const ALERT_CHANNELS = ['email', 'telegram'] as const;

/** One value of {@link ALERT_CHANNELS}. */
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/**
 * Life of one alert: firing, then acknowledged, then resolved.
 *
 * Why: the console's alert wire enum and scenario system-alert.
 */
export const ALERT_STATUSES = ['firing', 'acknowledged', 'resolved'] as const;

/** One value of {@link ALERT_STATUSES}. */
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/**
 * The unit of a metric's measured value and threshold.
 *
 * Why: RESOLUTIONS health-commissions-5: an alert keeps the unit of its metric when it fires, so the console shows
 * the value correctly even after the rule changes. Null means a unit that depends on the subject (a supplier balance).
 */
export const ALERT_UNITS = ['percent', 'ms', 's', 'per_min', 'count', 'bytes'] as const;

/** One value of {@link ALERT_UNITS}. */
export type AlertUnit = (typeof ALERT_UNITS)[number];

/**
 * What an alert is about.
 *
 * Why: RESOLUTIONS health-commissions-14: `system` is the subject of alerts that belong to no single record (API
 * latency, error rate); the others point at `subject_id`.
 */
export const ALERT_SUBJECT_TYPES = ['system', 'supplier', 'queue', 'gateway', 'ledger_account', 'client'] as const;

/** One value of {@link ALERT_SUBJECT_TYPES}. */
export type AlertSubjectType = (typeof ALERT_SUBJECT_TYPES)[number];

/**
 * Severity of an incident.
 *
 * Why: the console's incident wire enum (GET /admin/incidents).
 */
export const INCIDENT_SEVERITIES = ['minor', 'major', 'critical'] as const;

/** One value of {@link INCIDENT_SEVERITIES}. */
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/**
 * Life of an incident.
 *
 * Why: the console's incident wire enum.
 */
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;

/** One value of {@link INCIDENT_STATUSES}. */
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/**
 * What started a job run.
 *
 * Why: the console's job wire enum (GET /admin/system/jobs).
 */
export const JOB_TRIGGERS = ['manual', 'event', 'schedule'] as const;

/** One value of {@link JOB_TRIGGERS}. */
export type JobTrigger = (typeof JOB_TRIGGERS)[number];

/**
 * Outcome of a job run.
 *
 * Why: the console's job wire enum.
 */
export const JOB_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;

/** One value of {@link JOB_STATUSES}. */
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Results of the periodic health checks: every minute the worker checks the database, the cache, storage, every
 * supplier and every payment gateway, and writes the status and the response time. Uptime is computed from these rows
 * and outages are detected from them. High-resolution metrics (requests, latency) are not stored here but in the
 * monitoring system. Rows are deleted after 90 days.
 *
 * Why: Per-minute health checks of the database, cache, storage, suppliers and gateways; uptime is computed from them
 * (scenario system-alert).
 *
 * Immutable log, deleted after 90 days: rows are inserted and never changed, so the table has no `updated_at`.
 */
export const serviceChecks = pgTable(
  'service_checks',
  {
    id: pk(),
    /** core key (api, postgres, redis, redis_queue, storage, workers, mail) or supplier:<id> / gateway:<id> (ANSWERS Q19) */
    component: text().notNull(),
    /** history is not worth blocking a supplier delete */
    supplierId: fk((): AnyPgColumn => suppliers.id, 'cascade'),
    /** history is not worth blocking a gateway delete */
    gatewayId: fk((): AnyPgColumn => paymentGateways.id, 'cascade'),
    status: text().$type<CheckStatus>().notNull(),
    latencyMs: integer(),
    /** a short message for the console (for example the error text); null when the check has nothing to say */
    detail: text(),
    checkedAt: timestampTz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    check('service_checks_status_check', inList(t.status, CHECK_STATUSES)),
    // The component key names the record it checks (RESOLUTIONS health-commissions-7).
    check(
      'service_checks_supplier_key_check',
      sql`(${t.supplierId} is null) or ${t.component} = 'supplier:' || ${t.supplierId}::text`,
    ),
    check(
      'service_checks_gateway_key_check',
      sql`(${t.gatewayId} is null) or ${t.component} = 'gateway:' || ${t.gatewayId}::text`,
    ),
    index('service_checks_component_checked_idx').on(t.component, t.checkedAt.desc()),
    index('service_checks_supplier_checked_idx').on(t.supplierId, t.checkedAt.desc()),
    index('service_checks_gateway_id_idx').on(t.gatewayId),
    index('service_checks_checked_idx').on(t.checkedAt),
  ],
);

/** A row read from `service_checks`. */
export type ServiceCheck = typeof serviceChecks.$inferSelect;

/** A row to insert into `service_checks`. */
export type NewServiceCheck = typeof serviceChecks.$inferInsert;

/**
 * Alert rules: metric, comparator, threshold, window, severity and channels (Telegram or email). A temporary mute,
 * for example during maintenance, uses muted_until.
 *
 * Why: What to watch and when to alert; deleting a rule hides it so past alerts keep their rule (B102, routes
 * /admin/alert-rules).
 */
export const alertRules = pgTable(
  'alert_rules',
  {
    id: pk(),
    /** unique among rules that are not deleted */
    key: text().notNull(),
    name: text().notNull(),
    /** one of the backend's metric registry (B101); not a database enumeration */
    metric: text().notNull(),
    comparator: text().$type<AlertComparator>().notNull(),
    /** a measured value in the metric's own unit (percent, ms, count, bytes), not money */
    threshold: money().notNull(),
    windowSeconds: integer().notNull(),
    severity: text().$type<AlertSeverity>().notNull(),
    channels: textList(),
    isActive: boolean().notNull().default(true),
    mutedUntil: timestampTz(),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    updatedBy: fk((): AnyPgColumn => staffUsers.id),
    /** schema addition B116 */
    deletedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('alert_rules_key_uq')
      .on(t.key)
      .where(sql`${t.deletedAt} is null`),
    check('alert_rules_comparator_check', inList(t.comparator, ALERT_COMPARATORS)),
    check('alert_rules_severity_check', inList(t.severity, ALERT_SEVERITIES)),
    check('alert_rules_channels_check', sql`${t.channels} <@ array['email', 'telegram']::text[]`),
    check('alert_rules_window_check', sql`${t.windowSeconds} > 0`),
    index('alert_rules_created_by_idx').on(t.createdBy),
    index('alert_rules_updated_by_idx').on(t.updatedBy),
  ],
);

/** A row read from `alert_rules`. */
export type AlertRule = typeof alertRules.$inferSelect;

/** A row to insert into `alert_rules`. */
export type NewAlertRule = typeof alertRules.$inferInsert;

/**
 * Each time a rule fires: firing, then acknowledged, then resolved. It closes on its own when the value is back in
 * range, and the message is not repeated until a staff member acknowledges it or the reminder interval passes.
 *
 * Why: Each time a rule fires: firing, acknowledged, resolved (scenario system-alert, routes /admin/alerts).
 */
export const alertEvents = pgTable(
  'alert_events',
  {
    id: pk(),
    ruleId: fk((): AnyPgColumn => alertRules.id).notNull(),
    /** the rule's name, metric, comparator, threshold, window and unit when the alert fired (RESOLUTIONS health-commissions-5) */
    ruleName: text().notNull(),
    metric: text().notNull(),
    comparator: text().$type<AlertComparator>().notNull(),
    threshold: money().notNull(),
    windowSeconds: integer().notNull(),
    unit: text().$type<AlertUnit>(),
    status: text().$type<AlertStatus>().notNull().default('firing'),
    severity: text().$type<AlertSeverity>().notNull(),
    /** the measured value that fired the alert, in the metric's own unit */
    value: money().notNull(),
    /** what the alert is about; `system` when it belongs to no record (RESOLUTIONS health-commissions-14) */
    subjectType: text().$type<AlertSubjectType>().notNull().default('system'),
    /** polymorphic: suppliers by subject_type; null for system and queue alerts (B103) */
    subjectId: bigId(),
    startedAt: timestampTz().notNull().defaultNow(),
    acknowledgedBy: fk((): AnyPgColumn => staffUsers.id),
    acknowledgedAt: timestampTz(),
    resolvedAt: timestampTz(),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('alert_events_status_check', inList(t.status, ALERT_STATUSES)),
    check('alert_events_severity_check', inList(t.severity, ALERT_SEVERITIES)),
    check('alert_events_comparator_check', inList(t.comparator, ALERT_COMPARATORS)),
    check('alert_events_window_check', sql`${t.windowSeconds} > 0`),
    check('alert_events_unit_check', sql`${t.unit} is null or ${inList(t.unit, ALERT_UNITS)}`),
    check('alert_events_subject_type_check', inList(t.subjectType, ALERT_SUBJECT_TYPES)),
    index('alert_events_status_started_idx').on(t.status, t.startedAt.desc()),
    index('alert_events_rule_id_idx').on(t.ruleId),
    index('alert_events_acknowledged_by_idx').on(t.acknowledgedBy),
  ],
);

/** A row read from `alert_events`. */
export type AlertEvent = typeof alertEvents.$inferSelect;

/** A row to insert into `alert_events`. */
export type NewAlertEvent = typeof alertEvents.$inferInsert;

/**
 * Operational incidents: declared by a staff member or opened from a critical alert. Severity, affected components,
 * the timeline (timeline jsonb), and the root cause and action taken at closing.
 *
 * Why: Operational incidents declared by staff or opened from a critical alert (routes /admin/incidents).
 */
export const incidents = pgTable(
  'incidents',
  {
    id: pk(),
    title: text().notNull(),
    severity: text().$type<IncidentSeverity>().notNull(),
    status: text().$type<IncidentStatus>().notNull().default('investigating'),
    components: textList(),
    summary: text().notNull().default(''),
    /** list of timeline lines; the closing action is the `resolved` line (B104) */
    timeline: jsonList(),
    rootCause: text(),
    startedAt: timestampTz().notNull().defaultNow(),
    resolvedAt: timestampTz(),
    alertEventId: fk((): AnyPgColumn => alertEvents.id),
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    resolvedBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('incidents_severity_check', inList(t.severity, INCIDENT_SEVERITIES)),
    check('incidents_status_check', inList(t.status, INCIDENT_STATUSES)),
    index('incidents_status_started_idx').on(t.status, t.startedAt.desc()),
    // One incident per alert (RESOLUTIONS health-commissions-15). A plain unique index lets any number of rows have no
    // alert (NULLs are distinct) and, being a full index, also serves the foreign key.
    uniqueIndex('incidents_alert_event_uq').on(t.alertEventId),
    index('incidents_created_by_idx').on(t.createdBy),
    index('incidents_resolved_by_idx').on(t.resolvedBy),
  ],
);

/** A row read from `incidents`. */
export type Incident = typeof incidents.$inferSelect;

/** A row to insert into `incidents`. */
export type NewIncident = typeof incidents.$inferInsert;

/**
 * Run log of scheduled and background jobs (price sync, ledger integrity check, expired-data deletion, reminders):
 * start, end, result and error. result holds the job summary; the last money integrity result comes from it.
 *
 * Why: Run log of scheduled and background jobs, including the money integrity check (decision 020, routes
 * /admin/system/jobs).
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: pk(),
    job: text().notNull(),
    trigger: text().$type<JobTrigger>().notNull(),
    status: text().$type<JobStatus>().notNull().default('running'),
    startedAt: timestampTz().notNull().defaultNow(),
    finishedAt: timestampTz(),
    /** 0 while the job runs */
    durationMs: integer().notNull().default(0),
    /** how many records the run handled; 0 when it handled none */
    processed: integer().notNull().default(0),
    /** the job summary; the integrity result carries its per-check findings (B99) */
    result: jsonObject(),
    error: text(),
    triggeredBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('job_runs_trigger_check', inList(t.trigger, JOB_TRIGGERS)),
    check('job_runs_status_check', inList(t.status, JOB_STATUSES)),
    check('job_runs_counts_check', sql`${t.durationMs} >= 0 and ${t.processed} >= 0`),
    index('job_runs_job_started_idx').on(t.job, t.startedAt.desc()),
    index('job_runs_running_idx')
      .on(t.job)
      .where(sql`${t.status} = 'running'`),
    index('job_runs_triggered_by_idx').on(t.triggeredBy),
  ],
);

/** A row read from `job_runs`. */
export type JobRun = typeof jobRuns.$inferSelect;

/** A row to insert into `job_runs`. */
export type NewJobRun = typeof jobRuns.$inferInsert;
