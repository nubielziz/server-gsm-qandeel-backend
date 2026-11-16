// SearchAdminService: the use cases of the console's search tools (feature 29, plan sections 5.1 and 6): synonyms, pin rules, hidden
// terms, the preview, the index status and "Rebuild index". Every write is one transaction: the row, the audit row and the outbox event
// that makes the worker push the set to Typesense; nothing talks to the engine inside a write.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import type { ParsedListQuery } from '../../../../common/contract';
import { AppError, type FieldError } from '../../../../common/errors';
import { type DbExecutor, DbService, isUniqueViolation } from '../../../../infra/db';
import { QueuesService } from '../../../../infra/queues';
import { SearchMetrics, TypesenseClient } from '../../../../infra/search';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { StorefrontServices } from '../../../catalog';
import { JobRunsService } from '../../../health';
import { AuditService } from '../../../platform';
import type { SearchHiddenTerm, SearchPin, SearchSynonym } from '../../db/schema';
import { listedServiceIdsIn } from '../../infra/listing.repository';
import { normaliseQuery } from '../domain/normalise';
import { RELEVANCE_SORT, resultsSearch } from '../domain/ranking';
import { SERVICES_SCHEMA_VERSION } from '../domain/services-schema';
import { cleanHiddenTerm, cleanPin, cleanSynonym, ruleApplies, type RuleProblem } from '../domain/settings-rules';
import {
  deleteHiddenTerm,
  deletePin,
  deleteSynonym,
  findHiddenTerm,
  findPin,
  findSynonym,
  insertHiddenTerm,
  insertPin,
  insertSynonym,
  listHiddenTermRows,
  listPinRows,
  listSynonymRows,
  updatePin,
  updateSynonym,
} from '../infra/search-admin.repository';
import { englishListingsOf } from '../infra/search-source.repository';
import { enabledPins, readIndexState } from '../infra/search-tables.repository';
import { SearchCollections } from './search-collections';
import { SearchEngine } from './search-engine';
import { SearchSignals } from './search-signals';
import { SearchableIds } from './searchable-ids';

/** The most services the index status counts (a page of ids at a time). */
const EXPECTED_PAGES = 20;
const EXPECTED_PAGE_SIZE = 1000;
const REBUILD_JOB = 'search_rebuild';

/** A synonym on the wire. */
export interface SynonymView {
  readonly id: number;
  readonly kind: 'multi' | 'one_way';
  readonly root: string | null;
  readonly terms: string[];
  readonly isEnabled: boolean;
  readonly note: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A pin rule on the wire, with the titles of its services. */
export interface PinView {
  readonly id: number;
  readonly query: string;
  readonly match: 'exact' | 'contains';
  readonly pinned: Array<{ serviceId: number; position: number; title: string }>;
  readonly hidden: Array<{ serviceId: number; title: string }>;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly isEnabled: boolean;
  readonly note: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A hidden term on the wire. */
export interface HiddenTermView {
  readonly id: number;
  readonly term: string;
  readonly note: string;
  readonly createdAt: string;
}

const invalid = (problems: readonly RuleProblem[]): AppError =>
  new AppError('VALIDATION_FAILED', { errors: problems.map((problem): FieldError => ({ ...problem })) });

const missing = (what: string): AppError => new AppError('NOT_FOUND', { detail: `No ${what} has this id.` });

const synonymView = (row: SearchSynonym): SynonymView => ({
  id: row.id,
  kind: row.kind,
  root: row.root,
  terms: [...row.terms],
  isEnabled: row.isEnabled,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Manages the search settings and reports the index state.
 *
 * Why: staff own synonyms, pins and hidden terms (owner question 5): Postgres is the truth and the worker pushes the whole set to
 * Typesense after the `search.settings_changed` event (never edited in Typesense by hand). Every write is audited (`search_synonym`,
 * `search_pin`, `search_hidden_term`, `search_index`) and writes its event in its own transaction. A pinned or hidden service must have
 * a switched-on English page, or the rule would point at nothing the shop shows (422 with the field).
 *
 * Side effects: writes `search_synonyms`, `search_pins`, `search_hidden_terms`, `audit_logs` and `outbox_events`; a rebuild request also
 * inserts a `job_runs` row (`search_rebuild`, manual); reads the index state, the engine's health and the queue counts.
 *
 * @see docs/contract/endpoints/storefront.md (the `/admin/search` sections)
 */
@Injectable()
export class SearchAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly signals: SearchSignals,
    private readonly runs: JobRunsService,
    private readonly client: TypesenseClient,
    private readonly collections: SearchCollections,
    private readonly engine: SearchEngine,
    private readonly searchable: SearchableIds,
    private readonly services: StorefrontServices,
    private readonly queues: QueuesService,
    private readonly metrics: SearchMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- synonyms ---------------------------------------------------------------------------------------------------------------

  /**
   * Lists synonyms.
   *
   * @param query the parsed list request
   * @returns the page and the total
   */
  async listSynonyms(query: ParsedListQuery): Promise<{ rows: SynonymView[]; total: number }> {
    const { rows, total } = await listSynonymRows(this.db.db, query);
    return { rows: rows.map(synonymView), total };
  }

  /**
   * Creates a synonym.
   *
   * @param input kind, root, terms, switch and note
   * @param staffId the staff member
   * @returns the synonym
   * @throws {AppError} `VALIDATION_FAILED` (a term empty, repeated or too long; 2-20 terms; a one-way synonym without a root)
   */
  async createSynonym(
    input: {
      kind: 'multi' | 'one_way';
      root?: string | null | undefined;
      terms: string[];
      isEnabled?: boolean | undefined;
      note?: string | undefined;
    },
    staffId: number,
  ): Promise<SynonymView> {
    const clean = cleanSynonym(input);
    if (!clean.ok) throw invalid(clean.problems);
    return this.db.runInTransaction(async ({ tx }) => {
      const row = await insertSynonym(tx, {
        ...clean.value,
        isEnabled: input.isEnabled ?? true,
        note: input.note ?? '',
        createdBy: staffId,
      });
      await this.signals.settingsChanged(tx, 'synonyms', row.id);
      await this.audit.record(tx, {
        action: 'created search synonym',
        entityType: 'search_synonym',
        entityId: row.id,
        entityLabel: row.terms.join(', ').slice(0, 150),
        after: { kind: row.kind, root: row.root, terms: row.terms, isEnabled: row.isEnabled },
      });
      return synonymView(row);
    });
  }

  /**
   * Changes a synonym.
   *
   * @param id the synonym
   * @param input the keys to change
   * @returns the synonym
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED` for the result
   */
  async updateSynonym(
    id: number,
    input: {
      kind?: 'multi' | 'one_way' | undefined;
      root?: string | null | undefined;
      terms?: string[] | undefined;
      isEnabled?: boolean | undefined;
      note?: string | undefined;
    },
  ): Promise<SynonymView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await findSynonym(tx, id, true);
      if (!before) throw missing('synonym');
      const clean = cleanSynonym({
        kind: input.kind ?? before.kind,
        root: input.root === undefined ? before.root : input.root,
        terms: input.terms ?? before.terms,
      });
      if (!clean.ok) throw invalid(clean.problems);
      const row = await updateSynonym(tx, id, {
        ...clean.value,
        ...(input.isEnabled === undefined ? {} : { isEnabled: input.isEnabled }),
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      await this.signals.settingsChanged(tx, 'synonyms', row.id);
      await this.audit.record(tx, {
        action: 'changed search synonym',
        entityType: 'search_synonym',
        entityId: row.id,
        entityLabel: row.terms.join(', ').slice(0, 150),
        before: { kind: before.kind, root: before.root, terms: before.terms, isEnabled: before.isEnabled },
        after: { kind: row.kind, root: row.root, terms: row.terms, isEnabled: row.isEnabled },
      });
      return synonymView(row);
    });
  }

  /**
   * Deletes a synonym.
   *
   * @param id the synonym
   * @throws {AppError} `NOT_FOUND`
   */
  async deleteSynonym(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const before = await findSynonym(tx, id, true);
      if (!before) throw missing('synonym');
      await deleteSynonym(tx, id);
      await this.signals.settingsChanged(tx, 'synonyms', id);
      await this.audit.record(tx, {
        action: 'deleted search synonym',
        entityType: 'search_synonym',
        entityId: id,
        entityLabel: before.terms.join(', ').slice(0, 150),
        before: { kind: before.kind, root: before.root, terms: before.terms, isEnabled: before.isEnabled },
      });
    });
  }

  // --- pins -------------------------------------------------------------------------------------------------------------------

  /**
   * Lists pin rules with the titles of their services.
   *
   * @param query the parsed list request
   * @returns the page and the total
   */
  async listPins(query: ParsedListQuery): Promise<{ rows: PinView[]; total: number }> {
    const { rows, total } = await listPinRows(this.db.db, query);
    return { rows: await this.pinViews(rows), total };
  }

  /**
   * Creates a pin rule.
   *
   * @param input query, match, pinned and hidden services, window, switch and note
   * @param staffId the staff member
   * @returns the rule
   * @throws {AppError} `VALIDATION_FAILED` (cleaning, a service without a switched-on English page, an end before the start);
   *   `CONFLICT` (the query and match type exist)
   */
  async createPin(input: CreatePinInput, staffId: number): Promise<PinView> {
    const clean = cleanPin(input);
    if (!clean.ok) throw invalid(clean.problems);
    const window = this.windowOf(input.startsAt ?? null, input.endsAt ?? null);
    return this.db.runInTransaction(async ({ tx }) => {
      await this.requireListed(
        tx,
        clean.value.pinned.map((pin) => pin.serviceId),
        clean.value.hidden,
        input,
      );
      let row: SearchPin;
      try {
        row = await insertPin(tx, {
          ...clean.value,
          match: input.match,
          ...window,
          isEnabled: input.isEnabled ?? true,
          note: input.note ?? '',
          createdBy: staffId,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'search_pins_query_match_uq')) throw this.exists(clean.value.query);
        throw error;
      }
      await this.signals.settingsChanged(tx, 'pins', row.id);
      await this.audit.record(tx, {
        action: 'created pinned search result for',
        entityType: 'search_pin',
        entityId: row.id,
        entityLabel: row.query,
        after: this.pinAudit(row),
      });
      return (await this.pinViews([row], tx))[0]!;
    });
  }

  /**
   * Changes a pin rule.
   *
   * @param id the rule
   * @param input the keys to change
   * @returns the rule
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_FAILED`; `CONFLICT`
   */
  async updatePin(id: number, input: PinInput): Promise<PinView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const before = await findPin(tx, id, true);
      if (!before) throw missing('pin rule');
      const clean = cleanPin({
        query: input.query ?? before.query,
        pinned: input.pinned ?? before.pinned,
        hidden: input.hidden ?? before.hidden,
      });
      if (!clean.ok) throw invalid(clean.problems);
      const window = this.windowOf(
        input.startsAt === undefined ? before.startsAt : input.startsAt,
        input.endsAt === undefined ? before.endsAt : input.endsAt,
      );
      await this.requireListed(
        tx,
        clean.value.pinned.map((pin) => pin.serviceId),
        clean.value.hidden,
        input,
      );
      let row: SearchPin;
      try {
        row = await updatePin(tx, id, {
          ...clean.value,
          ...(input.match === undefined ? {} : { match: input.match }),
          ...window,
          ...(input.isEnabled === undefined ? {} : { isEnabled: input.isEnabled }),
          ...(input.note === undefined ? {} : { note: input.note }),
        });
      } catch (error) {
        if (isUniqueViolation(error, 'search_pins_query_match_uq')) throw this.exists(clean.value.query);
        throw error;
      }
      await this.signals.settingsChanged(tx, 'pins', row.id);
      await this.audit.record(tx, {
        action: 'changed pinned search result for',
        entityType: 'search_pin',
        entityId: row.id,
        entityLabel: row.query,
        before: this.pinAudit(before),
        after: this.pinAudit(row),
      });
      return (await this.pinViews([row], tx))[0]!;
    });
  }

  /**
   * Deletes a pin rule.
   *
   * @param id the rule
   * @throws {AppError} `NOT_FOUND`
   */
  async deletePin(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const before = await findPin(tx, id, true);
      if (!before) throw missing('pin rule');
      await deletePin(tx, id);
      await this.signals.settingsChanged(tx, 'pins', id);
      await this.audit.record(tx, {
        action: 'deleted pinned search result for',
        entityType: 'search_pin',
        entityId: id,
        entityLabel: before.query,
        before: this.pinAudit(before),
      });
    });
  }

  // --- hidden terms -----------------------------------------------------------------------------------------------------------

  /**
   * Lists the hidden popular terms.
   *
   * @param query the parsed list request
   * @returns the page and the total
   */
  async listHiddenTerms(query: ParsedListQuery): Promise<{ rows: HiddenTermView[]; total: number }> {
    const { rows, total } = await listHiddenTermRows(this.db.db, query);
    return { rows: rows.map(hiddenView), total };
  }

  /**
   * Hides a term from the popular searches.
   *
   * @param input the term and a note
   * @param staffId the staff member
   * @returns the hidden term
   * @throws {AppError} `VALIDATION_FAILED`; `CONFLICT` (already hidden)
   */
  async hideTerm(input: { term: string; note?: string | undefined }, staffId: number): Promise<HiddenTermView> {
    const clean = cleanHiddenTerm(input.term);
    if (!clean.ok) throw invalid(clean.problems);
    return this.db.runInTransaction(async ({ tx }) => {
      let row: SearchHiddenTerm;
      try {
        row = await insertHiddenTerm(tx, { term: clean.value, note: input.note ?? '', createdBy: staffId });
      } catch (error) {
        if (isUniqueViolation(error, 'search_hidden_terms_term_uq')) {
          throw new AppError('CONFLICT', {
            detail: 'This term is already hidden.',
            errors: [{ field: 'term', code: 'exists', message: 'This term is already hidden.' }],
          });
        }
        throw error;
      }
      await this.signals.settingsChanged(tx, 'hidden_terms', row.id);
      await this.audit.record(tx, {
        action: 'hid search term from popular searches',
        entityType: 'search_hidden_term',
        entityId: row.id,
        entityLabel: row.term,
        after: { term: row.term },
      });
      return hiddenView(row);
    });
  }

  /**
   * Shows a hidden term again.
   *
   * @param id the hidden term
   * @throws {AppError} `NOT_FOUND`
   */
  async showTerm(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const before = await findHiddenTerm(tx, id);
      if (!before) throw missing('hidden term');
      await deleteHiddenTerm(tx, id);
      await this.signals.settingsChanged(tx, 'hidden_terms', id);
      await this.audit.record(tx, {
        action: 'showed search term in popular searches',
        entityType: 'search_hidden_term',
        entityId: id,
        entityLabel: before.term,
        before: { term: before.term },
      });
    });
  }

  // --- preview, status, rebuild -----------------------------------------------------------------------------------------------

  /**
   * Previews a search: the first 10 services with the rules applied.
   *
   * @param text the query
   * @returns the hits (`pinned` marks a pin's) and the services a rule keeps out of this query
   * @throws {AppError} `UNAVAILABLE` when the engine does not answer (a preview has no fallback)
   */
  async preview(text: string): Promise<{
    engine: 'typesense';
    hits: Array<{ serviceId: number; title: string; position: number; pinned: boolean }>;
    hiddenIds: number[];
  }> {
    const query = normaliseQuery(text);
    const alias = this.collections.names.alias('services');
    const unavailable = (): Promise<never> =>
      Promise.reject(
        new AppError('UNAVAILABLE', { detail: 'The search engine is not answering right now.', retryAfterSeconds: 15 }),
      );
    const outcome = await this.engine.run(
      'results',
      async (client, timeoutMs) => {
        const base = { sortBy: RELEVANCE_SORT, offset: 0, highlight: false } as const;
        const [curated, plain] = await client.multiSearch<{ id: string }>(
          [
            resultsSearch(alias, query, { ...base, limit: 10 }),
            { ...resultsSearch(alias, query, { ...base, limit: 50 }), enable_curations: false },
          ],
          { timeoutMs },
        );
        return { curated: curated!, plain: plain! };
      },
      unavailable,
    );
    if (outcome.engine === 'fallback') return unavailable();
    const db = this.db.db;
    const pins = (await enabledPins(db)).filter(
      (rule) =>
        ruleApplies(rule, query) &&
        (rule.startsAt === null || rule.startsAt <= this.clock.now()) &&
        (rule.endsAt === null || rule.endsAt > this.clock.now()),
    );
    const ids = outcome.value.curated.hits.map((hit) => Number(hit.document.id));
    const plainIds = new Set(outcome.value.plain.hits.map((hit) => Number(hit.document.id)));
    const hiddenIds = [...new Set(pins.flatMap((rule) => rule.hidden))].filter(
      (id) => plainIds.has(id) && !ids.includes(id),
    );
    const titles = await englishListingsOf(db, [...ids, ...hiddenIds]);
    return {
      engine: 'typesense',
      hits: outcome.value.curated.hits.map((hit, index) => ({
        serviceId: Number(hit.document.id),
        title: titles.get(Number(hit.document.id))?.publicTitle ?? '(no English page)',
        position: index + 1,
        pinned: hit.curated === true,
      })),
      hiddenIds,
    };
  }

  /**
   * Reads the index status.
   *
   * @returns the engine state, the counts the worker last wrote, the jobs and the last error
   */
  async indexStatus(): Promise<IndexStatusView> {
    const db = this.db.db;
    const [state, running, expected, jobs, status] = await Promise.all([
      readIndexState(db),
      this.runs.findRunning(REBUILD_JOB),
      this.expectedDocuments(),
      this.jobCounts(),
      this.engineStatus(),
    ]);
    return {
      engine: { status, version: state?.engineVersion ?? null, memoryBytes: state?.memoryBytes ?? null },
      schemaVersion: SERVICES_SCHEMA_VERSION,
      collection: state?.servicesCollection ?? null,
      documents: state?.documents ?? 0,
      expectedDocuments: expected,
      lastSyncAt: state?.lastSyncAt?.toISOString() ?? null,
      lastReconcileAt: state?.lastReconcileAt?.toISOString() ?? null,
      lastRebuildAt: state?.lastRebuildAt?.toISOString() ?? null,
      lastTermsBuildAt: state?.lastTermsBuildAt?.toISOString() ?? null,
      queued: jobs.queued,
      failed: jobs.failed,
      rebuild: { running: running !== undefined, startedAt: running?.startedAt.toISOString() ?? null },
      lastError: state?.lastError ?? null,
    };
  }

  /**
   * Asks for a rebuild of the index.
   *
   * Why: the route records the run first (`job_runs`, manual, one at a time), then writes the request event and the audit row in one
   * transaction; the worker's `search_rebuild` records its work on that run. The route never waits for the engine.
   *
   * @param staffId the staff member
   * @returns the running run
   * @throws {AppError} `JOB_ALREADY_RUNNING` (409); `UNAVAILABLE` (503) when search is switched off
   */
  async requestRebuild(staffId: number): Promise<{ running: boolean; startedAt: string }> {
    if (!this.config.search.enabled) {
      throw new AppError('UNAVAILABLE', {
        detail: 'Search is switched off (SEARCH_ENABLED=false): there is no index to rebuild.',
      });
    }
    const run = await this.runs.start({ job: REBUILD_JOB, trigger: 'manual', triggeredBy: staffId, overlap: 'refuse' });
    try {
      await this.db.runInTransaction(async ({ tx }) => {
        await this.signals.rebuildRequested(tx, staffId, run.id);
        await this.audit.record(tx, {
          action: 'asked for a rebuild of the search index',
          entityType: 'search_index',
          entityId: 1,
          entityLabel: 'Search index',
          after: { runId: run.id },
        });
      });
    } catch (error) {
      await this.runs.finish(run.id, { status: 'failed', error: 'The rebuild could not be requested.' });
      throw error;
    }
    return { running: true, startedAt: run.startedAt.toISOString() };
  }

  // --- helpers ----------------------------------------------------------------------------------------------------------------

  private async engineStatus(): Promise<'ok' | 'down' | 'not_ready' | 'disabled'> {
    if (!this.config.search.enabled) return 'disabled';
    try {
      const health = await this.client.health();
      if (!health.ok) return 'down';
      return (await this.client.getAlias(this.collections.names.alias('services'), { timeoutMs: 1000 })) === null
        ? 'not_ready'
        : 'ok';
    } catch {
      return 'down';
    }
  }

  private async jobCounts(): Promise<{ queued: number; failed: number }> {
    try {
      const counts = await Promise.all(
        (['search-index', 'maintenance'] as const).map((name) =>
          this.queues.queue(name).getJobCounts('waiting', 'delayed', 'prioritized', 'failed'),
        ),
      );
      return {
        queued: counts.reduce((sum, c) => sum + (c.waiting ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0), 0),
        failed: counts.reduce((sum, c) => sum + (c.failed ?? 0), 0),
      };
    } catch {
      return { queued: 0, failed: 0 };
    }
  }

  /** How many services the shop may sell and has an English page for: counted for at most 20 000 services. */
  private async expectedDocuments(): Promise<number> {
    const db = this.db.db;
    const groupId = await this.searchable.retailGroupId(db);
    if (groupId === undefined) return 0;
    let after = 0;
    let count = 0;
    for (let page = 0; page < EXPECTED_PAGES; page += 1) {
      const ids = await this.services.pricedPage(db, groupId, after, EXPECTED_PAGE_SIZE);
      if (ids.length === 0) break;
      count += (await listedServiceIdsIn(db, ids, 'en')).size;
      after = ids[ids.length - 1]!;
      if (ids.length < EXPECTED_PAGE_SIZE) break;
    }
    return count;
  }

  private windowOf(
    startsAt: Date | string | null,
    endsAt: Date | string | null,
  ): { startsAt: Date | null; endsAt: Date | null } {
    const start = startsAt === null ? null : new Date(startsAt);
    const end = endsAt === null ? null : new Date(endsAt);
    if (start && end && end <= start) {
      throw invalid([{ field: 'endsAt', code: 'invalid', message: 'The end must be after the start.' }]);
    }
    return { startsAt: start, endsAt: end };
  }

  /** A pinned or hidden service must have a switched-on English page (422 with the field). */
  private async requireListed(
    tx: DbExecutor,
    pinned: readonly number[],
    hidden: readonly number[],
    input: PinInput,
  ): Promise<void> {
    const listed = await listedServiceIdsIn(tx, [...pinned, ...hidden], 'en');
    const problems: RuleProblem[] = [];
    if (input.pinned !== undefined) {
      pinned.forEach((serviceId, index) => {
        if (!listed.has(serviceId)) {
          problems.push({
            field: `pinned.${index}.serviceId`,
            code: 'not_listed',
            message: 'This service has no switched-on English page.',
          });
        }
      });
    }
    if (input.hidden !== undefined) {
      hidden.forEach((serviceId, index) => {
        if (!listed.has(serviceId)) {
          problems.push({
            field: `hidden.${index}`,
            code: 'not_listed',
            message: 'This service has no switched-on English page.',
          });
        }
      });
    }
    if (problems.length > 0) throw invalid(problems);
  }

  private exists(query: string): AppError {
    return new AppError('CONFLICT', {
      detail: `A pin rule for "${query}" with this match type already exists.`,
      errors: [{ field: 'query', code: 'exists', message: 'A rule for this query and match type exists.' }],
    });
  }

  private pinAudit(row: SearchPin): Record<string, unknown> {
    return {
      query: row.query,
      match: row.match,
      pinned: row.pinned,
      hidden: row.hidden,
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt?.toISOString() ?? null,
      isEnabled: row.isEnabled,
    };
  }

  private async pinViews(rows: readonly SearchPin[], executor: DbExecutor = this.db.db): Promise<PinView[]> {
    const titles = await englishListingsOf(executor, [
      ...new Set(rows.flatMap((row) => [...row.pinned.map((pin) => pin.serviceId), ...row.hidden])),
    ]);
    const title = (serviceId: number) => titles.get(serviceId)?.publicTitle ?? '(no English page)';
    return rows.map((row) => ({
      id: row.id,
      query: row.query,
      match: row.match,
      pinned: row.pinned.map((pin) => ({
        serviceId: pin.serviceId,
        position: pin.position,
        title: title(pin.serviceId),
      })),
      hidden: row.hidden.map((serviceId) => ({ serviceId, title: title(serviceId) })),
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt?.toISOString() ?? null,
      isEnabled: row.isEnabled,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}

/** The keys a pin write may carry. */
export interface PinInput {
  readonly query?: string | undefined;
  readonly match?: 'exact' | 'contains' | undefined;
  readonly pinned?: Array<{ serviceId: number; position: number }> | undefined;
  readonly hidden?: number[] | undefined;
  readonly startsAt?: string | null | undefined;
  readonly endsAt?: string | null | undefined;
  readonly isEnabled?: boolean | undefined;
  readonly note?: string | undefined;
}

/** What a pin rule is created with (every key but the window, the switch and the note is required). */
export interface CreatePinInput extends PinInput {
  readonly query: string;
  readonly match: 'exact' | 'contains';
  readonly pinned: Array<{ serviceId: number; position: number }>;
  readonly hidden: number[];
}

/** The index status as the console reads it. */
export interface IndexStatusView {
  readonly engine: {
    status: 'ok' | 'down' | 'not_ready' | 'disabled';
    version: string | null;
    memoryBytes: number | null;
  };
  readonly schemaVersion: number;
  readonly collection: string | null;
  readonly documents: number;
  readonly expectedDocuments: number;
  readonly lastSyncAt: string | null;
  readonly lastReconcileAt: string | null;
  readonly lastRebuildAt: string | null;
  readonly lastTermsBuildAt: string | null;
  readonly queued: number;
  readonly failed: number;
  readonly rebuild: { running: boolean; startedAt: string | null };
  readonly lastError: string | null;
}

const hiddenView = (row: SearchHiddenTerm): HiddenTermView => ({
  id: row.id,
  term: row.term,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
});
