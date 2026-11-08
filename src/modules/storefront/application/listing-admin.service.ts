// ListingAdminService: the use cases of the storefront listing routes (map domain H, stage 15): list, show, create, and the
// "On the site" switch and retail price edits of PATCH. Rules: B53 (locked services), b2c-7 and catalog-12 (the retail floor),
// catalog-3 (an archived service is gone).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor, isUniqueViolation } from '../../../infra/db';
import { CatalogPriceVersion, RetailPrices, marginPercent } from '../../catalog';
import { AuditService } from '../../platform';
import { lockOf, lockedDetail, retailPriceProblem } from '../domain/listing-rules';
import { chooseSlug } from '../domain/slug';
import {
  type ListingRow,
  findListingRow,
  findServiceFacts,
  listListingRows,
  salesOf,
} from '../infra/foreign-reads.repository';
import { findListing, insertListing, listingConflict, setListed } from '../infra/listing.repository';

const DAY_MS = 86_400_000;
/** The window of `orders30d` and `revenue30d`. */
const SALES_WINDOW_DAYS = 30;

/** A listing as the console reads it. */
export interface ListingView {
  readonly id: number;
  readonly serviceId: number;
  readonly locale: string;
  readonly slug: string;
  readonly publicTitle: string;
  readonly isListed: boolean;
  readonly isFeatured: boolean;
  readonly service: {
    readonly id: number;
    readonly name: string;
    readonly code: string;
    readonly basePrice: string;
    readonly cost: string;
  };
  readonly retailPrice: string | null;
  readonly floorPrice: string;
  readonly marginPct: string | null;
  readonly orders30d: number;
  readonly revenue30d: string;
  readonly locked: boolean;
  readonly lockedReason: string | null;
}

/** The fields of `POST /admin/service-listings`. */
export interface CreateListingInput {
  readonly serviceId: number;
  readonly locale: string;
  readonly publicTitle: string;
  readonly slug?: string | undefined;
}

/** The fields `PATCH /admin/service-listings/:id` may change. */
export interface UpdateListingInput {
  readonly isListed?: boolean | undefined;
  readonly retailPrice?: string | undefined;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No listing has this id.' });

function invalid(field: string, message: string, code = 'invalid'): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
}

/**
 * Manages the storefront listings.
 *
 * Why: the console's "Services on sale" tab decides which services appear on the public site and at what retail price. The
 * retail price is the `b2c_retail` row of `service_group_prices` (catalog owns it), held to the storefront floor by the same
 * function the group-price page uses (RESOLUTIONS catalog-12 and b2c-7). Every writer locks the service row first, so a price
 * write, a switch, a listing create and the catalog's own edits of the service (disable, delete, group prices) never
 * interleave.
 *
 * Side effects: writes `service_listings`, the retail row of `service_group_prices` (through `RetailPrices`) and `audit_logs`
 * (entity `listing`); moves the catalog price version after the commit when the retail price changed.
 *
 * @see docs/contract/endpoints/storefront.md (the `/admin/service-listings` sections)
 */
@Injectable()
export class ListingAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly retail: RetailPrices,
    private readonly priceVersion: CatalogPriceVersion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists listings with their service figures.
   *
   * @param query the parsed list request
   * @returns the page of listings and the exact total
   */
  async list(
    query: ParsedListQuery<'publicTitle' | 'isListed' | 'slug' | 'id'>,
  ): Promise<{ rows: ListingView[]; total: number }> {
    const { rows, total } = await listListingRows(this.db.db, query);
    return { rows: await this.views(this.db.db, rows), total };
  }

  /**
   * Shows one listing.
   *
   * @param id the listing id
   * @returns the listing
   * @throws {AppError} `NOT_FOUND` (404: unknown, or its service is archived)
   */
  async show(id: number): Promise<ListingView> {
    const row = await findListingRow(this.db.db, id);
    if (!row) throw notFound();
    // No view when the service was archived since the row was read: the listing is gone.
    const [view] = await this.views(this.db.db, [row]);
    if (!view) throw notFound();
    return view;
  }

  /**
   * Creates a listing: a service on the storefront in one language, not on the site yet.
   *
   * @param input the service, language, title and optional slug
   * @returns the new listing
   * @throws {AppError} `VALIDATION_FAILED` (422 on `serviceId` for an unknown or archived service, on `slug`); `LISTING_LOCKED`
   *   (409: the service can never be public); `LISTING_EXISTS` (409 with a field: the service already has a listing in the
   *   language, or the slug is used there)
   */
  async create(input: CreateListingInput): Promise<ListingView> {
    const chosen = chooseSlug(input.slug, input.publicTitle);
    if (!chosen.ok) throw invalid('slug', chosen.message);
    return this.db.runInTransaction(async ({ tx }) => {
      // A shared lock: a service delete (which archives when a listing refers to the service) waits for this insert.
      const service = await this.retail.lockLiveService(tx, input.serviceId, 'share');
      const facts = service && (await findServiceFacts(tx, input.serviceId));
      if (!service || !facts) throw invalid('serviceId', 'Choose a service.');
      const lock = lockOf({
        serviceStatus: facts.status,
        categoryName: facts.categoryName,
        categoryAllowedGroupIds: facts.allowedGroupIds,
        retailGroupId: facts.retailGroupId ?? undefined,
      });
      if (lock.locked) throw new AppError('LISTING_LOCKED', { detail: lockedDetail(lock.reason!) });

      const taken = await listingConflict(tx, input.serviceId, input.locale, chosen.slug);
      if (taken) throw this.exists(taken, chosen.slug);
      let listing;
      try {
        listing = await insertListing(tx, {
          serviceId: input.serviceId,
          locale: input.locale,
          slug: chosen.slug,
          publicTitle: input.publicTitle,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'service_listings_service_locale_uq')) throw this.exists('serviceId', chosen.slug);
        if (isUniqueViolation(error, 'service_listings_slug_uq')) throw this.exists('slug', chosen.slug);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'created listing for',
        entityType: 'listing',
        entityId: listing.id,
        entityLabel: service.name,
        after: { locale: listing.locale, slug: listing.slug, publicTitle: listing.publicTitle, isListed: false },
      });
      const row = (await findListingRow(tx, listing.id))!;
      return (await this.views(tx, [row]))[0]!;
    });
  }

  /**
   * Switches a listing on or off the site and/or sets the retail price of its service.
   *
   * Why: the console sends only `isListed` (the switch) or only `retailPrice` (the price dialog). The service row is locked
   * first; every refusal is decided before the first write, so a request with both fields never half applies.
   *
   * @param id the listing id
   * @param changes `isListed` and/or `retailPrice` (4-decimal net USD before VAT)
   * @returns the updated listing, with its figures worked out again
   * @throws {AppError} `NOT_FOUND` (404); `VALIDATION_FAILED` (422 on `retailPrice`: zero or less, or under the floor);
   *   `SERVICE_DISABLED` (409: switching a disabled service on); `LISTING_LOCKED` (409: switching on or pricing a service that
   *   can never be public)
   */
  async update(id: number, changes: UpdateListingInput): Promise<ListingView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const listing = await findListing(tx, id);
      if (!listing) throw notFound();
      // The service row first (every writer takes it before anything of the listing): an archived service is gone, so 404.
      const service = await this.retail.lockLiveService(tx, listing.serviceId);
      const row = service && (await findListingRow(tx, id));
      if (!service || !row) throw notFound();
      const lock = lockOf({
        serviceStatus: row.service.status,
        categoryName: row.category.name,
        categoryAllowedGroupIds: row.category.allowedGroupIds,
        retailGroupId: row.retailGroupId ?? undefined,
      });

      if (changes.isListed === true) {
        // A disabled service is a fixable state, so it gets its own answer before the generic lock.
        if (service.status !== 'active') {
          throw new AppError('SERVICE_DISABLED', { detail: `${service.name} is disabled. Enable the service first.` });
        }
        if (lock.locked) throw new AppError('LISTING_LOCKED', { detail: lockedDetail(lock.reason!) });
      }
      let price: Money | undefined;
      if (changes.retailPrice !== undefined) {
        price = Money.of(changes.retailPrice);
        if (!price.isPositive()) throw invalid('retailPrice', 'Enter a price greater than zero.');
        if (lock.locked) throw new AppError('LISTING_LOCKED', { detail: lockedDetail(lock.reason!) });
        const quote = (await this.retail.quotes(tx, [service.id])).get(service.id)!;
        const problem = retailPriceProblem(price, quote.floor);
        if (problem !== null) throw invalid('retailPrice', problem, 'below_floor');
      }

      if (price !== undefined) {
        const before = await this.retail.set(tx, service.id, price);
        this.priceVersion.bumpAfterCommit(work);
        await this.audit.record(tx, {
          action: 'changed retail price of',
          entityType: 'listing',
          entityId: id,
          entityLabel: service.name,
          before: { retailPrice: before?.toWire() ?? null },
          after: { retailPrice: price.toWire() },
        });
      }
      if (changes.isListed !== undefined) {
        const updated = await setListed(tx, id, changes.isListed);
        await this.audit.record(tx, {
          action: updated.isListed ? 'listed on storefront' : 'unlisted from storefront',
          entityType: 'listing',
          entityId: id,
          entityLabel: service.name,
          // The row read under the service lock, not the earlier unlocked read: a writer may have changed it in between.
          before: { isListed: row.listing.isListed },
          after: { isListed: updated.isListed },
        });
      }
      const fresh = (await findListingRow(tx, id))!;
      return (await this.views(tx, [fresh]))[0]!;
    });
  }

  /** The 409 answer for a listing that already exists, naming the field the console highlights. */
  private exists(field: 'serviceId' | 'slug', slug: string): AppError {
    const message =
      field === 'serviceId'
        ? 'This service already has a listing in that language.'
        : `The slug ${slug} is already used.`;
    const errors: FieldError[] = [{ field, code: 'duplicate', message }];
    return new AppError('LISTING_EXISTS', { detail: message, errors });
  }

  /** Joins the figures the server works out onto a page of listing rows: floors, retail prices, sales and the lock. */
  private async views(db: DbExecutor, rows: readonly ListingRow[]): Promise<ListingView[]> {
    const serviceIds = rows.map((row) => row.service.id);
    const since = new Date(this.clock.nowMs() - SALES_WINDOW_DAYS * DAY_MS);
    const quotes = await this.retail.quotes(db, serviceIds);
    const sales = await salesOf(db, serviceIds, since);
    return rows.flatMap((row): ListingView[] => {
      const quote = quotes.get(row.service.id);
      // A service archived between the row read and the quote read has no quote: its listing is gone (catalog-3), so skip it.
      if (quote === undefined) return [];
      const lock = lockOf({
        serviceStatus: row.service.status,
        categoryName: row.category.name,
        categoryAllowedGroupIds: row.category.allowedGroupIds,
        retailGroupId: row.retailGroupId ?? undefined,
      });
      const figures = sales.get(row.service.id);
      return [
        {
          id: row.listing.id,
          serviceId: row.listing.serviceId,
          locale: row.listing.locale,
          slug: row.listing.slug,
          publicTitle: row.listing.publicTitle,
          isListed: row.listing.isListed,
          isFeatured: row.listing.isFeatured,
          service: {
            id: row.service.id,
            name: row.service.name,
            code: row.service.code,
            basePrice: quote.basePrice.toWire(),
            cost: quote.cost.toWire(),
          },
          retailPrice: quote.retailPrice?.toWire() ?? null,
          floorPrice: quote.floor.toWire(),
          marginPct: quote.retailPrice?.isPositive() ? marginPercent(quote.retailPrice, quote.cost) : null,
          orders30d: figures?.orders ?? 0,
          revenue30d: Money.of(figures?.revenue ?? '0').toWire(),
          locked: lock.locked,
          lockedReason: lock.reason,
        },
      ];
    });
  }
}
