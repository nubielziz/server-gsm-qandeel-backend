// ListingPublisher: puts one service on the shop in one transaction for the bulk publish (feature 31, decision 040, plan 31 section
// 6.2): its listing, its retail price and its switch, with the audit row and the search signal; every refusal before the first write.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { type LockedService, RetailPricing, RetailPrices, type RetailWrite, supplyStates } from '../../catalog';
import { AuditService } from '../../platform';
import type { PublishSlugSource } from '../db/schema';
import { lockOf } from '../domain/listing-rules';
import { isSlug } from '../domain/slug';
import { findPublishFacts } from '../infra/foreign-reads.repository';
import { listingConflict, lockListingOfService, slugsStartingWith } from '../infra/listing.repository';
import { nextFreeSlug, slugFor } from '../publish/domain/naming';
import {
  type PriceDecision,
  type PriceRow,
  type PublishResultReason,
  decidePrice,
  evaluateItem,
  resultDetail,
} from '../publish/domain/publish-item';
import { SearchSignals } from '../search/application/search-signals';
import { createListingRow, switchListing } from './listing-writes';

/** The most inserts a publish row tries when racing writers take the slugs it proposes (plan 31 section 6.2 step 9). */
const MAX_SLUG_TRIES = 3;

/**
 * How much shorter than a slug base the family read is: `nextFreeSlug` shortens a long base to fit its suffix (`-100000` at most),
 * so the family of a base of 120 characters starts within its first 113.
 */
const SLUG_FAMILY_PREFIX = 113;

/**
 * What a `price_missing` refusal says: the listing route's sentence (`retailPricing: 'rule'`) for the half that is absent, so the row
 * tells staff whether a rule or a cost is what the service lacks.
 */
const PRICE_MISSING_DETAIL: Readonly<Record<Extract<PriceDecision, { reason: 'price_missing' }>['missing'], string>> = {
  no_rule: 'No pricing rule covers this service.',
  no_cost: 'This service has no cost, so a rule cannot price it.',
};

/** One row to publish: what the listing gets, how it is priced, and who asked (from a `listing_publish_items` row and its run). */
export interface PublishInput {
  readonly serviceId: number;
  /** The run the row belongs to (for the audit row); `null` outside a run. */
  readonly runId: number | null;
  /** The staff member who asked (the worker acts as `system`, so the audit row carries it). */
  readonly requestedBy: number | null;
  /** Switch the listing on (`true`), or leave it priced and off. */
  readonly listed: boolean;
  readonly title: string;
  readonly slug: string;
  readonly slugSource: PublishSlugSource;
  readonly brand: string;
  readonly carrier: string;
  /** ISO-2 upper case, or `''`. */
  readonly country: string;
  /** The row's price choice and the figures of its preview. */
  readonly price: PriceRow;
}

/** How the published price came about: written by the rule, typed in the row, or the stored price kept. */
export type PublishPricing = 'rule' | 'manual' | 'kept';

/** What publishing one row did (the runner writes it on the item row, and only there). */
export type PublishOutcome =
  | {
      readonly result: 'published';
      readonly reason: null;
      readonly detail: string | null;
      readonly listingId: number;
      readonly slug: string;
      /** The retail price the listing has now (written or kept). */
      readonly price: Money;
      readonly pricing: PublishPricing;
      /** True when a retail price was written (the run bumps the catalog price version once at its close). */
      readonly priceWritten: boolean;
    }
  | { readonly result: 'skipped'; readonly reason: 'already_listed'; readonly detail: null }
  | {
      readonly result: 'refused';
      readonly reason: Exclude<PublishResultReason, 'left_out' | 'already_listed' | 'failed'>;
      readonly detail: string | null;
    };

type Refusal = Extract<PublishOutcome, { result: 'refused' }>;

const refused = (reason: Refusal['reason'], detail: string | null = null): Refusal => ({
  result: 'refused',
  reason,
  detail: resultDetail([detail]),
});

const ALREADY_LISTED: PublishOutcome = { result: 'skipped', reason: 'already_listed', detail: null };

/** The origin and quote of a price write. */
function writeOf(decision: Extract<PriceDecision, { kind: 'write' }>, quote: RetailWrite['quote']): RetailWrite {
  return decision.origin === 'manual'
    ? { origin: { kind: 'manual' }, quote }
    : { origin: { kind: 'rule', ruleId: decision.ruleId, cost: decision.cost }, quote };
}

/**
 * Publishes one service to the shop.
 *
 * Why: plan 31 section 3.1: to publish a service is, in one transaction, to create its one listing, set its retail price, switch it
 * on, and write the audit row and the search signal; never "on with no price", never a price with no listing. The steps reuse the
 * listing route's writes (`listing-writes.ts`) and the one price writer (`RetailPrices.set`); every refusal is decided on the locked
 * service before the first write, so a refused row writes nothing.
 *
 * Side effects (of `publishLocked`): inserts a `service_listings` row (and switches it on); writes the retail row of
 * `service_group_prices` and `retail_price_follows` through `RetailPrices.set` when a price is written; inserts one
 * `storefront.listing_changed` outbox event and one `audit_logs` row (`published to the storefront`, entity `listing`, actor
 * `system` in the worker). No cache key; the catalog price version is moved once by the run's close, not here.
 *
 * @see docs/briefs/31-bulk-publish.md (sections 3.2 and 6.2)
 */
@Injectable()
export class ListingPublisher {
  constructor(
    private readonly retail: RetailPrices,
    private readonly pricing: RetailPricing,
    private readonly audit: AuditService,
    private readonly signals: SearchSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Locks the service row of a row to publish: the first lock of the row's transaction (plan 31 section 6.5).
   *
   * @param tx the row's transaction
   * @param serviceId the service
   * @returns the live service, or `undefined` when it is unknown or archived (`publishLocked` answers `service_gone`)
   */
  lock(tx: DbExecutor, serviceId: number): Promise<LockedService | undefined> {
    return this.retail.lockLiveService(tx, serviceId);
  }

  /**
   * Publishes a row whose service the transaction has locked (steps 4 to 12 of plan 31 section 6.2).
   *
   * Why: the order of the steps is the lock order (the service, then the listing rows, then the price and follow rows) and the
   * blocking list of section 3.2: the service is gone (`service_gone`); it has a listing (`skipped: already_listed`); the facts of
   * now (`evaluateItem`: disabled, category off, B2B only, `file`, no usable supplier, the title); the price (`decidePrice`:
   * `price_missing`, whose detail names the absent half, `below_floor`, the publish limit `cost_moved`); the address (a typed slug that
   * is taken is `slug_taken`, a proposed one gets the next free suffix). Only then the insert (in a savepoint, retried on a slug race),
   * the price, the switch, the signal and the audit row.
   *
   * @param tx the row's transaction, holding the service row lock (`lock`) and, in a run, the run and item rows
   * @param service what `lock` returned
   * @param input the row to publish
   * @returns the outcome; nothing was written unless it is `published`
   * @throws {RetailFloorError} when a price under the floor reached the writer (cannot happen after `decidePrice`; the caller rolls
   *   the row back and records `refused: failed`); any database error
   */
  async publishLocked(
    tx: DbExecutor,
    service: LockedService | undefined,
    input: PublishInput,
  ): Promise<PublishOutcome> {
    // Step 4: the service is gone or archived.
    if (service === undefined || service.id !== input.serviceId) return refused('service_gone');
    const serviceId = service.id;
    // Step 5: the service's one listing, locked after the service row; a listing made since the preview wins.
    if (await lockListingOfService(tx, serviceId)) return ALREADY_LISTED;

    // Step 6: the facts of now, with the category's is_active (the listing routes do not read it).
    const facts = await findPublishFacts(tx, serviceId);
    if (facts === undefined) return refused('service_gone');
    const supply = (await supplyStates(tx, [serviceId])).get(serviceId) ?? 'no_link';
    const judged = evaluateItem({
      facts: {
        listed: false,
        serviceStatus: service.status,
        serviceType: facts.type,
        fulfillment: facts.fulfillment,
        categoryActive: facts.categoryActive,
        categoryName: facts.categoryName,
        categoryAllowedGroupIds: facts.allowedGroupIds,
        retailGroupId: facts.retailGroupId,
        supply,
      },
      title: input.title,
      flags: [],
    });
    if (judged.blockedReason === 'already_listed') return ALREADY_LISTED;
    if (judged.blockedReason !== null) return refused(judged.blockedReason);

    // Step 7: the price, from the quote, the follow row and the rule read under the service lock.
    const target = (await this.pricing.targets(tx, [serviceId])).get(serviceId);
    if (target === undefined) return refused('service_gone');
    const decision = decidePrice(input.price, {
      cost: target.quote.cost,
      floor: target.quote.floor,
      stored: { price: target.quote.retailPrice, following: target.source === 'rule' },
      rule: target.rule === null ? null : { id: target.rule.id, autoFollowPercent: target.rule.autoFollowPercent },
      rulePrice: target.rulePrice,
    });
    if (decision.kind === 'refuse') {
      return refused(
        decision.reason,
        decision.reason === 'price_missing' ? PRICE_MISSING_DETAIL[decision.missing] : decision.detail,
      );
    }

    // Step 8: the address.
    const tried = new Set<string>();
    const freeSlug = async (base: string): Promise<string> => {
      const held = await slugsStartingWith(tx, base.slice(0, SLUG_FAMILY_PREFIX));
      return nextFreeSlug(base, (candidate) => held.has(candidate) || tried.has(candidate));
    };
    let slug: string;
    let base = '';
    if (input.slugSource === 'staff') {
      // Staff's choice cannot be changed for them: they decide again (plan 31 section 3.2).
      if (!isSlug(input.slug)) return refused('slug_taken', `The address ${input.slug} is not valid. Type another.`);
      if ((await listingConflict(tx, serviceId, input.slug)) !== undefined) {
        return refused('slug_taken', `The address ${input.slug} is used by another listing. Type another.`);
      }
      slug = input.slug;
    } else if (isSlug(input.slug) && (await listingConflict(tx, serviceId, input.slug)) === undefined) {
      slug = input.slug;
    } else {
      // The proposed slug was taken since the preview: the next free one of the title's base (of the slug itself when the title
      // gives none).
      base = slugFor(input.title);
      if (!isSlug(base)) base = input.slug;
      if (!isSlug(base))
        return refused('title_missing', 'No address can be made from the title. Type a title or an address.');
      slug = await freeSlug(base);
    }

    // Step 9: the listing, in a savepoint; a writer that took the slug in the meantime gives the next suffix.
    let listingId: number | undefined;
    for (let attempt = 1; listingId === undefined; attempt += 1) {
      const created = await createListingRow(tx, {
        serviceId,
        slug,
        publicTitle: input.title,
        brand: input.brand,
        carrier: input.carrier,
        country: input.country,
      });
      if (created.ok) {
        listingId = created.listing.id;
        break;
      }
      if (created.conflict === 'serviceId') return ALREADY_LISTED;
      if (input.slugSource === 'staff') {
        return refused('slug_taken', `The address ${slug} is used by another listing. Type another.`);
      }
      if (attempt >= MAX_SLUG_TRIES) {
        return refused('slug_taken', `No free address was found after ${MAX_SLUG_TRIES} tries. Try again.`);
      }
      tried.add(slug);
      if (base === '') base = isSlug(slugFor(input.title)) ? slugFor(input.title) : slug;
      slug = await freeSlug(base);
    }

    // Step 10: the price, through the one writer (it refuses a price under the floor of the same quote itself).
    if (decision.kind === 'write')
      await this.retail.set(tx, serviceId, decision.price, writeOf(decision, target.quote));

    // Step 11: the switch, with the listing route's checks (decided at step 6 already).
    if (input.listed) {
      const lock = lockOf({
        serviceStatus: service.status,
        categoryName: facts.categoryName,
        categoryAllowedGroupIds: facts.allowedGroupIds,
        retailGroupId: facts.retailGroupId ?? undefined,
      });
      await switchListing(tx, listingId, true, this.clock.now(), { serviceStatus: service.status, lock });
    }

    // Step 12: the search signal and the one audit row of the published service.
    await this.signals.listingsChanged(tx, [serviceId]);
    const pricing: PublishPricing = decision.kind === 'keep' ? 'kept' : decision.origin;
    await this.audit.record(tx, {
      action: 'published to the storefront',
      entityType: 'listing',
      entityId: listingId,
      entityLabel: service.name,
      after: {
        runId: input.runId,
        requestedBy: input.requestedBy,
        slug,
        publicTitle: input.title,
        brand: input.brand,
        carrier: input.carrier,
        country: input.country,
        retailPrice: decision.price.toWire(),
        pricing,
        ruleId: decision.kind === 'write' && decision.origin === 'rule' ? decision.ruleId : null,
        isListed: input.listed,
      },
    });
    const slugDetail =
      slug === input.slug || !isSlug(input.slug)
        ? null
        : `The address ${input.slug} was taken: the listing got ${slug}.`;
    return {
      result: 'published',
      reason: null,
      detail: resultDetail([slugDetail, decision.detail]),
      listingId,
      slug,
      price: decision.price,
      pricing,
      priceWritten: decision.kind === 'write',
    };
  }
}
