// What the console reads of a publish run's row (feature 31, plan 31 section 5.2): `PublishItem` from a stored row, the joins of its
// service, category and listing, and the label of its rule. Pure: exact decimals, no database.
import { Money } from '../../../../common/money';
import { marginPercent } from '../../../catalog';
import type { ListingPublishItem, PublishItemResult, PublishItemState, PublishPriceMode } from '../../db/schema';
import type { PublishServiceType } from './naming';
import type { DraftDetected } from './publish-draft';
import type { PublishFlag } from './publish-item';

/** A publish row as the console reads it (`PublishItem` of plan 31 section 5.2). */
export interface PublishItemView {
  readonly id: number;
  readonly serviceId: number;
  readonly service: {
    readonly id: number;
    readonly name: string;
    readonly code: string;
    readonly type: PublishServiceType;
    readonly categoryName: string;
  };
  readonly title: string;
  readonly slug: string;
  readonly brand: string;
  readonly carrier: string;
  readonly country: string;
  readonly detected: DraftDetected;
  readonly edited: boolean;
  readonly cost: string;
  readonly floorPrice: string;
  readonly rule: { readonly id: number; readonly label: string } | null;
  readonly rulePrice: string | null;
  readonly priceMode: PublishPriceMode;
  readonly existingPrice: string | null;
  readonly replacesPrice: string | null;
  readonly retailPrice: string | null;
  readonly marginPct: string | null;
  readonly state: PublishItemState;
  readonly blockedReason: ListingPublishItem['blockedReason'];
  readonly flags: PublishFlag[];
  readonly included: boolean;
  readonly evaluatedAt: string | null;
  readonly result: PublishItemResult | null;
  readonly resultReason: string | null;
  readonly resultDetail: string | null;
  readonly listingId: number | null;
  readonly publishedPrice: string | null;
  readonly listingListed: boolean | null;
}

/** What {@link itemView} reads: the row, its joins and the label of its rule. */
export interface ItemViewInput {
  readonly item: ListingPublishItem;
  readonly service: {
    readonly name: string;
    readonly code: string;
    readonly type: PublishServiceType;
    readonly categoryName: string;
  };
  /** Whether the row's listing is on the shop now; `null` without a listing. */
  readonly listingListed: boolean | null;
  /** The rule's label, or `null` when the row names no rule. */
  readonly ruleLabel: string | null;
}

/** What a row shows as detected before its first evaluation (its `detected` is still empty: a preview that was never finished). */
const NOTHING_DETECTED: DraftDetected = { title: '', slug: '', brand: '', brandKind: null, carrier: '', country: '' };

/**
 * The price apply would store for a row: the typed one, the kept one, or the rule price.
 *
 * Why: plan 31 section 5.2 (`retailPrice`): `manual` stores the typed price, `keep` leaves the stored one (the price the service had at
 * the last evaluation), `rule` writes the rule's price; it is `null` when the mode has none (no rule, or a cost of 0).
 *
 * @param item the stored row
 * @returns the price as wire text, or `null`
 */
export function retailPriceOf(
  item: Pick<ListingPublishItem, 'priceMode' | 'priceOverride' | 'existingPrice' | 'rulePrice'>,
): string | null {
  if (item.priceMode === 'manual') return item.priceOverride;
  if (item.priceMode === 'keep') return item.existingPrice;
  return item.rulePrice;
}

/**
 * Turns a stored row into what the console reads.
 *
 * Why: plan 31 section 5.2: one `PublishItem` for the list and the edits; the margin is the figure of the listings table
 * (`marginPercent`), and `listingListed` says whether the row's listing is on the shop now.
 *
 * @param input the row, its service, category and listing facts, and its rule's label
 * @returns the wire shape
 */
export function itemView(input: ItemViewInput): PublishItemView {
  const { item } = input;
  const retailPrice = retailPriceOf(item);
  const price = retailPrice === null ? null : Money.of(retailPrice);
  return {
    id: item.id,
    serviceId: item.serviceId,
    service: { id: item.serviceId, ...input.service },
    title: item.title,
    slug: item.slug,
    brand: item.brand,
    carrier: item.carrier,
    country: item.country,
    // A row is listed before the naming reached it while a preview is prepared, and for good when that preview failed.
    detected: { ...NOTHING_DETECTED, ...(item.detected as unknown as Partial<DraftDetected>) },
    edited: item.edited,
    cost: item.cost,
    floorPrice: item.floorPrice,
    rule: item.ruleId !== null && input.ruleLabel !== null ? { id: item.ruleId, label: input.ruleLabel } : null,
    rulePrice: item.rulePrice,
    priceMode: item.priceMode,
    existingPrice: item.existingPrice,
    replacesPrice: item.replacesPrice,
    retailPrice,
    marginPct: price !== null && price.isPositive() ? marginPercent(price, Money.of(item.cost)) : null,
    state: item.state,
    blockedReason: item.blockedReason,
    flags: item.flags as PublishFlag[],
    included: item.included,
    evaluatedAt: item.evaluatedAt?.toISOString() ?? null,
    result: item.result,
    resultReason: item.resultReason,
    resultDetail: item.resultDetail,
    listingId: item.listingId,
    publishedPrice: item.publishedPrice,
    listingListed: input.listingListed,
  };
}
