// Helpers for the bulk publish tests (feature 31, plan 31 section 8.3): the publisher of a test app, the input of a row prepared
// now (the preview's cost and price as the database holds them), one row published in its own transaction, as the runner does, what
// that transaction wrote, and a run seeded straight into its two tables with the moves the routes make (queue, cancel, switch).
import { asc, eq, sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '@src/common/clock';
import { Money } from '@src/common/money';
import { type Database, type DbExecutor, DbService, type Transaction, schema as s } from '@src/infra/db';
import { RetailPrices, RetailPricing } from '@src/modules/catalog';
import { AuditService } from '@src/modules/platform';
import {
  ListingPublisher,
  type PublishInput,
  type PublishOutcome,
} from '@src/modules/storefront/application/listing-publisher';
import type {
  ListingPublishItem,
  NewListingPublishItem,
  NewListingPublishRun,
} from '@src/modules/storefront/db/schema';
import { PublishOutbox } from '@src/modules/storefront/publish/application/publish-outbox';
import { NAMING_RULES_VERSION } from '@src/modules/storefront/publish/domain/naming';
import {
  type PriceRow,
  SWITCH_STALLED_ERROR,
  normalisePriceMode,
} from '@src/modules/storefront/publish/domain/publish-item';
import {
  cancelRunRow,
  closeStalledSwitch,
  countItemResults,
  lockRun,
  moveRunToQueued,
  queueRunSwitch,
  reopenFailedItems,
} from '@src/modules/storefront/publish/infra/publish.repository';
import { SearchSignals } from '@src/modules/storefront/search/application/search-signals';
import type { TestApp } from './app';

/** The fields of a {@link PublishInput} a test may set; `price` takes any part of the row's price choice and figures. */
export type PublishInputOverrides = Partial<Omit<PublishInput, 'price'>> & { readonly price?: Partial<PriceRow> };

/**
 * The publisher of a test app, built from the app's providers (the publish module of a later slice registers it).
 *
 * @param t the test app
 * @param overrides a stand-in for a collaborator (a test that makes the price writer fail)
 * @returns the publisher
 */
export function publisherOf(t: TestApp, overrides: { readonly retail?: RetailPrices } = {}): ListingPublisher {
  const get = <T>(token: abstract new (...args: never[]) => T): T => t.app.get(token, { strict: false });
  return new ListingPublisher(
    overrides.retail ?? get(RetailPrices),
    get(RetailPricing),
    get(AuditService),
    get(SearchSignals),
    t.app.get<Clock>(CLOCK, { strict: false }),
  );
}

/**
 * Builds the input of a row prepared now: the preview's cost is the service's effective cost, its rule price the price the rules
 * give now, its existing price the stored retail price, and the price mode the default (`keep` with a price, else `rule`).
 *
 * @param t the test app
 * @param serviceId the service
 * @param overrides the fields to set
 * @returns the input
 */
export async function preparedInput(
  t: TestApp,
  serviceId: number,
  overrides: PublishInputOverrides = {},
): Promise<PublishInput> {
  const db = t.app.get(DbService).db;
  const target = (await t.app.get(RetailPricing).targets(db, [serviceId])).get(serviceId);
  const [service] = await db
    .select({ effectiveCost: s.services.effectiveCost })
    .from(s.services)
    .where(eq(s.services.id, serviceId));
  const stored = target?.quote.retailPrice ?? null;
  const choice = normalisePriceMode(null, { price: stored, following: target?.source === 'rule' });
  const rulePrice = target?.rulePrice?.kind === 'price' ? target.rulePrice.price : null;
  const { price, ...rest } = overrides;
  return {
    serviceId,
    runId: null,
    requestedBy: null,
    listed: true,
    title: `Published service ${serviceId}`,
    slug: `published-service-${serviceId}`,
    slugSource: 'auto',
    brand: '',
    carrier: '',
    country: '',
    ...rest,
    price: {
      ...choice,
      cost: Money.of(service?.effectiveCost ?? '0'),
      rulePrice,
      existingPrice: stored,
      ...price,
    },
  };
}

/** The rows a transaction wrote to one table: every attempt counts, also one a savepoint rolled back. */
export interface TableWrites {
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
}

/** What a transaction wrote, per table; a table it did not write is absent. */
export type TransactionWrites = Record<string, TableWrites>;

/** The counters of this connection, per table (`pg_stat_xact_user_tables`). */
async function tableCounters(tx: DbExecutor): Promise<Map<string, TableWrites>> {
  const { rows } = await tx.execute<{ relname: string; inserted: number; updated: number; deleted: number }>(sql`
    select relname, n_tup_ins::int as inserted, n_tup_upd::int as updated, n_tup_del::int as deleted
    from pg_stat_xact_user_tables`);
  return new Map(rows.map(({ relname, ...counters }) => [relname, counters]));
}

/** How one row was published: the seam inside its transaction, and the publisher to use. */
export interface PublishOneOptions {
  /** Work to run inside the transaction after the service lock and before the publish (a test seam). */
  readonly inside?: (tx: Transaction) => Promise<void>;
  /** The publisher, when the test built its own with {@link publisherOf}. */
  readonly publisher?: ListingPublisher;
}

/**
 * Publishes one row as {@link publishOne} does and tells what its transaction wrote.
 *
 * Why: plan 31 section 6.2: every refusal is decided before the first write. That is a claim about the order of the steps, which the
 * rows left after the commit cannot prove: a write undone later, or one to a table nobody looked at, leaves no trace there. Postgres
 * counts every row a transaction inserts, updates or deletes, in every table. A connection's counters can still hold its earlier
 * transactions (they are flushed at most once a second), so the figures are the difference from the start of this transaction.
 *
 * @param t the test app
 * @param input the row
 * @param options the seam and the publisher
 * @returns the outcome and the writes of the transaction
 */
export async function publishTraced(
  t: TestApp,
  input: PublishInput,
  options: PublishOneOptions = {},
): Promise<{ outcome: PublishOutcome; writes: TransactionWrites }> {
  const publisher = options.publisher ?? publisherOf(t);
  return t.app.get(DbService).runInTransaction(async ({ tx }) => {
    const before = await tableCounters(tx);
    const service = await publisher.lock(tx, input.serviceId);
    if (options.inside) await options.inside(tx);
    const outcome = await publisher.publishLocked(tx, service, input);
    const writes: TransactionWrites = {};
    for (const [table, now] of await tableCounters(tx)) {
      const was = before.get(table);
      const change = {
        inserted: now.inserted - (was?.inserted ?? 0),
        updated: now.updated - (was?.updated ?? 0),
        deleted: now.deleted - (was?.deleted ?? 0),
      };
      if (change.inserted !== 0 || change.updated !== 0 || change.deleted !== 0) writes[table] = change;
    }
    return { outcome, writes };
  });
}

/**
 * Publishes one row in its own transaction: the service lock, then `publishLocked` (steps 1 and 4-12 of plan 31 section 6.2).
 *
 * @param t the test app
 * @param input the row
 * @param options the seam and the publisher
 * @returns the outcome
 */
export async function publishOne(
  t: TestApp,
  input: PublishInput,
  options: PublishOneOptions = {},
): Promise<PublishOutcome> {
  return (await publishTraced(t, input, options)).outcome;
}

/**
 * Counts the rows a publish writes for a service: its listings, its retail rows and its follow rows.
 *
 * @param db the test database
 * @param serviceId the service
 * @returns the three counts
 */
export async function publishTrace(db: Database, serviceId: number) {
  const listings = await db.select().from(s.serviceListings).where(eq(s.serviceListings.serviceId, serviceId));
  const prices = await db.select().from(s.serviceGroupPrices).where(eq(s.serviceGroupPrices.serviceId, serviceId));
  const follows = await db.select().from(s.retailPriceFollows).where(eq(s.retailPriceFollows.serviceId, serviceId));
  return { listings, prices, follows };
}

/** One row of a seeded run: its service, what its input differs in, and any column of the row itself (its state, tick or result). */
export interface SeedItem {
  readonly serviceId: number;
  readonly input?: PublishInputOverrides;
  readonly row?: Partial<NewListingPublishItem>;
}

/** A seeded run: its id and its rows, in the order they were given. */
export interface SeededRun {
  readonly id: number;
  readonly items: ListingPublishItem[];
}

/**
 * Seeds a run straight into its two tables, as a prepared draft would hold it: every row `ready` and ticked, with the input of a row
 * prepared now. The tests of the runner need no route (plan 31 section 8.3).
 *
 * @param t the test app
 * @param entries the rows: a service id, or a {@link SeedItem}
 * @param run columns of the run; by default it is `queued`, prepared now, of the source `console`
 * @returns the run and its rows
 */
export async function seedRun(
  t: TestApp,
  entries: ReadonlyArray<number | SeedItem>,
  run: Partial<NewListingPublishRun> = {},
): Promise<SeededRun> {
  const db = t.app.get(DbService).db;
  const now = t.clock.now();
  const seeds = entries.map((entry): SeedItem => (typeof entry === 'number' ? { serviceId: entry } : entry));
  const [created] = await db
    .insert(s.listingPublishRuns)
    .values({
      status: 'queued',
      source: 'console',
      scope: { kind: 'services', serviceIds: seeds.map((seed) => seed.serviceId) },
      rulesVersion: NAMING_RULES_VERSION,
      total: seeds.length,
      preparedAt: now,
      heartbeatAt: now,
      ...run,
    })
    .returning({ id: s.listingPublishRuns.id });
  const runId = created!.id;
  const values: NewListingPublishItem[] = [];
  for (const seed of seeds) {
    const input = await preparedInput(t, seed.serviceId, seed.input);
    values.push({
      runId,
      serviceId: seed.serviceId,
      title: input.title,
      slug: input.slug,
      slugSource: input.slugSource,
      brand: input.brand,
      carrier: input.carrier,
      country: input.country,
      priceMode: input.price.mode,
      priceOverride: input.price.override?.toWire() ?? null,
      replacesPrice: input.price.replacesPrice?.toWire() ?? null,
      existingPrice: input.price.existingPrice?.toWire() ?? null,
      cost: input.price.cost.toWire(),
      rulePrice: input.price.rulePrice?.toWire() ?? null,
      state: 'ready',
      included: true,
      evaluatedAt: now,
      ...seed.row,
    });
  }
  if (values.length > 0) await db.insert(s.listingPublishItems).values(values);
  return { id: runId, items: await publishItemsOf(db, runId) };
}

/**
 * Reads the rows of a run.
 *
 * @param db the test database
 * @param runId the run
 * @returns its rows in id order
 */
export function publishItemsOf(db: Database, runId: number): Promise<ListingPublishItem[]> {
  return db
    .select()
    .from(s.listingPublishItems)
    .where(eq(s.listingPublishItems.runId, runId))
    .orderBy(asc(s.listingPublishItems.id));
}

/**
 * Applies a run as the apply route's transaction does (plan 31 section 5.2): the run row `FOR UPDATE`, a switch that stalled closed, the
 * guarded move to `queued`, the rows `refused: failed` set back to no result, the outbox event. It waits for a row in flight, and can run
 * from a worker's hook.
 *
 * @param t the test app
 * @param runId the run
 * @param options how the run publishes, when the test sets it
 * @throws {Error} when the run cannot be queued
 */
export async function queueRun(t: TestApp, runId: number, options: { readonly listed?: boolean } = {}): Promise<void> {
  const outbox = t.app.get(PublishOutbox, { strict: false });
  await t.app.get(DbService).runInTransaction(async ({ tx }) => {
    await lockRun(tx, runId);
    await closeStalledSwitch(tx, runId, SWITCH_STALLED_ERROR);
    const moved = await moveRunToQueued(tx, runId, { now: t.clock.now(), ...options });
    if (moved === undefined) throw new Error(`Publish run ${runId} cannot be queued.`);
    await reopenFailedItems(tx, runId);
    await outbox.applyRequested(tx, runId);
  });
}

/**
 * Cancels a run as the cancel route's transaction does (plan 31 section 5.2): the run row `FOR UPDATE`, `cancelled`, the counters from
 * the rows. It waits for a row in flight, and can run from a worker's hook.
 *
 * @param t the test app
 * @param runId the run
 * @throws {Error} when the run is finished
 */
export async function cancelRun(t: TestApp, runId: number): Promise<void> {
  await t.app.get(DbService).runInTransaction(async ({ tx }) => {
    await lockRun(tx, runId);
    const counts = await countItemResults(tx, runId);
    const cancelled = await cancelRunRow(tx, runId, counts, t.clock.now());
    if (cancelled === undefined) throw new Error(`Publish run ${runId} cannot be cancelled.`);
  });
}

/**
 * Queues a run switch as the `listed` route's transaction does (plan 31 section 5.2).
 *
 * @param t the test app
 * @param runId the run
 * @param listed the target
 * @param requestedBy the staff member who pressed the button
 * @throws {Error} when the run is not finished
 */
export async function queueSwitch(
  t: TestApp,
  runId: number,
  listed: boolean,
  requestedBy: number | null = null,
): Promise<void> {
  const outbox = t.app.get(PublishOutbox, { strict: false });
  await t.app.get(DbService).runInTransaction(async ({ tx }) => {
    await lockRun(tx, runId);
    const queued = await queueRunSwitch(tx, runId, listed, t.clock.now());
    if (queued === undefined) throw new Error(`Publish run ${runId} cannot be switched.`);
    await outbox.switchRequested(tx, runId, listed, requestedBy);
  });
}
