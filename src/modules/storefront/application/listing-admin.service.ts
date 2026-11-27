// ListingAdminService: the use cases of the storefront listing routes (map domain H, stage 15): list, show, create, the "On the site"
// switch, the retail price and content edits of PATCH, and the service picture (feature 22). Rules: B53 (locked services), b2c-7 and
// catalog-12 (the retail floor), catalog-3 (an archived service is gone), decision 040 (a typed or a following retail price).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor, isUniqueViolation } from '../../../infra/db';
import { CatalogPriceVersion, type RetailWrite, RetailPrices, RetailPricing, marginPercent } from '../../catalog';
import { type PermissionHolder, requirePermission } from '../../identity';
import type { UploadedFile } from '../../../common/multipart';
import { AuditService, PUBLIC_MEDIA_PATH, PublicImages } from '../../platform';
import { lockOf, lockedDetail } from '../domain/listing-rules';
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
  type ListingChanges,
  findListing,
  lockListing,
  setListingImage,
  slugTaken,
  updateListingFields,
} from '../infra/listing.repository';
import { PRICE_PERMISSION, PUBLISH_PERMISSION } from '../publish/application/publish-permissions';
import { checkTypedPrice, createListingRow, switchListing, switchRefusal } from './listing-writes';

const DAY_MS = 86_400_000;
/** The window of `orders30d` and `revenue30d`. */
const SALES_WINDOW_DAYS = 30;

/** A listing as the console reads it. */
export interface ListingView {
  readonly id: number;
  readonly serviceId: number;
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
  /** `rule` (follows a retail price rule), `manual` (typed), `null` (no price): decision 040. */
  readonly retailPriceSource: 'rule' | 'manual' | null;
  readonly retailPriceRule: { readonly id: number; readonly label: string } | null;
  /** A proposal for the following price waits for staff (`retail_price_changes`, decision 040). */
  readonly retailPriceWaiting: boolean;
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

/** The content a listing carries beyond its title and slug: its texts, then the facts the shop filters and orders by. */
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
  readonly publicTitle: string;
  readonly slug?: string | undefined;
}

/** The fields `PATCH /admin/service-listings/:id` may change. */
export interface UpdateListingInput extends ListingContentInput {
  readonly isListed?: boolean | undefined;
  readonly retailPrice?: string | undefined;
  /** `rule`: price by the retail price rule now and follow it (decision 040). */
  readonly retailPricing?: 'rule' | undefined;
  readonly publicTitle?: string | undefined;
  readonly slug?: string | undefined;
}

/** The columns of the listing row that staff edit (the switch and the retail price have their own writes). */
const CONTENT_KEYS = [
  'publicTitle',
  'slug',
  'summary',
  'descriptionMd',
  'requirementsMd',
  'etaText',
  'seoTitle',
  'seoDescription',
  'brand',
  'carrier',
  'country',
  'isFeatured',
  'sort',
] as const;

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
 * Side effects: writes `service_listings` (the content, the facts and the picture of the service's one listing, `listed_at` on the first
 * switch-on), the retail row of `service_group_prices` and the follow row of `retail_price_follows` (through `RetailPrices.set`,
 * decision 040: a typed price stops following, `retailPricing: 'rule'` starts it) and `audit_logs` (entity `listing`); a picture upload
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
    private readonly pricing: RetailPricing,
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
   * Creates a listing: the service's page on the storefront, not on the site yet.
   *
   * Why: the content fields may be sent at creation. A service has one listing and a slug is unique for the site (English only,
   * decision 039, B224): a second listing of the service, or a taken slug, is refused before the insert and, when two requests race,
   * by the unique keys.
   *
   * @param input the service, title, optional slug and optional content
   * @returns the new listing
   * @throws {AppError} `VALIDATION_FAILED` (422 on `serviceId` for an unknown or archived service, on `slug`); `LISTING_LOCKED`
   *   (409: the service can never be public); `LISTING_EXISTS` (409 with a field: the service already has a listing, or the slug
   *   is used)
   */
  async create(input: CreateListingInput): Promise<ListingDetailView> {
    const chosen = chooseSlug(input.slug, input.publicTitle);
    if (!chosen.ok) throw invalid('slug', chosen.message);
    const sentContent = definedOf(input, CONTENT_KEYS) as ListingChanges;
    return this.db.runInTransaction(async ({ tx }) => {
      // A shared lock: a service delete (which archives when a listing refers to the service) waits for this insert, and the
      // insert only adds a row (no other listing of the service exists to write).
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

      // The pre-check, then the unique keys: two creates that race past the check meet there (the shared service lock lets both
      // insert), and both answer the same 409.
      const created = await createListingRow(tx, {
        ...sentContent,
        serviceId: input.serviceId,
        slug: chosen.slug,
        publicTitle: input.publicTitle,
      });
      if (!created.ok) throw this.exists(created.conflict, chosen.slug);
      const listing = created.listing;
      // The shop's search follows the listing of the service (feature 29).
      await this.signals.listingsChanged(tx, [input.serviceId]);
      await this.audit.record(tx, {
        action: 'created listing for',
        entityType: 'listing',
        entityId: listing.id,
        entityLabel: service.name,
        after: {
          slug: listing.slug,
          publicTitle: listing.publicTitle,
          isListed: false,
          ...Object.fromEntries(Object.entries(sentContent).map(([key, value]) => [key, auditValue(key, value)])),
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
   * service row is locked first, then the listing row; every refusal is decided before the first write, so a request with several
   * fields never half applies. The content and the facts of the service (`brand`, `carrier`, `country`, `isFeatured`, `sort`) live
   * on the service's one listing. The first switch-on sets `listedAt`, which never resets. Decision 074: `isListed` sent with the value
   * the listing already holds (read under the locks) writes nothing for the switch: no audit row `listed on storefront` or
   * `unlisted from storefront`, no `listedAt`, and, when it is all the request holds, no search signal either; the answer is still
   * `200` with the listing, and every other key of the request is handled as before.
   *
   * @param caller the signed-in staff member (`retailPrice` and `retailPricing` need `pricing:update`, switching a listing on needs
   *   `storefront:publish`, decision 046)
   * @param id the listing id
   * @param changes the fields to change
   * @returns the updated listing, with its figures worked out again
   * @throws {AppError} `FORBIDDEN` (403: a price key without `pricing:update`, or a real switch-on without `storefront:publish`);
   *   `NOT_FOUND` (404); `VALIDATION_FAILED` (422 on `retailPrice`: zero or less, or under the floor; on
   *   `retailPricing`: `conflict` with `retailPrice`, `no_rule`, `no_cost`; on `slug`: not a valid form); `LISTING_EXISTS` (409 on
   *   `slug`: used by another listing); `SERVICE_DISABLED` (409: switching a disabled service on); `LISTING_LOCKED` (409:
   *   switching on or pricing a service that can never be public)
   */
  async update(caller: PermissionHolder, id: number, changes: UpdateListingInput): Promise<ListingDetailView> {
    // Decision 046: a retail price is a pricing decision, here as on the group price page.
    if (changes.retailPrice !== undefined || changes.retailPricing !== undefined) {
      requirePermission(caller, PRICE_PERMISSION);
    }
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const listing = await findListing(tx, id);
      if (!listing) throw notFound();
      // The service row first (every writer takes it before anything of the listing): an archived service is gone, so 404.
      const service = await this.retail.lockLiveService(tx, listing.serviceId);
      if (!service) throw notFound();
      // Then the listing row (the popularity job locks listing rows only, in id order).
      if (!(await lockListing(tx, id))) throw notFound();
      const row = await findListingRow(tx, id);
      if (!row) throw notFound();
      // Putting a listing on the shop is a publishing decision; switching off, or a no-op on a listed one, is not.
      if (changes.isListed === true && !row.listing.isListed) requirePermission(caller, PUBLISH_PERMISSION);
      const lock = lockOf({
        serviceStatus: row.service.status,
        categoryName: row.category.name,
        categoryAllowedGroupIds: row.category.allowedGroupIds,
        retailGroupId: row.retailGroupId ?? undefined,
      });

      const switchFacts = { serviceStatus: service.status, lock };
      if (changes.isListed !== undefined) {
        // A disabled service is a fixable state, so it gets its own answer before the generic lock.
        const refusal = switchRefusal(switchFacts, changes.isListed);
        if (refusal === 'service_disabled') {
          throw new AppError('SERVICE_DISABLED', { detail: `${service.name} is disabled. Enable the service first.` });
        }
        if (refusal === 'locked') throw new AppError('LISTING_LOCKED', { detail: lockedDetail(lock.reason!) });
      }
      if (changes.retailPricing !== undefined && changes.retailPrice !== undefined) {
        throw invalid('retailPricing', 'Send a price or ask for the rule, not both.', 'conflict');
      }
      let price: Money | undefined;
      let write: RetailWrite | undefined;
      if (changes.retailPrice !== undefined) {
        price = Money.of(changes.retailPrice);
        if (!price.isPositive()) throw invalid('retailPrice', 'Enter a price greater than zero.');
        if (lock.locked) throw new AppError('LISTING_LOCKED', { detail: lockedDetail(lock.reason!) });
        const checked = await checkTypedPrice(this.retail, tx, service.id, price);
        if (!checked.ok) throw invalid('retailPrice', checked.message, 'below_floor');
        write = checked.write;
      }
      let ruleId: number | undefined;
      if (changes.retailPricing === 'rule') {
        if (lock.locked) throw new AppError('LISTING_LOCKED', { detail: lockedDetail(lock.reason!) });
        // Read under the service lock: the cost, the floor and the rule of now (decision 040).
        const target = (await this.pricing.targets(tx, [service.id])).get(service.id)!;
        if (target.rule === null || target.rulePrice === null) {
          throw invalid('retailPricing', 'No pricing rule covers this service.', 'no_rule');
        }
        if (target.rulePrice.kind === 'no_cost') {
          throw invalid('retailPricing', 'This service has no cost, so a rule cannot price it.', 'no_cost');
        }
        price = target.rulePrice.price;
        ruleId = target.rule.id;
        write = { origin: { kind: 'rule', ruleId, cost: target.quote.cost }, quote: target.quote };
      }
      const contentChanges = definedOf(changes, CONTENT_KEYS) as ListingChanges;
      if (changes.slug !== undefined) {
        // `''` means "make it from the title" (as create does); the new title counts when it is sent too.
        const chosen = chooseSlug(changes.slug, changes.publicTitle ?? listing.publicTitle);
        if (!chosen.ok) throw invalid('slug', chosen.message);
        if (chosen.slug === listing.slug) delete contentChanges.slug;
        else {
          if (await slugTaken(tx, chosen.slug, id)) throw this.exists('slug', chosen.slug);
          contentChanges.slug = chosen.slug;
        }
      }
      const edited = Object.keys(definedOf(changes, CONTENT_KEYS)).length > 0;

      if (price !== undefined && write !== undefined) {
        const before = await this.retail.set(tx, service.id, price, write);
        this.priceVersion.bumpAfterCommit(work);
        await this.audit.record(tx, {
          action: 'changed retail price of',
          entityType: 'listing',
          entityId: id,
          entityLabel: service.name,
          before: { retailPrice: before?.toWire() ?? null },
          after:
            ruleId === undefined
              ? { retailPrice: price.toWire() }
              : { retailPrice: price.toWire(), pricing: 'rule', ruleId, cost: write.quote.cost.toWire() },
        });
      }
      // Decision 074: a switch to the value the row holds under the locks changes nothing and writes nothing (no audit row, no
      // `listed_at`, no search signal of its own); the refusals above still judged it, as before.
      const target = changes.isListed;
      const switching = target !== undefined && target !== row.listing.isListed;
      if (switching) {
        const updated = await switchListing(tx, id, target, this.clock.now(), switchFacts);
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
        if (Object.keys(contentChanges).length > 0) {
          try {
            await updateListingFields(tx, id, contentChanges);
          } catch (error) {
            if (isUniqueViolation(error, 'service_listings_slug_uq'))
              throw this.exists('slug', contentChanges.slug ?? '');
            throw error;
          }
        }
        // The audit row keeps the fields that differ from what the row held (a request that changes nothing still leaves a row,
        // which the audit interceptor of staff writes needs).
        const stored: Record<string, unknown> = row.listing;
        // The audit records the slug actually stored (normalized, or made from the title for ''), not the raw request value.
        const sent: Record<string, unknown> = definedOf(changes, CONTENT_KEYS);
        if (contentChanges.slug === undefined) delete sent.slug;
        else sent.slug = contentChanges.slug;
        const changedKeys = Object.keys(sent).filter((key) => sent[key] !== stored[key]);
        await this.audit.record(tx, {
          action: 'edited listing of',
          entityType: 'listing',
          entityId: id,
          entityLabel: service.name,
          before: Object.fromEntries(changedKeys.map((key) => [key, auditValue(key, stored[key])])),
          after: Object.fromEntries(changedKeys.map((key) => [key, auditValue(key, sent[key])])),
        });
      }
      if (!switching && price === undefined && !edited) {
        // Only a switch to the value the listing already has was sent: nothing was written, so there is nothing to audit or signal.
        this.audit.nothingChanged();
      } else {
        // Any field (the switch, the retail price of the same request, the content, the facts) can change the search document (feature 29).
        await this.signals.listingsChanged(tx, [listing.serviceId]);
      }
      const fresh = (await findListingRow(tx, id))!;
      return this.detail(tx, fresh);
    });
  }

  /**
   * Sets the picture of the listing's service.
   *
   * Why: feature 22: the shop shows a picture per service. The picture is checked, cleaned and stored first, outside the transaction
   * (`PublicImages.store`: object, then the `files` row); then, under the service lock and the listing row's lock (like every writer
   * of a listing), the listing points at it. A replaced picture's file stays (it is content-addressed, and the same picture may serve
   * another service).
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
      await setListingImage(tx, id, image.fileId);
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
   * Removes the picture of the listing's service.
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
      await setListingImage(tx, id, null);
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

  /** Takes the locks of a picture write (the service row, then the listing row) and rereads the listing under them. */
  private async lockImageRows(tx: DbExecutor, id: number) {
    const found = await findListing(tx, id);
    if (!found) throw notFound();
    const service = await this.retail.lockLiveService(tx, found.serviceId);
    if (!service) throw notFound();
    const listing = await lockListing(tx, id);
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
    const message = field === 'serviceId' ? 'This service already has a listing.' : `The slug ${slug} is already used.`;
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
    const sources = await this.retail.sources(db, serviceIds);
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
      const source = sources.get(row.service.id);
      return [
        {
          id: row.listing.id,
          serviceId: row.listing.serviceId,
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
          // The price and its source are two reads: a price written in between cannot change the answer's shape, only its age.
          retailPriceSource: quote.retailPrice === null ? null : (source?.source ?? 'manual'),
          retailPriceRule: quote.retailPrice === null ? null : (source?.rule ?? null),
          retailPriceWaiting: source?.waiting ?? false,
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
