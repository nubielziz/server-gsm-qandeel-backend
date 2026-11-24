// The pure side of preparing a publish draft (feature 31, plan 31 sections 3.2, 3.5, 5.2 and 6.1): which naming rules a service gets,
// what a copied row of "Check again" keeps, and the row a draft stores after naming and evaluation. No database, no clock, no Nest.
import { Money } from '../../../../common/money';
import type { PublishItemState, PublishPriceMode, PublishSlugSource } from '../../db/schema';
import type { AssignedSlug, BrandKind, NamedService, PublishServiceType } from './naming';
import {
  type PriceChoice,
  type PriceKey,
  type PriceNow,
  type PriceRow,
  type PublishFacts,
  type PublishFlag,
  decidePrice,
  evaluateItem,
  normalisePriceMode,
  reflag,
} from './publish-item';

/** What the rules detected for a row, as stored in `listing_publish_items.detected` (the "Reset" of a row). */
export interface DraftDetected {
  readonly title: string;
  readonly slug: string;
  readonly brand: string;
  readonly brandKind: BrandKind | null;
  readonly carrier: string;
  readonly country: string;
}

/**
 * Which naming rules a service gets: `imei` when its type is `imei` or it has a field flagged as the main input, else its type.
 *
 * Why: plan 31, correction 1 after the merge: decision 042 makes an IMEI supplier service whose main box is not an IMEI a catalog
 * `server` service (352 of the owner's 880), and such a service must keep its carrier and device brand, so it is named by the IMEI
 * rules. The naming code does not change; only the type it is given does.
 *
 * @param type the catalog service type
 * @param hasMainInput the service has a field flagged as the main input (`service_fields.is_main_input`, decision 065)
 * @returns the type the naming reads
 */
export function namingTypeOf(type: string, hasMainInput: boolean): PublishServiceType {
  if (type === 'imei' || hasMainInput) return 'imei';
  return type === 'server' || type === 'remote' || type === 'file' ? type : 'server';
}

/** What a draft row keeps when "Check again" copies it (plan 31 section 5.2). */
export interface CopiedRow {
  readonly title: string;
  readonly slug: string;
  readonly slugSource: PublishSlugSource;
  readonly brand: string;
  readonly carrier: string;
  readonly country: string;
  readonly detected: DraftDetected;
  readonly priceMode: PublishPriceMode;
  readonly priceOverride: Money | null;
  readonly edited: boolean;
  /** The old row's state and tick. */
  readonly state: PublishItemState;
  readonly included: boolean;
}

/** The `previous` argument of `evaluateItem`. */
export interface TickState {
  readonly state: PublishItemState;
  readonly included: boolean;
}

/**
 * The tick a copied row hands to its evaluation: its own, when staff changed it from the default of its state, else none (the new
 * state's default applies).
 *
 * Why: plan 31 sections 3.2 and 5.2: "the tick, when staff had changed it from the default of the row's state"; every row is evaluated
 * afresh, so a row whose obstacle is gone becomes `ready` and ticked.
 *
 * @param copy the old row's state and tick
 * @returns the previous state and tick for `evaluateItem`, or `undefined` for a row at its default
 */
export function copiedTick(copy: Pick<CopiedRow, 'state' | 'included'>): TickState | undefined {
  const byDefault = copy.state === 'ready';
  return copy.included === byDefault ? undefined : { state: copy.state, included: copy.included };
}

/** What {@link buildDraftRow} judges. */
export interface DraftRowInput {
  readonly serviceId: number;
  /** The naming of the row (with `fixedTitle` when the row is an edited copy). */
  readonly named: NamedService;
  /** The slug `assignSlugs` gave the row. */
  readonly assigned: AssignedSlug;
  /** The row the draft copies, or `undefined` for a new row. */
  readonly copy?: CopiedRow;
  /** The facts of the live service now. */
  readonly facts: PublishFacts;
  /** The cost, floor, stored price and rule now. */
  readonly price: PriceNow;
  /** The slugs the listings hold (a typed address one of them holds is `blocked: slug_taken`). */
  readonly listingSlugs: ReadonlySet<string>;
}

/** One row of the draft as stored: the fields of `listing_publish_items` that prepare and an edit write. */
export interface DraftRow {
  readonly serviceId: number;
  readonly detected: DraftDetected;
  readonly title: string;
  readonly slug: string;
  readonly slugSource: PublishSlugSource;
  readonly brand: string;
  readonly carrier: string;
  readonly country: string;
  readonly priceMode: PublishPriceMode;
  readonly priceOverride: string | null;
  readonly replacesPrice: string | null;
  readonly existingPrice: string | null;
  readonly cost: string;
  readonly floorPrice: string;
  readonly ruleId: number | null;
  readonly rulePrice: string | null;
  readonly state: PublishItemState;
  readonly blockedReason: ReturnType<typeof evaluateItem>['blockedReason'];
  readonly flags: PublishFlag[];
  readonly included: boolean;
  readonly edited: boolean;
}

/**
 * Judges the price of a draft row: the normalised choice, the decision, and the rule price the row shows.
 *
 * Why: plan 31 sections 5.2 and 6.2 (and the draft evaluation of correction 2): the choice is normalised against the price the service
 * has now, and `decidePrice` runs with the row's cost equal to the cost of now, so `cost_moved` cannot arise in a draft. The row's
 * `PATCH` passes the price key staff sent (or `reset`), which `normalisePriceMode` applies before it normalises.
 *
 * @param current the row's stored choice, or `null` for a new row
 * @param now the cost, floor, stored price and rule of now
 * @param key the price key of a row edit, or nothing
 * @returns the choice, the decision and the rule's price (`null` without a rule or for a cost of 0)
 * @throws {RangeError} when a typed price of the key is not above zero
 */
export function draftPrice(
  current: PriceChoice | null,
  now: PriceNow,
  key?: PriceKey,
): { choice: PriceChoice; decision: ReturnType<typeof decidePrice>; rulePrice: Money | null } {
  const choice = normalisePriceMode(current, now.stored, key);
  const rulePrice = now.rulePrice?.kind === 'price' ? now.rulePrice.price : null;
  const row: PriceRow = { ...choice, cost: now.cost, rulePrice, existingPrice: now.stored.price };
  return { choice, decision: decidePrice(row, now), rulePrice };
}

/**
 * Builds the row a draft stores for one service: its detection, its price choice and its evaluation.
 *
 * Why: plan 31 sections 3.2, 5.2 and 6.1 (steps 4 and 5). A new row takes what the naming found. A copied row that staff edited keeps
 * its title and its three facts and a typed address; their flags are worked out again from those fields (`reflag`) against what the
 * rules detected. Every copied row keeps its price choice (never `replaces_price`) and, when staff changed it, its tick. Every row is
 * evaluated afresh on the facts of now (`evaluateItem`).
 *
 * @param input the naming, the slug, the copy, the facts and the price figures
 * @returns the row to store
 */
export function buildDraftRow(input: DraftRowInput): DraftRow {
  const { named, assigned, copy, facts, price } = input;
  const keepsFields = copy?.edited === true;
  const typedAddress = copy?.slugSource === 'staff';
  const title = keepsFields ? copy.title : named.title;
  const brand = keepsFields ? copy.brand : named.brand;
  const carrier = keepsFields ? copy.carrier : named.carrier;
  const country = keepsFields ? copy.country : named.country;
  const slugSource: PublishSlugSource = typedAddress ? 'staff' : 'auto';
  const slug = typedAddress ? copy.slug : assigned.slug;
  const detected: DraftDetected = keepsFields
    ? copy.detected
    : {
        title: named.title,
        slug: assigned.slug,
        brand: named.brand,
        brandKind: named.brandKind,
        carrier: named.carrier,
        country: named.country,
      };
  const naming: string[] = [...named.flags];
  if (!typedAddress && assigned.suffixed) naming.push('slug_suffixed');
  const flags = keepsFields
    ? reflag({
        flags: naming,
        title,
        slug,
        brand,
        carrier,
        country,
        detected,
        titleTaken: named.flags.includes('title_taken'),
      })
    : naming;

  const { choice, decision, rulePrice } = draftPrice(
    copy === undefined ? null : { mode: copy.priceMode, override: copy.priceOverride, replacesPrice: null },
    price,
  );
  const evaluation = evaluateItem({
    facts,
    title,
    flags,
    price: decision,
    staffSlugTaken: typedAddress && input.listingSlugs.has(slug),
    ...(copy === undefined ? {} : copiedTickOf(copy)),
  });
  return {
    serviceId: input.serviceId,
    detected,
    title,
    slug,
    slugSource,
    brand,
    carrier,
    country,
    priceMode: choice.mode,
    priceOverride: choice.override?.toWire() ?? null,
    replacesPrice: choice.replacesPrice?.toWire() ?? null,
    existingPrice: price.stored.price?.toWire() ?? null,
    cost: price.cost.toWire(),
    floorPrice: price.floor.toWire(),
    ruleId: price.rule?.id ?? null,
    rulePrice: rulePrice?.toWire() ?? null,
    state: evaluation.state,
    blockedReason: evaluation.blockedReason,
    flags: evaluation.flags,
    included: evaluation.included,
    edited: keepsFields,
  };
}

/** The `previous` key of `evaluateItem` for a copied row (nothing when the tick is at its default). */
function copiedTickOf(copy: CopiedRow): { previous?: TickState } {
  const previous = copiedTick(copy);
  return previous === undefined ? {} : { previous };
}
