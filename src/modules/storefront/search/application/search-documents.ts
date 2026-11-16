// SearchDocuments: builds the services documents of some ids from Postgres (feature 29, plan section 4.1-4.5). The ids that fail the
// searchable rule come back as deletes, so one call answers "what must the index hold for these services".
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../../infra/db';
import { StorefrontServices } from '../../../catalog';
import { type DocumentSource, buildServiceDocument } from '../domain/documents';
import type { ServiceDocument } from '../domain/services-schema';
import { englishListingsOf } from '../infra/search-source.repository';
import { SearchableIds } from './searchable-ids';

/** Ids per page of {@link SearchDocuments.all}. */
export const ALL_PAGE = 1000;

/** One built document with the facts it came from (the terms build reads the facts). */
export interface BuiltDocument {
  readonly document: ServiceDocument;
  readonly source: DocumentSource;
}

/** What the index must hold for some services. */
export interface DocumentBuild {
  /** The documents of the searchable ids, in id order. */
  readonly documents: readonly BuiltDocument[];
  /** The ids (as document ids) that must not be in the index. */
  readonly deleteIds: readonly string[];
  /** The retail group the rule was judged for. */
  readonly retailGroupId: number | undefined;
}

/**
 * Builds search documents.
 *
 * Why: decision 038: any document can be rebuilt from Postgres at any moment; the sync, the reconcile, the rebuild and the terms build
 * all call this one builder, so they never disagree. Reads: the searchable rule (three queries), the English listings, the model and
 * network labels (catalog) and the stock flag (catalog).
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class SearchDocuments {
  constructor(
    private readonly searchable: SearchableIds,
    private readonly services: StorefrontServices,
  ) {}

  /**
   * Finds the retail group the searchable rule is judged for.
   *
   * @param db the database or a transaction
   * @returns its id, or `undefined` when the shop has no retail group (nothing is searchable)
   */
  retailGroupIdOf(db: DbExecutor): Promise<number | undefined> {
    return this.searchable.retailGroupId(db);
  }

  /**
   * Builds every searchable document, one page of priced services at a time (keyset on the id, no ceiling).
   *
   * Why: plan section 4.5: the reconcile, the rebuild and the terms build walk the whole catalog with `pricedPage` (never `priced`, which
   * stops at 10 000).
   *
   * @param db the database
   * @param pageSize ids per page (1000)
   * @yields the documents of each page (an empty page ends the walk)
   */
  async *all(db: DbExecutor, pageSize = ALL_PAGE): AsyncGenerator<BuiltDocument[]> {
    const groupId = await this.searchable.retailGroupId(db);
    if (groupId === undefined) return;
    let afterId = 0;
    for (;;) {
      const ids = await this.services.pricedPage(db, groupId, afterId, pageSize);
      if (ids.length === 0) return;
      yield [...(await this.build(db, ids, groupId)).documents];
      if (ids.length < pageSize) return;
      afterId = ids[ids.length - 1]!;
    }
  }

  /**
   * Builds the documents of some services.
   *
   * @param db the database or a transaction
   * @param ids the service ids
   * @param retailGroupId the retail group when the caller already read it
   * @returns the documents of the searchable ids and the ids to delete
   */
  async build(db: DbExecutor, ids: readonly number[], retailGroupId?: number): Promise<DocumentBuild> {
    const distinct = [...new Set(ids)].sort((a, b) => a - b);
    const { services, retailGroupId: groupId } = await this.searchable.of(db, distinct, retailGroupId);
    const kept = [...services.keys()];
    const [listings, options, inStock] = await Promise.all([
      englishListingsOf(db, kept),
      this.services.optionLabels(db, kept),
      this.services.inStockIds(db, kept),
    ]);
    const documents: BuiltDocument[] = [];
    for (const id of distinct) {
      const service = services.get(id);
      const listing = listings.get(id);
      if (!service || !listing) continue;
      const labels = options.get(id);
      const source: DocumentSource = {
        serviceId: id,
        type: service.type,
        serviceName: service.name,
        categoryId: service.categoryId,
        categoryName: service.categoryName,
        title: listing.publicTitle,
        summary: listing.summary,
        brand: listing.brand,
        carrier: listing.carrier,
        country: listing.country,
        isFeatured: listing.isFeatured,
        sort: listing.sort,
        sales30d: listing.sales30d,
        listedAt: listing.listedAt,
        createdAt: listing.createdAt,
        networks: labels?.networks ?? [],
        models: labels?.models ?? [],
        inStock: inStock.has(id),
      };
      documents.push({ document: buildServiceDocument(source), source });
    }
    const built = new Set(documents.map((entry) => entry.source.serviceId));
    return {
      documents,
      deleteIds: distinct.filter((id) => !built.has(id)).map(String),
      retailGroupId: groupId,
    };
  }
}
