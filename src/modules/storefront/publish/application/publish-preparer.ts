// PublishPreparer: the worker's side of a new publish run's draft (feature 31, decision 040, plan 31 section 6.1): claims a `preparing`
// run, takes the services of its scope, names and evaluates every one, and closes the run as a `draft` (or, for an automatic run with a
// row to publish, as `queued`). It writes only the run and its rows: nothing a visitor or a merchant can see.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { DbService } from '../../../../infra/db';
import { AuditService } from '../../../platform';
import type { ListingPublishRun, NewListingPublishItem } from '../../db/schema';
import { listingNamesOfAll } from '../../infra/listing.repository';
import { type BatchInput, assignSlugs, nameAll } from '../domain/naming';
import { type DraftFacts, PublishDraftFacts } from './publish-draft-facts';
import { type DraftRow, buildDraftRow, namingTypeOf } from '../domain/publish-draft';
import { MAX_PUBLISH_ITEMS, type PublishScope } from '../domain/publish-item';
import { publishRunLabel, runErrorText } from '../domain/publish-run';
import {
  beatPrepare,
  claimPrepare,
  closePrepare,
  countDraftRows,
  deleteDraftItems,
  failPrepare,
  insertDraftItems,
  writeDraftRows,
} from '../infra/publish.repository';
import { PublishOutbox } from './publish-outbox';
import { type ScopedService, collectScope } from './publish-scope';

/** How a call of {@link PublishPreparer.run} ended. */
export type PublishPrepareOutcome = 'not_preparing' | 'stopped' | 'draft' | 'queued' | 'failed';

/** Rows inserted in one statement (plan 31 section 6.1 step 3). */
const INSERT_BATCH = 500;

/** Services read, evaluated and heartbeaten in one page (plan 31 section 6.1 step 5). */
const EVALUATE_PAGE = 500;

/** Rows one `UPDATE ... FROM (VALUES ...)` writes (plan 31 section 6.1 step 5). */
const WRITE_BATCH = 200;

/** The options of {@link PublishPreparer.run}. */
export interface PreparePublishOptions {
  /** The most services the run takes (default {@link MAX_PUBLISH_ITEMS}); a test lowers it to reach the cut without 5000 services. */
  readonly maxItems?: number;
}

/**
 * What a draft says when its scope held more services than a run takes.
 *
 * Why: plan 31 section 6.1 step 2: an automatic run (the Quick add hand-over) or a scope that grew since the POST counted it takes the
 * first `limit` services and says so, so the staff member who opens it knows the rest are not in it.
 *
 * @param limit the most services the run takes
 * @returns the sentence the run keeps in `error`
 */
export const scopeTruncatedError = (limit: number): string =>
  `The choice has more than ${limit} services. This run holds the first ${limit}.`;

/** What a draft says when its scope held more than {@link MAX_PUBLISH_ITEMS} services. */
export const SCOPE_TRUNCATED_ERROR = scopeTruncatedError(MAX_PUBLISH_ITEMS);

const errorText = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));

/** Splits a list into pages. */
function pagesOf<T>(list: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let at = 0; at < list.length; at += size) pages.push(list.slice(at, at + size));
  return pages;
}

/**
 * Prepares the draft of a publish run.
 *
 * Why: plan 31 section 6.1 (the model is Quick add, fact 9): the API only inserts the run and writes the outbox event; this does the
 * slow work in the worker (queue `imports`, job `publish_prepare`). Detection is in memory over the whole run, because the cut of a title
 * and the uniqueness of titles and slugs need every title (3.5). Each row is evaluated on the facts of now with its own cost as the cost of
 * now, so `cost_moved` cannot arise in a draft; apply judges every row again on its locked service. A scope `run` copies what staff
 * edited ("Check again", "Review the rest", plan 31 section 5.2).
 *
 * Side effects: `listing_publish_runs` is claimed, beaten and closed; `listing_publish_items` are inserted and written; for an automatic
 * run with a row to publish, one `storefront.publish_apply` outbox event and one audit row by `system`. No service, listing, price,
 * search document or cache key is touched, and the catalog price version does not move.
 *
 * @see docs/briefs/31-bulk-publish.md (section 6.1)
 * @see docs/queues.md (imports)
 */
@Injectable()
export class PublishPreparer {
  private readonly logger = new Logger(PublishPreparer.name);

  constructor(
    private readonly db: DbService,
    private readonly facts: PublishDraftFacts,
    private readonly outbox: PublishOutbox,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Prepares a run's draft.
   *
   * Idempotent: only a `preparing` run that nobody claimed is taken, so a second delivery, a second worker or a run that was cancelled
   * does nothing.
   *
   * @param runId the `listing_publish_runs` row
   * @param options the test seam
   * @returns `not_preparing` when there was nothing to claim; `stopped` when the run was cancelled while it was prepared (nothing more
   *   was written); `draft`, or `queued` for an automatic run with a row to publish
   * @throws {Error} what an unexpected error threw, after the run was closed `failed` (the job shows in the failed list, and a repeat
   *   finds the run claimed)
   */
  async run(runId: number, options: PreparePublishOptions = {}): Promise<PublishPrepareOutcome> {
    const run = await claimPrepare(this.db.db, runId, this.clock.now());
    if (run === undefined) return 'not_preparing';
    try {
      return await this.prepare(run, options.maxItems ?? MAX_PUBLISH_ITEMS);
    } catch (error) {
      this.logger.error(`Publish run ${runId} could not be prepared: ${errorText(error)}`);
      // A failing close must not hide the error that brought us here; the run then stays `preparing` and reads as stalled.
      await failPrepare(this.db.db, runId, runErrorText(error), this.clock.now()).catch((closeError: unknown) => {
        this.logger.error(`Publish run ${runId} could not be closed: ${errorText(closeError)}`);
      });
      throw error;
    }
  }

  /** The steps 2 to 6 of plan 31 section 6.1. */
  private async prepare(run: ListingPublishRun, limit: number): Promise<PublishPrepareOutcome> {
    const db = this.db.db;
    const runId = run.id;
    const scope = run.scope as unknown as PublishScope;
    const { services, truncated } = await collectScope(db, scope, limit);

    // Step 3: the rows, in batches; a copied row arrives with the fields it keeps.
    for (const batch of pagesOf(services, INSERT_BATCH)) {
      await insertDraftItems(
        db,
        batch.map((service) => insertedRow(runId, service)),
      );
      if (!(await beatPrepare(db, runId, this.clock.now()))) return 'stopped';
    }

    // Step 4: the facts of every service (a page at a time), then the naming of the whole run.
    const known = new Map<number, DraftFacts>();
    for (const page of pagesOf(services, EVALUATE_PAGE)) {
      const ids = page.map((service) => service.serviceId);
      const read = await this.facts.read(db, ids);
      for (const [id, facts] of read) known.set(id, facts);
      // A service archived since its row was inserted has nothing to judge: the preview shows live services only.
      await deleteDraftItems(
        db,
        runId,
        ids.filter((id) => !read.has(id)),
      );
      if (!(await beatPrepare(db, runId, this.clock.now()))) return 'stopped';
    }
    const live = services.filter((service) => known.has(service.serviceId));
    const rows = await this.detect(live, known);
    if (!(await beatPrepare(db, runId, this.clock.now()))) return 'stopped';

    // Step 5: the evaluation, a page at a time; one write per WRITE_BATCH rows.
    const evaluatedAt = this.clock.now();
    for (const page of pagesOf(rows, EVALUATE_PAGE)) {
      for (const chunk of pagesOf(page, WRITE_BATCH)) await writeDraftRows(db, runId, chunk, evaluatedAt);
      if (!(await beatPrepare(db, runId, this.clock.now()))) return 'stopped';
    }

    return this.close(run, truncated ? scopeTruncatedError(limit) : null);
  }

  /**
   * Names the whole run and builds every row (plan 31 section 6.1 step 4 and the evaluation of step 5, which is pure).
   *
   * An edited copy keeps its own title and facts: the naming gets its title (`fixedTitle`; the row still takes part in the cut and
   * uniqueness checks) and the row's own brand, carrier and country are put back after it. The slugs are assigned over the rows that
   * have no typed address, against the listings' slugs and the addresses staff typed.
   */
  private async detect(live: readonly ScopedService[], known: ReadonlyMap<number, DraftFacts>): Promise<DraftRow[]> {
    const listings = await listingNamesOfAll(this.db.db);
    const listingSlugs = new Set(listings.map((listing) => listing.slug));
    const inputs: BatchInput[] = live.map((service) => {
      const draft = known.get(service.serviceId)!;
      const base = {
        name: draft.service.name,
        type: namingTypeOf(draft.service.type, draft.service.hasMainInput),
        group: draft.service.categoryName,
      };
      return service.copy?.edited === true ? { ...base, fixedTitle: service.copy.title } : base;
    });
    const named = nameAll(inputs, { listingTitles: listings.map((listing) => listing.publicTitle) });

    const typed = (service: ScopedService): boolean => service.copy?.slugSource === 'staff';
    const taken = new Set(listingSlugs);
    for (const service of live) if (typed(service)) taken.add(service.copy!.slug);
    const automatic = live
      .map((service, index) => ({ id: service.serviceId, slugBase: named[index]!.slugBase, index }))
      .filter(({ index }) => !typed(live[index]!));
    const assigned = assignSlugs(automatic, taken);
    const slugOf = new Map(automatic.map((row, at) => [row.index, assigned[at]!]));

    return live.map((service, index) => {
      const draft = known.get(service.serviceId)!;
      return buildDraftRow({
        serviceId: service.serviceId,
        named: named[index]!,
        assigned: slugOf.get(index) ?? { slug: '', suffixed: false },
        ...(service.copy === undefined ? {} : { copy: service.copy }),
        facts: draft.facts,
        price: draft.price,
        listingSlugs,
      });
    });
  }

  /**
   * Closes the prepare (plan 31 section 6.1 step 6): the total from the rows, `prepared_at`, `draft`; for an automatic run with a row
   * ticked, `queued`, the apply event and the start audit row by `system`. Guarded on `preparing`: a run cancelled meanwhile stays
   * cancelled and nothing else is written.
   */
  private close(run: ListingPublishRun, note: string | null): Promise<PublishPrepareOutcome> {
    return this.db.runInTransaction(async ({ tx }) => {
      const counts = await countDraftRows(tx, run.id);
      const status = run.auto && counts.included > 0 ? 'queued' : 'draft';
      const closed = await closePrepare(tx, run.id, {
        status,
        total: counts.total,
        error: note,
        now: this.clock.now(),
      });
      if (closed === undefined) return 'stopped';
      if (status === 'queued') {
        await this.outbox.applyRequested(tx, run.id);
        await this.audit.record(tx, {
          action: 'started publishing to the storefront',
          entityType: 'publish_run',
          entityId: run.id,
          entityLabel: publishRunLabel(run.id),
          after: {
            scope: closed.scope,
            total: counts.total,
            included: counts.included,
            listed: closed.listed,
            source: closed.source,
            resumed: false,
            requestedBy: closed.requestedBy,
          },
        });
      }
      return status;
    });
  }
}

/** The row inserted for a service of the scope: the pair, and what a copied row keeps (plan 31 section 6.1 step 3). */
function insertedRow(runId: number, service: ScopedService): NewListingPublishItem {
  const copy = service.copy;
  if (copy === undefined) return { runId, serviceId: service.serviceId };
  return {
    runId,
    serviceId: service.serviceId,
    priceMode: copy.priceMode,
    priceOverride: copy.priceOverride?.toWire() ?? null,
    edited: copy.edited,
    ...(copy.edited
      ? {
          detected: { ...copy.detected },
          title: copy.title,
          brand: copy.brand,
          carrier: copy.carrier,
          country: copy.country,
        }
      : {}),
    ...(copy.slugSource === 'staff' ? { slug: copy.slug, slugSource: 'staff' as const } : {}),
  };
}
