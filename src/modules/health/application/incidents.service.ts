// The incident use cases (map routes /admin/incidents*, feature 12b): list, show, declare (on its own or from an alert), update and close, each
// audited. The timeline is written by the server on every status change or update.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { DbService } from '../../../infra/db';
import { isUniqueViolation } from '../../../infra/db/pg-errors';
import { AuditService } from '../../platform';
import type { Incident, IncidentSeverity, IncidentStatus } from '../db/schema';
import { CORE_COMPONENTS } from '../domain/checks';
import {
  type TimelineActor,
  type TimelineLine,
  declaredTimeline,
  hasRootCause,
  nextLine,
} from '../domain/incident-timeline';
import { gatewaysForHealth, suppliersForHealth } from '../infra/foreign-reads.repository';
import {
  type IncidentListField,
  type IncidentRow,
  findIncidentRow,
  incidentOfAlert,
  insertIncident,
  listIncidentRows,
  lockIncident,
  updateIncidentRow,
} from '../infra/incidents.repository';
import { actorOf } from './actor';
import { orUnavailable } from './database-guard';

/** An incident as the console reads it (`Incident`). */
export interface IncidentView {
  id: number;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  components: string[];
  summary: string;
  timeline: TimelineLine[];
  rootCause: string | null;
  startedAt: string;
  resolvedAt: string | null;
  alertEventId: number | null;
  createdBy: TimelineActor | null;
  resolvedBy: TimelineActor | null;
  createdAt: string;
  updatedAt: string | null;
}

/** The fields of a new incident (the contract has validated them). */
export interface DeclareIncidentInput {
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly components: string[];
  readonly summary: string;
  readonly alertEventId?: number | null | undefined;
}

/** The fields of an update: only the ones present are applied. */
export interface UpdateIncidentInput {
  readonly title?: string | undefined;
  readonly severity?: IncidentSeverity | undefined;
  readonly components?: string[] | undefined;
  readonly summary?: string | undefined;
  readonly status?: IncidentStatus | undefined;
  readonly update?: string | undefined;
  readonly rootCause?: string | undefined;
}

/**
 * Maps an incident row to the wire.
 *
 * @param row the incident with the names of the staff who declared and closed it
 * @returns the console's `Incident`, the timeline oldest line first
 */
export function toIncidentView({ incident, createdBy, resolvedBy }: IncidentRow): IncidentView {
  return {
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    components: incident.components,
    summary: incident.summary,
    timeline: incident.timeline as TimelineLine[],
    rootCause: incident.rootCause,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    alertEventId: incident.alertEventId,
    createdBy,
    resolvedBy,
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
  };
}

const invalid = (field: string, message: string, code = 'invalid') =>
  new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
const ALERT_HAS_INCIDENT = () => invalid('alertEventId', 'This alert already has an incident.', 'duplicate');
const NOT_FOUND = () => new AppError('NOT_FOUND', { detail: 'No incident has this id.' });

/**
 * Declares, updates and closes incidents.
 *
 * Why: scenario system-alert steps 7 and 11: when the impact reaches orders a staff member declares an incident (severity, the affected components,
 * a short summary) linked to the alert, its timeline starts at "investigating", and at the end it is closed with the root cause and the action
 * taken, so the log stays the record of why a delay happened (ANSWERS Q8: the action taken is the closing update, written as the `resolved` line).
 * One incident per alert (health-commissions-15); a closed incident is a record and cannot be changed (`INCIDENT_CLOSED`).
 *
 * Side effects: writes `incidents`, one `audit_logs` row per write, and drops the cached health snapshot after the commit (the health page lists open
 * incidents). Reads answer `503 DATABASE_UNAVAILABLE` when Postgres cannot be reached (health-commissions-17).
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists incidents.
   *
   * @param query the parsed list request
   * @returns the page and the exact total
   * @throws {AppError} `DATABASE_UNAVAILABLE`
   */
  async list(query: ParsedListQuery<IncidentListField>): Promise<{ rows: IncidentView[]; total: number }> {
    const { rows, total } = await orUnavailable(() => listIncidentRows(this.db.db, query));
    return { rows: rows.map(toIncidentView), total };
  }

  /**
   * Shows one incident.
   *
   * @param id the incident id
   * @returns the incident with its timeline
   * @throws {AppError} `NOT_FOUND`; `DATABASE_UNAVAILABLE`
   */
  async show(id: number): Promise<IncidentView> {
    const row = await orUnavailable(() => findIncidentRow(this.db.db, id));
    if (!row) throw NOT_FOUND();
    return toIncidentView(row);
  }

  /**
   * Declares an incident.
   *
   * @param staffId the staff member who declares it
   * @param input the validated fields
   * @returns the new incident (`investigating`, one timeline line)
   * @throws {AppError} `VALIDATION_FAILED` (422 on `components` for an unknown key; on `alertEventId` for no such alert or one that already has an incident)
   */
  async declare(staffId: number, input: DeclareIncidentInput): Promise<IncidentView> {
    const now = this.clock.now();
    const actor = actorOf(staffId);
    await this.assertKnownComponents(input.components);
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const alertId = input.alertEventId ?? null;
      if (alertId !== null) {
        const linked = await incidentOfAlert(tx, alertId);
        if (!linked) throw invalid('alertEventId', 'No such alert.', 'not_found');
        if (linked.incidentId !== null) throw ALERT_HAS_INCIDENT();
      }
      let incident: Incident;
      try {
        incident = await insertIncident(tx, {
          title: input.title,
          severity: input.severity,
          status: 'investigating',
          components: input.components,
          summary: input.summary,
          timeline: declaredTimeline(now, actor),
          startedAt: now,
          alertEventId: alertId,
          createdBy: staffId,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        // Another declaration for the same alert won the race: the unique index has the last word.
        if (isUniqueViolation(error, 'incidents_alert_event_uq')) throw ALERT_HAS_INCIDENT();
        throw error;
      }
      work.afterCommit(async () => {
        await this.cache.del(this.keys.healthSnapshot());
      });
      await this.audit.record(tx, {
        action: 'opened incident',
        entityType: 'incident',
        entityId: incident.id,
        entityLabel: incident.title,
        after: {
          title: incident.title,
          severity: incident.severity,
          components: incident.components,
          alertEventId: alertId,
        },
      });
      return toIncidentView((await findIncidentRow(tx, incident.id))!);
    });
  }

  /**
   * Updates or closes an incident.
   *
   * @param staffId the staff member who changes it
   * @param id the incident id
   * @param changes the fields to change
   * @returns the updated incident
   * @throws {AppError} `NOT_FOUND`; `INCIDENT_CLOSED` (409) for any change to a resolved incident; `VALIDATION_FAILED` (422 on `rootCause` when closing without
   *   one of at least 10 characters, on `components` for an unknown key)
   */
  async update(staffId: number, id: number, changes: UpdateIncidentInput): Promise<IncidentView> {
    const now = this.clock.now();
    const actor = actorOf(staffId);
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const before = await lockIncident(tx, id);
      if (!before) throw NOT_FOUND();
      if (before.status === 'resolved') {
        throw new AppError('INCIDENT_CLOSED', { detail: 'A closed incident is a record and cannot be changed.' });
      }
      if (changes.components !== undefined) {
        // A key already on the incident stays valid even if its supplier or gateway was deleted since (ANSWERS Q19).
        await this.assertKnownComponents(changes.components.filter((key) => !before.components.includes(key)));
      }
      if (changes.status === 'resolved' && !hasRootCause(changes.rootCause, before.rootCause)) {
        throw invalid('rootCause', 'Enter the root cause (at least 10 characters) to close the incident.', 'required');
      }
      const next = nextLine(before.status, { status: changes.status, update: changes.update }, now, actor);
      const rootCause = changes.rootCause?.trim();
      const after = await updateIncidentRow(tx, id, {
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.severity === undefined ? {} : { severity: changes.severity }),
        ...(changes.components === undefined ? {} : { components: changes.components }),
        ...(changes.summary === undefined ? {} : { summary: changes.summary }),
        ...(rootCause === undefined ? {} : { rootCause: rootCause === '' ? null : rootCause }),
        status: next.status,
        ...(next.line ? { timeline: [...(before.timeline as TimelineLine[]), next.line] } : {}),
        ...(next.closes ? { resolvedAt: now, resolvedBy: staffId } : {}),
        updatedAt: now,
      });
      work.afterCommit(async () => {
        await this.cache.del(this.keys.healthSnapshot());
      });
      await this.audit.record(tx, {
        action: next.closes ? 'closed incident' : 'updated incident',
        entityType: 'incident',
        entityId: id,
        entityLabel: after.title,
        before: {
          title: before.title,
          severity: before.severity,
          status: before.status,
          components: before.components,
        },
        after: {
          title: after.title,
          severity: after.severity,
          status: after.status,
          components: after.components,
          rootCause: after.rootCause,
        },
      });
      return toIncidentView((await findIncidentRow(tx, id))!);
    });
  }

  /** Refuses a component key the health page does not know: the core components, `supplier:<id>` and `gateway:<id>` of records that exist. */
  private async assertKnownComponents(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const core = new Set<string>(CORE_COMPONENTS);
    const rest = keys.filter((key) => !core.has(key));
    if (rest.length === 0) return;
    const [suppliers, gateways] = await Promise.all([suppliersForHealth(this.db.db), gatewaysForHealth(this.db.db)]);
    const known = new Set([...suppliers.map((s) => `supplier:${s.id}`), ...gateways.map((g) => `gateway:${g.id}`)]);
    const unknown = rest.find((key) => !known.has(key));
    if (unknown !== undefined) throw invalid('components', `Unknown component: ${unknown}.`, 'unknown');
  }
}
