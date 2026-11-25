// The pure side of editing a row of a publish draft (feature 31, plan 31 sections 3.2 and 5.2): what the row's `PATCH` turns a stored row
// into (its fields, its price choice, its flags, its state and its tick), and what a bulk change of the facts does to a row. It composes
// the rules of `publish-item.ts` and `publish-draft.ts` and holds none of its own. No database, no clock, no Nest.
import { Money } from '../../../../common/money';
import type { PublishBlockReason, PublishItemState, PublishPriceMode, PublishSlugSource } from '../../db/schema';
import { SLUG_FORM_MESSAGE, isSlug } from '../../domain/slug';
import { retailPriceProblem } from '../../domain/listing-rules';
import { type NamingInput, detectFacts, nextFreeSlug, slugFor } from './naming';
import { type DraftDetected, type DraftRow, draftPrice } from './publish-draft';
import {
  type PriceChoice,
  type PriceKey,
  type PriceNow,
  type PublishFacts,
  type PublishFlag,
  evaluateItem,
  itemState,
  reflag,
} from './publish-item';

/** The sentence staff read for each blocking reason: what is wrong and how to fix it (`included: true` on a blocked row answers it). */
export const BLOCK_SENTENCES: Readonly<Record<PublishBlockReason, string>> = {
  already_listed: 'This service is already on the shop.',
  service_disabled: 'The service is disabled. Enable it first.',
  category_inactive: 'The category is switched off. Switch it on first.',
  b2b_only: 'The category is not open to the shop. Open it first.',
  not_orderable: 'A file service cannot be ordered online.',
  supplier_unavailable: 'No active supplier can take this service. Link or resume a supplier first.',
  out_of_stock: 'No codes in stock and no supplier. Import codes or link a supplier first.',
  title_missing: 'The title is empty. Type a title.',
  title_too_long: 'The title is over 200 characters. Shorten it.',
  price_missing: 'No pricing rule covers this service, or its cost is 0. Make a rule or type a price.',
  below_floor: 'The price is under the storefront floor. Type a higher price or use the rule.',
  slug_taken: 'The address is used by a listing. Type another.',
};

/** One refusal of an edit: a field of the request, a code and the sentence staff read (a `422` item). */
export interface EditProblem {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** The stored row an edit starts from. */
export interface EditableRow {
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
  readonly flags: readonly string[];
  readonly state: PublishItemState;
  readonly included: boolean;
  readonly edited: boolean;
}

/** The body of the row's `PATCH`, as parsed (every key optional; the contract demands at least one). */
export interface RowEdit {
  readonly title?: string;
  /** An address, or `''`: make it from the title again. */
  readonly slug?: string;
  readonly brand?: string;
  readonly carrier?: string;
  readonly country?: string;
  /** A typed price, as wire text. */
  readonly retailPrice?: string;
  readonly pricing?: 'rule' | 'keep';
  readonly included?: boolean;
  /** Back to what was detected; alone in the body. */
  readonly reset?: true;
}

/** What an edit is judged against: the facts of now, the figures, and the addresses and titles that are taken. */
export interface EditWorld {
  /** The live service and its category now. */
  readonly facts: PublishFacts;
  /** The cost, floor, stored price and rule now. */
  readonly price: PriceNow;
  /** What the naming reads of the service (for the detection flags a reset gives back). */
  readonly naming: NamingInput;
  /** The slugs of every listing. */
  readonly listingSlugs: ReadonlySet<string>;
  /** The slugs of the other rows of the run. */
  readonly otherSlugs: ReadonlySet<string>;
  /** Whether a title is a listing's, or another row's under a different supplier name (`title_taken`); asked for a changed title only. */
  readonly titleTaken: (title: string) => boolean;
}

/** The answer of {@link editRow}. */
export type EditResult =
  { readonly ok: true; readonly row: DraftRow } | { readonly ok: false; readonly problems: readonly EditProblem[] };

const TITLE_FIELDS = ['title', 'slug', 'brand', 'carrier', 'country'] as const;

/**
 * Tells whether the body of a row's `PATCH` carries a price key.
 *
 * Why: plan 31 section 5.1: a retail price needs `pricing:update` (decision 046), so `retailPrice` and `pricing` need it too, and a role that
 * may only prepare previews cannot set shop prices through one.
 *
 * @param edit the body
 * @returns true when `retailPrice` or `pricing` is sent
 */
export function editsPrice(edit: Pick<RowEdit, 'retailPrice' | 'pricing'>): boolean {
  return edit.retailPrice !== undefined || edit.pricing !== undefined;
}

/**
 * Tells whether a reset of a row would throw away a price choice staff made in it.
 *
 * Why: plan 31 section 5.1: a price needs `pricing:update`, and a reset puts the row back on the default price. On a row with a typed
 * price or a rule chosen over a typed price that is a price edit (a role that may only prepare previews must not swap a typed 50.00 for the
 * rule's 13.00); on any other row a reset leaves the price alone.
 *
 * @param row the price choice of the stored row
 * @returns true when the row holds a typed price or `replaces_price`
 */
export function resetDropsPriceChoice(row: Pick<EditableRow, 'priceMode' | 'replacesPrice'>): boolean {
  return row.priceMode === 'manual' || row.replacesPrice !== null;
}

const problem = (field: string, code: string, message: string): EditProblem => ({ field, code, message });

const moneyOrNull = (value: string | null): Money | null => (value === null ? null : Money.of(value));

/**
 * Turns a stored row and the body of its `PATCH` into the row to store, or says what is refused.
 *
 * Why: plan 31 sections 3.2 and 5.2. The fields are set (an edit sets `edited`, a reset clears it); an address typed is `staff`, `''`
 * makes one from the title (`nextFreeSlug` against the listings and the other rows), and an address that is not typed follows an
 * edited title, as a copy of the draft does; the price key goes through `normalisePriceMode` and the row is judged on the facts of now
 * (`evaluateItem`, with its own cost as the cost of now); the flags that derive from the fields are worked out again (`reflag`; a
 * reset also gives back the flags of the supplier name that an earlier edit dropped); the tick follows the rule of 3.2 unless the body
 * sends it. Every refusal is returned before anything is stored.
 *
 * @param current the stored row
 * @param edit the body
 * @param world the facts of now and the addresses and titles that are taken
 * @returns the row to store, or the refusals (a `422` with these field errors)
 */
export function editRow(current: EditableRow, edit: RowEdit, world: EditWorld): EditResult {
  const reset = edit.reset === true;
  if (reset && Object.entries(edit).some(([key, value]) => key !== 'reset' && value !== undefined)) {
    return fail(problem('reset', 'conflict', 'Reset goes alone: send nothing else with it.'));
  }
  if (edit.retailPrice !== undefined && edit.pricing !== undefined) {
    return fail(problem('retailPrice', 'conflict', 'Send a price, or ask for the rule or the kept price, not both.'));
  }

  const problems: EditProblem[] = [];
  const detected = current.detected;
  const touchesFields = reset || TITLE_FIELDS.some((field) => edit[field] !== undefined);
  const title = reset ? detected.title : (edit.title ?? current.title);
  const brand = reset ? detected.brand : (edit.brand ?? current.brand);
  const carrier = reset ? detected.carrier : (edit.carrier ?? current.carrier);
  const country = reset ? detected.country : (edit.country ?? current.country);

  // The address. Held by a listing or by another row of the run: the row's own address is not held against itself.
  const held = (slug: string): boolean => world.listingSlugs.has(slug) || world.otherSlugs.has(slug);
  let slug = current.slug;
  let slugSource: PublishSlugSource = current.slugSource;
  if (reset) {
    slug = nextFreeSlug(detected.slug, held);
    slugSource = 'auto';
  } else if (edit.slug === '') {
    slug = nextFreeSlug(slugFor(title), held);
    slugSource = 'auto';
    if (slug === '') {
      problems.push(
        problem('slug', 'invalid', 'The title has no letters or digits to make an address from. Type one.'),
      );
    }
  } else if (edit.slug !== undefined) {
    if (!isSlug(edit.slug)) problems.push(problem('slug', 'invalid', SLUG_FORM_MESSAGE));
    else if (held(edit.slug)) {
      problems.push(problem('slug', 'duplicate', 'This address is used by a listing or by another row of this run.'));
    } else slug = edit.slug;
    slugSource = 'staff';
  } else if (edit.title !== undefined && edit.title !== current.title && current.slugSource === 'auto') {
    // A title with no letters or digits has no address to follow it: the row keeps the one it has.
    const base = slugFor(title);
    if (base !== '') slug = nextFreeSlug(base, held);
    else if (slug === '') {
      problems.push(
        problem('title', 'invalid', 'The title has no letters or digits to make an address from. Type an address too.'),
      );
    }
  }

  // The price key.
  const stored = world.price.stored;
  let key: PriceKey | undefined;
  if (reset) key = { kind: 'reset' };
  else if (edit.retailPrice !== undefined) {
    const price = Money.of(edit.retailPrice);
    const refused = retailPriceProblem(price, world.price.floor);
    if (refused !== null)
      problems.push(problem('retailPrice', price.isPositive() ? 'below_floor' : 'invalid', refused));
    else key = { kind: 'typed', price };
  } else if (edit.pricing === 'rule') key = { kind: 'rule' };
  else if (edit.pricing === 'keep') {
    if (stored.price === null)
      problems.push(problem('pricing', 'invalid', 'This service has no retail price to keep.'));
    else key = { kind: 'keep' };
  }
  if (problems.length > 0) return { ok: false, problems };

  const choice: PriceChoice = {
    mode: current.priceMode,
    override: moneyOrNull(current.priceOverride),
    replacesPrice: moneyOrNull(current.replacesPrice),
  };
  const priced = draftPrice(choice, world.price, key);

  let flags: readonly string[] = current.flags;
  if (touchesFields) {
    // A reset gives back the flags of the supplier name that an earlier edit dropped; `reflag` keeps each one only while the field it
    // speaks of holds the detected value again.
    const known = reset ? [...current.flags, ...detectFacts(world.naming).flags] : current.flags;
    flags = reflag({
      flags: known,
      title,
      slug,
      brand,
      carrier,
      country,
      detected,
      ...(title === current.title ? {} : { titleTaken: world.titleTaken(title) }),
    });
    // An address made from the title that got a suffix says so (the soft flag of the preview). A title with no letters or digits makes no
    // address: the row keeps the one it had, which is no suffix.
    const fromTitle = slugFor(title);
    if (
      slugSource === 'auto' &&
      slug !== '' &&
      fromTitle !== '' &&
      slug !== fromTitle &&
      !flags.includes('slug_suffixed')
    ) {
      flags = [...flags, 'slug_suffixed'];
    }
  }

  const evaluation = evaluateItem({
    facts: world.facts,
    title,
    flags,
    price: priced.decision,
    staffSlugTaken: slugSource === 'staff' && world.listingSlugs.has(slug),
    previous: { state: current.state, included: current.included },
  });
  let included = evaluation.included;
  if (edit.included !== undefined) {
    if (edit.included && evaluation.state === 'blocked') {
      return fail(problem('included', 'blocked', BLOCK_SENTENCES[evaluation.blockedReason!]));
    }
    included = edit.included;
  }

  return {
    ok: true,
    row: {
      serviceId: current.serviceId,
      detected,
      title,
      slug,
      slugSource,
      brand,
      carrier,
      country,
      priceMode: priced.choice.mode,
      priceOverride: priced.choice.override?.toWire() ?? null,
      replacesPrice: priced.choice.replacesPrice?.toWire() ?? null,
      existingPrice: world.price.stored.price?.toWire() ?? null,
      cost: world.price.cost.toWire(),
      floorPrice: world.price.floor.toWire(),
      ruleId: world.price.rule?.id ?? null,
      rulePrice: priced.rulePrice?.toWire() ?? null,
      state: evaluation.state,
      blockedReason: evaluation.blockedReason,
      flags: evaluation.flags,
      included,
      edited: reset ? false : current.edited || touchesFields,
    },
  };
}

function fail(...problems: EditProblem[]): EditResult {
  return { ok: false, problems };
}

/** The stored row a bulk change of the facts starts from. */
export interface FactsRow {
  readonly title: string;
  readonly slug: string;
  readonly brand: string;
  readonly carrier: string;
  readonly country: string;
  readonly detected: DraftDetected;
  readonly flags: readonly string[];
  readonly blockedReason: PublishBlockReason | null;
}

/** The facts a bulk change sets (each optional). */
export interface FactsChange {
  readonly brand?: string;
  readonly carrier?: string;
  readonly country?: string;
}

/**
 * Sets the brand, carrier or country of a row, with the flags and the state that follow.
 *
 * Why: plan 31 section 5.2 (`bulk`): `reflag` recomputes the flags that derive from the three facts (`no_brand`, `title_lacks_brand`,
 * `carrier_no_country`, `country_from_group`, `multi_country`) and the state follows from the flags. A fact never blocks or unblocks
 * a row and no tick moves, so the blocking reason stays.
 *
 * @param row the stored row
 * @param change the facts to set
 * @returns `null` when no fact differs (the row is left as it is), else the new facts, flags and state
 */
export function withFacts(
  row: FactsRow,
  change: FactsChange,
): { brand: string; carrier: string; country: string; flags: PublishFlag[]; state: PublishItemState } | null {
  const brand = change.brand ?? row.brand;
  const carrier = change.carrier ?? row.carrier;
  const country = change.country ?? row.country;
  if (brand === row.brand && carrier === row.carrier && country === row.country) return null;
  const flags = reflag({
    flags: row.flags,
    title: row.title,
    slug: row.slug,
    brand,
    carrier,
    country,
    detected: row.detected,
  });
  return { brand, carrier, country, flags, state: itemState(row.blockedReason, flags) };
}
