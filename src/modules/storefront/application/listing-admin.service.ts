// ListingAdminService: the use cases of the storefront listing routes (map domain H, stage 15): list, show, create, the "On the site"
// switch, the retail price and content edits of PATCH, and the service picture (feature 22). Rules: B53 (locked services), b2c-7 and
// catalog-12 (the retail floor), catalog-3 (an archived service is gone).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor, isUniqueViolation } from '../../../infra/db';
import { CatalogPriceVersion, RetailPrices, marginPercent } from '../../catalog';
import type { UploadedFile } from '../../../common/multipart';
import { AuditService, PUBLIC_MEDIA_PATH, PublicImages } from '../../platform';
import { lockOf, lockedDetail, retailPriceProblem } from '../domain/listing-rules';
import { chooseSlug } from '../domain/slug';
import { SearchSignals } from '../search/application/search-signals';
import {
  type AdminListingSort,
  type ListingRow,
  findListingRow,
  findServiceFacts,
  listListingRows,
  salesOf,
} from '../infra/foreign-reads.repository';
import {
  type ListingLanguageChanges,
  type ListingServiceFacts,
  findListing,
  insertListing,
  listingConflict,
  lockServiceListings,
  setListed,
  setServiceImage,
  siblingFacts,
  slugTaken,
  updateListingFields,
  updateServiceFacts,
} from '../infra/listing.repository';

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
  readonly summary: string;
  readonly etaText: string;
  readonly brand: string;
  readonly carrier: string;
  readonly country: string;
  readonly sort: number;
  readonly seoTitle: string;
  readonly seoDescription: string;
  readonly isListed: boolean;
  readonly isFeatured: boolean;
  readonly listedAt: string | null;
  readonly updatedAt: string;
  readonly imageUrl: string | null;
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

/** A listing with its two Markdown bodies: what show, create and change answer. */
export interface ListingDetailView extends ListingView {
  readonly descriptionMd: string;
  readonly requirementsMd: string;
}

/** The content a listing carries beyond its title and slug: per language first, then the facts of the service. */
export interface ListingContentInput {
  readonly summary?: string | undefined;
  readonly descriptionMd?: string | undefined;
  readonly requirementsMd?: string | undefined;
  readonly etaText?: string | undefined;
  readonly seoTitle?: string | undefined;
  readonly seoDescription?: string | undefined;
  readonly brand?: string | undefined;
  readonly carrier?: string | undefined;
  readonly country?: string | undefined;
  readonly isFeatured?: boolean | undefined;
  readonly sort?: number | undefined;
}

/** The fields of `POST /admin/service-listings`. */
export interface CreateListingInput extends ListingContentInput {
  readonly serviceId: number;
  readonly locale: string;
  readonly publicTitle: string;
  readonly slug?: string | undefined;
}

/** The fields `PATCH /admin/service-listings/:id` may change. */
export interface UpdateListingInput extends ListingContentInput {
  readonly isListed?: boolean | undefined;
  readonly retailPrice?: string | undefined;
  readonly publicTitle?: string | undefined;
  readonly slug?: string | undefined;
}

/** The columns written to the one listing row (its language). */
const LANGUAGE_KEYS = [
  'publicTitle',
  'slug',
  'summary',
  'descriptionMd',
  'requirementsMd',
  'etaText',
  'seoTitle',
  'seoDescription',
] as const;

/** The columns that describe the service and are written to every language row. */
const FACT_KEYS = ['brand', 'carrier', 'country', 'isFeatured', 'sort'] as const;

/** Markdown bodies never go into the audit log: only their length. */
const MARKDOWN_KEYS: ReadonlySet<string> = new Set(['descriptionMd', 'requirementsMd']);

/** The keys of `source` that are listed and set (not `undefined`), as a plain object. */
function definedOf<K extends string>(
  source: { readonly [P in K]?: unknown },
  keys: readonly K[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/** What the audit log keeps of a field: the value, or the length of a Markdown body. */
const auditValue = (key: string, value: unknown) =>
  MARKDOWN_KEYS.has(key) && typeof value === 'string' ? { length: value.length } : value;

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
 * Side effects: writes `service_listings` (content, facts of the service and its picture on every language row, `listed_at` on the first
 * switch-on), the retail row of `service_group_prices` (through `RetailPrices`) and `audit_logs` (entity `listing`); a picture upload
 * stores an object under `media/` and a `files` row (through `PublicImages`); moves the catalog price version after the commit when the
 * retail price changed. No cache key is touched: nothing is cached for the store catalog.
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
    private readonly images: PublicImages,
    private readonly signals: SearchSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists listings with their service figures.
   *
   * @param query the parsed list request
   * @returns the page of listings and the exact total
   */
  async list(query: ParsedListQuery<AdminListingSort>): Promise<{ rows: ListingView[]; total: number }> {
    const { rows, total } = await listListingRows(this.db.db, query);
    return { rows: await this.views(this.db.db, rows), total };
  }

  /**
   * Shows one listing with its description and requirements.
   *
   * @param id the listing id
   * @returns the listing
   * @throws {AppError} `NOT_FOUND` (404: unknown, or its service is archived)
   */
  async show(id: number): Promise<ListingDetailView> {
    const row = await findListingRow(this.db.db, id);
    if (!row) throw notFound();
    // No view when the service was archived since the row was read: the listing is gone.
    return this.detail(this.db.db, row);
  }

  /**
   * Creates a listing: a service on the storefront in one language, not on the site yet.
   *
   * Why: the content fields may be sent at creation. The facts of the service (`brand`, `carrier`, `country`, `isFeatured`, `sort`)
   * are shared by every language: the new row copies those it is not sent from the service's oldest listing, and those it is
   * sent are written to every language row (decision of feature 22).
   *
   * @param input the service, language, title, optional slug and optional content
   * @returns the new listing
   * @throws {AppError} `VALIDATION_FAILED` (422 on `serviceId` for an unknown or archived service, on `slug`); `LISTING_LOCKED`
   *   (409: the service can never be public); `LISTING_EXISTS` (409 with a field: the service already has a listing in the
   *   language, or the slug is used there)
   */
  async create(input: CreateListingInput): Promise<ListingDetailView> {
    const chosen = chooseSlug(input.slug, input.publicTitle);
    if (!chosen.ok) throw invalid('slug', chosen.message);
    const sentFacts = definedOf(input, FACT_KEYS) as ListingServiceFacts;
    const sentContent = definedOf(input, LANGUAGE_KEYS) as ListingLanguageChanges;
    const hasFacts = Object.keys(sentFacts).length > 0;
    return this.db.runInTransaction(async ({ tx }) => {
      // A shared lock: a service delete (which archives when a listing refers to the service) waits for this insert. Facts sent to
      // every language need the exclusive lock every other writer of the listings takes.
      const service = await this.retail.lockLiveService(tx, input.serviceId, hasFacts ? 'update' : 'share');
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
      if (hasFacts) await lockServiceListings(tx, input.serviceId);
      const inherited = await siblingFacts(tx, input.serviceId);
      let listing;
      try {
        listing = await insertListing(tx, {
          ...sentContent,
          ...inherited,
          ...sentFacts,
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
      if (hasFacts) await updateServiceFacts(tx, input.serviceId, sentFacts);
      // The shop's search follows every listing of the service (feature 29).
      await this.signals.listingsChanged(tx, [input.serviceId]);
      await this.audit.record(tx, {
        action: 'created listing for',
        entityType: 'listing',
        entityId: listing.id,
        entityLabel: service.name,
        after: {
          locale: listing.locale,
          slug: listing.slug,
          publicTitle: listing.publicTitle,
          isListed: false,
          ...Object.fromEntries(
            Object.entries({ ...sentContent, ...sentFacts }).map(([key, value]) => [key, auditValue(key, value)]),
          ),
        },
      });
      const row = (await findListingRow(tx, listing.id))!;
      return this.detail(tx, row);
    });
  }

  /**
   * Switches a listing on or off the site, sets the retail price of its service and/or edits its content.
   *
   * Why: the console sends `isListed` (the switch), `retailPrice` (the price dialog) or the content fields of the editor. The
   * service row is locked first, then every listing row of the service (in id order); every refusal is decided before the first
   * write, so a request with several fields never half applies. Per-language fields change this row; the facts of the service
   * (`brand`, `carrier`, `country`, `isFeatured`, `sort`) are written to every language row, like `retailPrice` already applies to
   * every language. The first switch-on sets `listedAt`, which never resets.
   *
   * @param id the listing id
   * @param changes the fields to change
   * @returns the updated listing, with its figures worked out again
   * @throws {AppError} `NOT_FOUND` (404); `VALIDATION_FAILED` (422 on `retailPrice`: zero or less, or under the floor; on `slug`:
   *   not a valid form); `LISTING_EXISTS` (409 on `slug`: used by another listing of the language); `SERVICE_DISABLED` (409:
   *   switching a disabled service on); `LISTING_LOCKED` (409: switching on or pricing a service that can never be public)
   */
  async update(id: number, changes: UpdateListingInput): Promise<ListingDetailView> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const listing = await findListing(tx, id);
      if (!listing) throw notFound();
      // The service row first (every writer takes it before anything of the listing): an archived service is gone, so 404.
      const service = await this.retail.lockLiveService(tx, listing.serviceId);
      if (!service) throw notFound();
      // Then every listing row of the service in id order (the popularity job locks in the same order).
      const siblings = await lockServiceListings(tx, listing.serviceId);
      const row = await findListingRow(tx, id);
      if (!row) throw notFound();
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
      const languageChanges = definedOf(changes, LANGUAGE_KEYS) as ListingLanguageChanges;
      if (changes.slug !== undefined) {
        // `''` means "make it from the title" (as create does); the new title counts when it is sent too.
        const chosen = chooseSlug(changes.slug, changes.publicTitle ?? listing.publicTitle);
        if (!chosen.ok) throw invalid('slug', chosen.message);
        if (chosen.slug === listing.slug) delete languageChanges.slug;
        else {
          if (await slugTaken(tx, listing.locale, chosen.slug, id)) throw this.exists('slug', chosen.slug);
          languageChanges.slug = chosen.slug;
        }
      }
      const factChanges = definedOf(changes, FACT_KEYS) as ListingServiceFacts;
      const edited = Object.keys(definedOf(changes, [...LANGUAGE_KEYS, ...FACT_KEYS])).length > 0;

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
        const updated = await setListed(tx, id, changes.isListed, this.clock.now());
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
      if (edited) {
        if (Object.keys(languageChanges).length > 0) {
          try {
            await updateListingFields(tx, id, languageChanges);
          } catch (error) {
            if (isUniqueViolation(error, 'service_listings_slug_uq'))
              throw this.exists('slug', languageChanges.slug ?? '');
            throw error;
          }
        }
        if (Object.keys(factChanges).length > 0) await updateServiceFacts(tx, listing.serviceId, factChanges);
        // The audit row keeps the fields that differ from what the row held (a request that changes nothing still leaves a row,
        // which the audit interceptor of staff writes needs).
        const stored: Record<string, unknown> = row.listing;
        // The audit records the slug actually stored (normalized, or made from the title for ''), not the raw request value.
        const sent: Record<string, unknown> = { ...definedOf(changes, LANGUAGE_KEYS), ...factChanges };
        if (languageChanges.slug === undefined) delete sent.slug;
        else sent.slug = languageChanges.slug;
        const changedKeys = Object.keys(sent).filter((key) => sent[key] !== stored[key]);
        await this.audit.record(tx, {
          action: 'edited listing of',
          entityType: 'listing',
          entityId: id,
          entityLabel: service.name,
          before: Object.fromEntries(changedKeys.map((key) => [key, auditValue(key, stored[key])])),
          after: {
            ...Object.fromEntries(changedKeys.map((key) => [key, auditValue(key, sent[key])])),
            ...(Object.keys(factChanges).length > 0
              ? { appliedToLocales: siblings.map((sibling) => sibling.locale) }
              : {}),
          },
        });
      }
      // Any field (the switch, the retail price of the same request, the content, the facts) can change the search document (feature 29).
      await this.signals.listingsChanged(tx, [listing.serviceId]);
      const fresh = (await findListingRow(tx, id))!;
      return this.detail(tx, fresh);
    });
  }

  /**
   * Sets the picture of the listing's service, in every language.
   *
   * Why: feature 22: the shop shows a picture per service. The picture is checked, cleaned and stored first, outside the transaction
   * (`PublicImages.store`: object, then the `files` row); then, under the service lock and the locks of every listing row of the service
   * (in id order, like every writer of the listings), every row points at it. A replaced picture's file stays (it is content-addressed,
   * and the same picture may serve another service).
   *
   * @param id the listing id
   * @param file the uploaded part `file`
   * @param staffId the staff member who uploads it (the owner of the `files` row)
   * @returns the listing with its new `imageUrl`
   * @throws {AppError} `NOT_FOUND` (404: unknown listing, or its service is archived); `VALIDATION_FAILED` (422 on `file`: `empty`,
   *   `unsupported_type`, `corrupt`, `animated`, `too_small`, `too_large_dimensions`, `rotated`); `PAYLOAD_TOO_LARGE` (413: over 2 MiB);
   *   `UNAVAILABLE` (503: storage is down)
   */
  async uploadImage(id: number, file: UploadedFile, staffId: number): Promise<ListingDetailView> {
    // No object or file row for a listing that does not exist.
    if (!(await findListing(this.db.db, id))) throw notFound();
    const image = await this.images.store(this.db.db, { bytes: file.data, filename: file.filename, staffId });
    return this.db.runInTransaction(async ({ tx }) => {
      const { listing, serviceName } = await this.lockImageRows(tx, id);
      await setServiceImage(tx, listing.serviceId, image.fileId);
      await this.audit.record(tx, {
        action: 'uploaded image for',
        entityType: 'listing',
        entityId: id,
        entityLabel: serviceName,
        before: { image: await this.imageNameOf(tx, listing.imageFileId) },
        after: { image: image.name, width: image.width, height: image.height, size: image.size },
      });
      return this.detail(tx, (await findListingRow(tx, id))!);
    });
  }

  /**
   * Removes the picture of the listing's service, in every language.
   *
   * Why: feature 22; staff may take a wrong picture down. The stored file stays (a later purge job may remove unreferenced ones). It
   * answers the same when there was no picture, and is audited either way (every staff write leaves an audit row).
   *
   * @param id the listing id
   * @throws {AppError} `NOT_FOUND` (404: unknown listing, or its service is archived)
   */
  async removeImage(id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const { listing, serviceName } = await this.lockImageRows(tx, id);
      await setServiceImage(tx, listing.serviceId, null);
      await this.audit.record(tx, {
        action: 'removed image of',
        entityType: 'listing',
        entityId: id,
        entityLabel: serviceName,
        before: { image: await this.imageNameOf(tx, listing.imageFileId) },
        after: { image: null },
      });
    });
  }

  /** Takes the locks of a picture write (the service row, then every listing row of the service in id order) and rereads the listing. */
  private async lockImageRows(tx: DbExecutor, id: number) {
    const found = await findListing(tx, id);
    if (!found) throw notFound();
    const service = await this.retail.lockLiveService(tx, found.serviceId);
    if (!service) throw notFound();
    const rows = await lockServiceListings(tx, found.serviceId);
    const listing = rows.find((row) => row.id === id);
    if (!listing) throw notFound();
    return { listing, serviceName: service.name };
  }

  /** The `<sha256>.<ext>` name of a stored picture, for the audit log; `null` when there is none. */
  private async imageNameOf(db: DbExecutor, fileId: number | null): Promise<string | null> {
    if (fileId === null) return null;
    const url = (await this.images.urlsOf(db, [fileId])).get(fileId);
    return url === undefined ? null : url.slice(PUBLIC_MEDIA_PATH.length);
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

  /** One listing row as a detail view: the row's view plus its two Markdown bodies. */
  private async detail(db: DbExecutor, row: ListingRow): Promise<ListingDetailView> {
    const [view] = await this.views(db, [row]);
    // No view when the service was archived since the row was read: the listing is gone (catalog-3).
    if (!view) throw notFound();
    return { ...view, descriptionMd: row.listing.descriptionMd, requirementsMd: row.listing.requirementsMd };
  }

  /** Joins the figures the server works out onto a page of listing rows: floors, retail prices, sales and the lock. */
  private async views(db: DbExecutor, rows: readonly ListingRow[]): Promise<ListingView[]> {
    const serviceIds = rows.map((row) => row.service.id);
    const since = new Date(this.clock.nowMs() - SALES_WINDOW_DAYS * DAY_MS);
    const quotes = await this.retail.quotes(db, serviceIds);
    const sales = await salesOf(db, serviceIds, since);
    const images = await this.images.urlsOf(
      db,
      rows.map((row) => row.listing.imageFileId),
    );
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
          summary: row.listing.summary,
          etaText: row.listing.etaText,
          brand: row.listing.brand,
          carrier: row.listing.carrier,
          country: row.listing.country,
          sort: row.listing.sort,
          seoTitle: row.listing.seoTitle,
          seoDescription: row.listing.seoDescription,
          isListed: row.listing.isListed,
          isFeatured: row.listing.isFeatured,
          listedAt: row.listing.listedAt?.toISOString() ?? null,
          updatedAt: row.listing.updatedAt.toISOString(),
          imageUrl: row.listing.imageFileId === null ? null : (images.get(row.listing.imageFileId) ?? null),
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
