// The services a publish run's scope covers (feature 31, plan 31 sections 5.2 and 6.1): the walk in keyset pages that the POST counts
// with and the preparer builds its rows from, the existence of what a scope names, and the rows a copy ("Check again", "Review the
// rest") takes from an earlier run. Plain functions of a database handle: the POST and the worker read the same walk.
import { Money } from '../../../../common/money';
import type { DbExecutor } from '../../../../infra/db';
import {
  SCOPE_PAGE_SIZE,
  categoryExists,
  importRunExists,
  liveServiceIds,
  serviceIdsOfCategory,
  serviceIdsOfImportRun,
  serviceIdsOfSupplier,
  supplierExists,
} from '../../../catalog';
import type { ListingPublishItem } from '../../db/schema';
import { liveServiceIdsAmong } from '../../infra/foreign-reads.repository';
import { servicesWithListing } from '../../infra/listing.repository';
import type { CopiedRow, DraftDetected } from '../domain/publish-draft';
import type { PublishScope } from '../domain/publish-item';
import { itemsToCopy } from '../infra/publish.repository';

/** One service of a scope, with the row it is copied from when the scope is an earlier run. */
export interface ScopedService {
  readonly serviceId: number;
  readonly copy?: CopiedRow;
}

/** The request key of a scope's reference to something that may not exist. */
export type ScopeField = 'scope.categoryId' | 'scope.supplierId' | 'scope.runId';

/** The page of the "services" scope: how many ticked ids one read of their liveness takes. */
const SERVICES_PAGE = 500;

/**
 * Checks that what a scope names exists.
 *
 * Why: plan 31 section 5.2: an unknown `scope.categoryId`, `scope.supplierId` or Quick add `scope.runId` is `422` with the code
 * `invalid` on that field; the storefront cannot read those tables (fact 17), so the catalog answers. A scope `run` (a publish run,
 * the storefront's own row) is checked by the route under the run's lock.
 *
 * @param db the database or a transaction
 * @param scope the scope as sent
 * @returns the request key of the reference that is unknown, or `null` when every reference exists
 */
export async function unknownScopeReference(db: DbExecutor, scope: PublishScope): Promise<ScopeField | null> {
  switch (scope.kind) {
    case 'category':
      return (await categoryExists(db, scope.categoryId)) ? null : 'scope.categoryId';
    case 'supplier':
      return (await supplierExists(db, scope.supplierId)) ? null : 'scope.supplierId';
    case 'quickAddRun':
      return (await importRunExists(db, scope.runId)) ? null : 'scope.runId';
    case 'services':
    case 'run':
    case 'all':
      return null;
  }
}

/**
 * Turns the rows of an earlier run into the rows a new draft copies.
 *
 * Why: plan 31 section 5.2: a copied row keeps its title, its three facts and its address, its price choice (never `replaces_price`)
 * and its tick; the preparer decides which of those it applies (only an edited row keeps the title and the facts).
 *
 * @param item the earlier run's row
 * @returns what the new row may keep
 */
export function copiedRowOf(item: ListingPublishItem): CopiedRow {
  return {
    title: item.title,
    slug: item.slug,
    slugSource: item.slugSource,
    brand: item.brand,
    carrier: item.carrier,
    country: item.country,
    detected: item.detected as unknown as DraftDetected,
    priceMode: item.priceMode,
    priceOverride: item.priceOverride === null ? null : Money.of(item.priceOverride),
    edited: item.edited,
    state: item.state,
    included: item.included,
  };
}

/** Drops the ids that have a listing: a run's rows are the services still to publish. */
async function withoutListing(db: DbExecutor, ids: readonly number[]): Promise<number[]> {
  const listed = await servicesWithListing(db, ids);
  return ids.filter((id) => !listed.has(id));
}

/**
 * Walks the services of a scope in pages, in id order.
 *
 * Why: plan 31 sections 5.2 and 6.1 step 2. The rows of a run are the live services of the scope that have no listing; with the scope
 * `services` a ticked service that has a listing is a row too (blocked `already_listed`, so staff see why). The scope `run` reads the
 * earlier run's rows (every row without a `published` result: the whole of a draft, "the rest" of a finished run) and drops the
 * services that are archived or listed now. The catalog scopes are walked in keyset pages of {@link SCOPE_PAGE_SIZE}; the POST counts
 * with this walk and the preparer inserts from it, so a run is never refused for one count and prepared with another.
 *
 * Side effects: none (reads only, no lock).
 *
 * @param db the database or a transaction
 * @param scope the scope as stored on the run
 * @returns the pages, each in ascending service id order (the scope `run` pages by the earlier run's row id, which keeps that order)
 */
export async function* scopePages(db: DbExecutor, scope: PublishScope): AsyncGenerator<ScopedService[]> {
  switch (scope.kind) {
    case 'services': {
      const ids = [...new Set(scope.serviceIds)].sort((a, b) => a - b);
      for (let at = 0; at < ids.length; at += SERVICES_PAGE) {
        const live = await liveServiceIdsAmong(db, ids.slice(at, at + SERVICES_PAGE));
        const page = ids.slice(at, at + SERVICES_PAGE).filter((id) => live.has(id));
        if (page.length > 0) yield page.map((serviceId) => ({ serviceId }));
      }
      return;
    }
    case 'run': {
      let after = 0;
      for (;;) {
        const rows = await itemsToCopy(db, scope.runId, after, SCOPE_PAGE_SIZE);
        if (rows.length === 0) return;
        after = rows[rows.length - 1]!.id;
        const ids = rows.map((row) => row.serviceId);
        const live = await liveServiceIdsAmong(db, ids);
        const listed = await servicesWithListing(db, ids);
        const kept = rows.filter((row) => live.has(row.serviceId) && !listed.has(row.serviceId));
        if (kept.length > 0) yield kept.map((row) => ({ serviceId: row.serviceId, copy: copiedRowOf(row) }));
      }
    }
    case 'category':
    case 'supplier':
    case 'quickAddRun':
    case 'all':
      yield* catalogPages(db, scope);
  }
}

/** The scopes the catalog answers: the others are the ticked services and an earlier run. */
type CatalogScope = Exclude<PublishScope, { kind: 'services' | 'run' }>;

/** The catalog scopes: a page of ids from the catalog, minus the services that have a listing. */
async function* catalogPages(db: DbExecutor, scope: CatalogScope): AsyncGenerator<ScopedService[]> {
  const read = (after: number): Promise<number[]> => {
    switch (scope.kind) {
      case 'category':
        return serviceIdsOfCategory(db, scope.categoryId, after, SCOPE_PAGE_SIZE);
      case 'supplier':
        return serviceIdsOfSupplier(db, scope.supplierId, after, SCOPE_PAGE_SIZE);
      case 'quickAddRun':
        return serviceIdsOfImportRun(db, scope.runId, after, SCOPE_PAGE_SIZE);
      case 'all':
        return liveServiceIds(db, after, SCOPE_PAGE_SIZE);
    }
  };
  let after = 0;
  for (;;) {
    const ids = await read(after);
    if (ids.length === 0) return;
    after = ids[ids.length - 1]!;
    const page = await withoutListing(db, ids);
    if (page.length > 0) yield page.map((serviceId) => ({ serviceId }));
  }
}

/** What {@link countScope} found. */
export interface ScopeCount {
  /** The services the preparer would insert. */
  readonly total: number;
  /** Those of them that have no listing: what can still be published. */
  readonly unlisted: number;
}

/**
 * Counts the services a scope covers, and those of them that can still be published.
 *
 * Why: plan 31 section 5.2: `POST /admin/publish-runs` answers `total` = the services counted now, refuses a scope with nothing left to
 * publish (`nothing_to_publish`) and one over the most a run takes (`too_many`, which names the number); it walks the whole scope so the
 * number it names is exact. Only the scope `services` keeps a service that has a listing, as a row that says why; when every ticked service
 * has one there is still nothing to publish.
 *
 * @param db the database or a transaction
 * @param scope the scope as sent
 * @returns the services the preparer would insert, and how many of them have no listing
 */
export async function countScope(db: DbExecutor, scope: PublishScope): Promise<ScopeCount> {
  let total = 0;
  let unlisted = 0;
  for await (const page of scopePages(db, scope)) {
    total += page.length;
    const ids = page.map((service) => service.serviceId);
    unlisted += scope.kind === 'services' ? (await withoutListing(db, ids)).length : page.length;
  }
  return { total, unlisted };
}

/**
 * Collects the services of a scope, at most `limit`.
 *
 * Why: plan 31 section 6.1 step 2: a console run was refused at the POST when it held more than the most a run takes, but a scope that
 * grew meanwhile, or a Quick add hand-over, takes the first `limit` and says so.
 *
 * @param db the database or a transaction
 * @param scope the scope as stored on the run
 * @param limit the most services to take
 * @returns the first `limit` services in id order, and whether there were more
 */
export async function collectScope(
  db: DbExecutor,
  scope: PublishScope,
  limit: number,
): Promise<{ readonly services: ScopedService[]; readonly truncated: boolean }> {
  const services: ScopedService[] = [];
  for await (const page of scopePages(db, scope)) {
    for (const service of page) {
      if (services.length >= limit) return { services, truncated: true };
      services.push(service);
    }
  }
  return { services, truncated: false };
}
