// The pure rules of a bulk publish row (feature 31, decision 040, plan 31 sections 3.2, 5.2 and 6.2): the state of a row, its
// flags and its tick (`evaluateItem`, `reflag`), its price mode (`normalisePriceMode`), the price apply writes (`decidePrice`),
// the closed lists the schema does not hold, the constants, a run's stall rule and wire view. Exact decimals: no float.
import { Money } from '../../../../common/money';
import { pgErrorInfo } from '../../../../infra/db/pg-errors';
import { type RetailRulePrice, type SupplyState, costMoved, dollars } from '../../../catalog';
import {
  PUBLISH_BLOCK_REASONS,
  type ListingPublishRun,
  type PublishBlockReason,
  type PublishItemState,
  type PublishPriceMode,
  type PublishRunSource,
  type PublishRunStatus,
  type PublishSwitchStatus,
} from '../../db/schema';
import { belowStorefrontFloorMessage, lockOf } from '../../domain/listing-rules';
import { type BrandKind, HARD_NAMING_FLAGS, type NamingFlag, titleFlags } from './naming';

/** The most services one run takes (a console scope over it is refused; the Quick add hand-over takes the first ones). */
export const MAX_PUBLISH_ITEMS = 5000;

/** How many rows one chunk of an apply reads; each row is its own transaction. */
export const PUBLISH_CHUNK = 50;

/** Rows that fail unexpectedly in one attempt before the run stops `failed` (the Quick add rule). */
export const MAX_ITEM_FAILURES = 20;

/** How long a live run (or switch) may go without a heartbeat before it reads as stalled: five minutes. */
export const PUBLISH_STALE_MS = 5 * 60_000;

/** The longest shop title a row may publish (the listing route's `publicTitle` limit). */
export const MAX_PUBLISH_TITLE_LENGTH = 200;

/** The longest error text a run keeps (`error`, `switch_error`). */
export const MAX_RUN_ERROR_LENGTH = 500;

/** The longest `result_detail` a row keeps. */
export const MAX_RESULT_DETAIL_LENGTH = 300;

/** What a stalled apply reads: the worker stopped before the run finished. */
export const STALLED_ERROR = 'The run stopped before it finished. Start it again: it continues with what is left.';

/** What a run that stalled while preparing its draft reads. */
export const PREPARE_STALLED_ERROR = 'The preview was not finished. Start a new one.';

/** What a stalled run switch reads. */
export const SWITCH_STALLED_ERROR = 'The switch stopped before it finished. Press it again.';

/** What a run that met {@link MAX_ITEM_FAILURES} unexpected failures says. */
export const TOO_MANY_FAILURES_ERROR = `Too many rows failed unexpectedly (${MAX_ITEM_FAILURES}). The rest was not tried.`;

/** What a published row says when a price typed after the preview was kept (plan 31 section 6.2). */
export const TYPED_SINCE_DETAIL = 'A price typed since the preview was kept.';

/**
 * The flags of a publish row, in the order the console lists them: the hard flags (the row waits in `review`), the soft flags, then
 * the two detail flags of a row blocked `price_missing`.
 *
 * Why: plan 31 section 3.2: a closed list no CHECK holds, so it lives here and not in the schema file (fact 21); the console's union
 * must equal it. The naming half is `NAMING_FLAGS`; the evaluation adds `price_at_floor`, `price_kept`, `no_rule` and `no_cost`.
 */
export const PUBLISH_FLAGS = [
  'title_long',
  'duplicate_name',
  'title_taken',
  'quantity_text',
  'multi_country',
  'title_81_100',
  'title_lacks_brand',
  'brackets_repaired',
  'marketing_kept',
  'slug_suffixed',
  'price_at_floor',
  'no_brand',
  'country_from_group',
  'carrier_no_country',
  'price_kept',
  'no_rule',
  'no_cost',
] as const;

/** One value of {@link PUBLISH_FLAGS}. */
export type PublishFlag = (typeof PUBLISH_FLAGS)[number];

/** The flags the price evaluation sets; every evaluation that judges the price recomputes them. */
const PRICE_FLAGS: ReadonlySet<PublishFlag> = new Set(['price_at_floor', 'price_kept', 'no_rule', 'no_cost']);

/**
 * The reasons of a row's result at apply: `left_out`, the blocking reasons, and what the re-check on the locked service found.
 *
 * Why: plan 31 section 3.2 (the result table): `skipped` with `left_out` or the row's blocking reason, `skipped: already_listed`,
 * `refused` with one of the re-check's reasons, `cost_moved` (the publish limit) or `failed` (an unexpected error). A closed list no
 * CHECK holds (fact 21).
 */
export const PUBLISH_RESULT_REASONS = [
  'left_out',
  'service_gone',
  ...PUBLISH_BLOCK_REASONS,
  'cost_moved',
  'failed',
] as const satisfies readonly string[];

/** One value of {@link PUBLISH_RESULT_REASONS}. */
export type PublishResultReason = (typeof PUBLISH_RESULT_REASONS)[number];

/** Orders flags as {@link PUBLISH_FLAGS} lists them, each once; a string that is not a flag is dropped. */
function ordered(flags: Iterable<string>): PublishFlag[] {
  const set = new Set<string>(flags);
  return PUBLISH_FLAGS.filter((flag) => set.has(flag));
}

/**
 * The state that follows from a blocking reason and the flags: `blocked`, else `review` with a hard flag, else `ready`.
 *
 * Why: plan 31 section 3.2; a bulk fix of the facts recomputes the flags and the state with it (section 5.2).
 *
 * @param blockedReason the row's blocking reason, or `null`
 * @param flags the row's flags
 * @returns the state
 */
export function itemState(blockedReason: PublishBlockReason | null, flags: readonly string[]): PublishItemState {
  if (blockedReason !== null) return 'blocked';
  return flags.some((flag) => HARD_NAMING_FLAGS.has(flag as NamingFlag)) ? 'review' : 'ready';
}

/** What a publish row is judged on about its live service, read when the row is evaluated (at apply: under the service lock). */
export interface PublishFacts {
  /** The service has a listing already. */
  readonly listed: boolean;
  readonly serviceStatus: string;
  readonly serviceType: string;
  readonly fulfillment: string;
  /** `service_categories.is_active`. */
  readonly categoryActive: boolean;
  readonly categoryName: string;
  /** The merchant groups that can see the category; empty: every group. */
  readonly categoryAllowedGroupIds: readonly number[];
  /** The storefront retail group, or `null` when it does not exist. */
  readonly retailGroupId: number | null;
  /** Whether a supplier can take an order now (catalog `supplyStates`). */
  readonly supply: SupplyState;
}

/** The price a row would write, keep or be refused for (the answer of {@link decidePrice}). */
export type PriceDecision =
  | {
      readonly kind: 'write';
      readonly origin: 'manual';
      readonly price: Money;
      readonly detail: string | null;
    }
  | {
      readonly kind: 'write';
      readonly origin: 'rule';
      readonly price: Money;
      readonly ruleId: number;
      /** The effective cost of now, which the follow row records. */
      readonly cost: Money;
      /** The rule price was lifted to the floor (the soft flag `price_at_floor`). */
      readonly atFloor: boolean;
      readonly detail: string | null;
    }
  | {
      readonly kind: 'keep';
      /** The stored retail price, which stays as it is (typed or following). */
      readonly price: Money;
      /** `kept` (the row keeps the price), `following` (the rule's own), `typed_since` (typed after staff chose the rule). */
      readonly why: 'kept' | 'following' | 'typed_since';
      readonly detail: string | null;
    }
  | {
      readonly kind: 'refuse';
      readonly reason: 'price_missing';
      /** Which half: no active rule matches, or the effective cost is 0. */
      readonly missing: 'no_rule' | 'no_cost';
      readonly detail: null;
    }
  | { readonly kind: 'refuse'; readonly reason: 'below_floor'; readonly floor: Money; readonly detail: string }
  | {
      readonly kind: 'refuse';
      readonly reason: 'cost_moved';
      readonly from: Money;
      readonly to: Money;
      readonly detail: string;
    };

/** What {@link evaluateItem} judges. */
export interface EvaluateInput {
  readonly facts: PublishFacts;
  /** The title the row would publish. */
  readonly title: string;
  /** The row's flags (the naming flags are kept as given; the price flags are recomputed when `price` is given). */
  readonly flags: readonly string[];
  /** The price decision of the row ({@link decidePrice} with the row's own cost as the cost of now); left out: the facts alone. */
  readonly price?: PriceDecision;
  /** The row's slug is one staff typed and a listing holds it now. */
  readonly staffSlugTaken?: boolean;
  /** The row's state and tick before this evaluation; left out for a new row (it was never evaluated). */
  readonly previous?: { readonly state: PublishItemState; readonly included: boolean };
}

/** The answer of {@link evaluateItem}. */
export interface ItemEvaluation {
  readonly state: PublishItemState;
  /** The first blocking reason that applies, or `null`. */
  readonly blockedReason: PublishBlockReason | null;
  readonly flags: PublishFlag[];
  /** The tick after the evaluation (the tick rule of plan 31 section 3.2). */
  readonly included: boolean;
}

/** The first blocking reason the facts and the title give, in the order of `PUBLISH_BLOCK_REASONS` (up to `title_too_long`). */
function factBlock(facts: PublishFacts, title: string): PublishBlockReason | null {
  if (facts.listed) return 'already_listed';
  if (facts.serviceStatus !== 'active') return 'service_disabled';
  if (!facts.categoryActive) return 'category_inactive';
  // The service is active here, so the listing route's lock rule can only refuse the category (B2B only).
  const lock = lockOf({
    serviceStatus: facts.serviceStatus,
    categoryName: facts.categoryName,
    categoryAllowedGroupIds: facts.categoryAllowedGroupIds,
    retailGroupId: facts.retailGroupId ?? undefined,
  });
  if (lock.locked) return 'b2b_only';
  if (facts.serviceType === 'file') return 'not_orderable';
  if (facts.fulfillment === 'auto' && facts.supply !== 'ok') return 'supplier_unavailable';
  if (title.trim() === '') return 'title_missing';
  if (title.length > MAX_PUBLISH_TITLE_LENGTH) return 'title_too_long';
  return null;
}

/** The flags a price decision sets. */
function priceFlags(price: PriceDecision): PublishFlag[] {
  if (price.kind === 'write' && price.origin === 'rule' && price.atFloor) return ['price_at_floor'];
  if (price.kind === 'keep') return ['price_kept'];
  if (price.kind === 'refuse' && price.reason === 'price_missing') return [price.missing];
  return [];
}

/**
 * Gives a publish row its state, at most one blocking reason, its flags and its tick.
 *
 * Why: plan 31 sections 3.2 and 6.2: one function judges a row at prepare, after an edit and again at apply on the locked service
 * (the stored state is never trusted for a write). The blocking reasons are judged in their order: the facts (`already_listed` to
 * `supplier_unavailable`), the title, the price (`price_missing`, `below_floor`, from `price`) and the address (`slug_taken`, a
 * slug staff typed that a listing holds). At apply the publisher passes the facts alone (step 6) and judges the price and the
 * address itself (steps 7 and 8), so `cost_moved` stays a result and never a state. The tick: a row that becomes `blocked` loses it;
 * a row that leaves `blocked` (or is new) gets the default of its new state (`ready`: ticked); otherwise it stays as staff left it.
 *
 * @param input the facts, the title, the flags, the price decision, the slug check and the previous state and tick
 * @returns the state, the blocking reason, the flags (in the order of {@link PUBLISH_FLAGS}) and the tick
 * @throws {RangeError} when `price` is a `cost_moved` refusal (a draft is evaluated with its own cost, so it cannot arise there)
 */
export function evaluateItem(input: EvaluateInput): ItemEvaluation {
  const { facts, title, price } = input;
  if (price?.kind === 'refuse' && price.reason === 'cost_moved') {
    throw new RangeError(
      'A row is evaluated with its own cost as the cost of now: cost_moved is a result, not a state.',
    );
  }
  const kept = input.flags.filter((flag) => price === undefined || !PRICE_FLAGS.has(flag as PublishFlag));
  const flags = ordered(price === undefined ? kept : [...kept, ...priceFlags(price)]);
  let blockedReason = factBlock(facts, title);
  if (blockedReason === null && price?.kind === 'refuse') blockedReason = price.reason;
  if (blockedReason === null && input.staffSlugTaken === true) blockedReason = 'slug_taken';
  const state = itemState(blockedReason, flags);
  const previous = input.previous;
  const included =
    state === 'blocked'
      ? false
      : previous === undefined || previous.state === 'blocked'
        ? state === 'ready'
        : previous.included;
  return { state, blockedReason, flags, included };
}

/** How a row asks to be priced, as stored on it. */
export interface PriceChoice {
  readonly mode: PublishPriceMode;
  /** The price staff typed (`manual` only). */
  readonly override: Money | null;
  /** The typed price staff chose to replace with the rule price (`rule` only). */
  readonly replacesPrice: Money | null;
}

/** The retail price a service has now. */
export interface StoredRetailPrice {
  /** The stored retail price, or `null`. */
  readonly price: Money | null;
  /** True when the price follows a rule (a follow row exists); false when it is typed. */
  readonly following: boolean;
}

/** A price key of the row's `PATCH` (plan 31 section 5.2), or `reset`. */
export type PriceKey =
  | { readonly kind: 'typed'; readonly price: Money }
  | { readonly kind: 'rule' }
  | { readonly kind: 'keep' }
  | { readonly kind: 'reset' };

/** A typed retail price, or `null` (none, or one that follows a rule). */
const typedPrice = (now: StoredRetailPrice): Money | null => (now.price !== null && !now.following ? now.price : null);

/**
 * Sets the price mode of a row: the default at prepare, the price keys of the row's `PATCH`, and the normalisation every
 * evaluation makes against the price the service has now.
 *
 * Why: plan 31 section 5.2, so a row never promises to replace a price nobody chose to replace. The default is `keep` when the
 * service has a retail price, else `rule`. `typed P` stores `manual` with `P`; `rule` stores `rule` and, when the service has a
 * typed price now, that price as `replacesPrice` (staff chose the rule over exactly it); `keep` stores `keep`; `reset` the default;
 * each clears what the others set. Then: a `rule` row whose `replacesPrice` is no longer the stored typed price loses it; a `rule`
 * row without `replacesPrice` whose service has a retail price becomes `keep`; a `keep` row whose price is gone becomes `rule`; a
 * `manual` row stays (it is blocked `below_floor` when under the floor of now).
 *
 * @param current the row's choice, or `null` for a new row
 * @param now the service's retail price now and whether it is typed or following
 * @param key a price key of the row's `PATCH`, or `reset`
 * @returns the normalised choice
 * @throws {RangeError} when a typed price is not above zero, or a stored `manual` choice has no price
 */
export function normalisePriceMode(current: PriceChoice | null, now: StoredRetailPrice, key?: PriceKey): PriceChoice {
  const fallback: PriceChoice = { mode: now.price === null ? 'rule' : 'keep', override: null, replacesPrice: null };
  let choice: PriceChoice;
  if (key === undefined) choice = current ?? fallback;
  else if (key.kind === 'typed') choice = { mode: 'manual', override: key.price, replacesPrice: null };
  else if (key.kind === 'rule') choice = { mode: 'rule', override: null, replacesPrice: typedPrice(now) };
  else if (key.kind === 'keep') choice = { mode: 'keep', override: null, replacesPrice: null };
  else choice = fallback;

  if (choice.mode === 'manual') {
    if (choice.override === null || !choice.override.isPositive()) {
      throw new RangeError('A typed price of a row is above zero.');
    }
    return { mode: 'manual', override: choice.override, replacesPrice: null };
  }
  if (choice.mode === 'keep') {
    return now.price === null
      ? { mode: 'rule', override: null, replacesPrice: null }
      : { mode: 'keep', override: null, replacesPrice: null };
  }
  const typed = typedPrice(now);
  const replaces = choice.replacesPrice !== null && typed !== null && typed.eq(choice.replacesPrice) ? typed : null;
  if (replaces === null && now.price !== null) return { mode: 'keep', override: null, replacesPrice: null };
  return { mode: 'rule', override: null, replacesPrice: replaces };
}

/** What {@link decidePrice} reads of a row: its price choice and the figures its preview was evaluated with. */
export interface PriceRow extends PriceChoice {
  /** The effective cost the row was evaluated with (the cost the publish limit compares with). */
  readonly cost: Money;
  /** The rule price the preview showed, or `null`. */
  readonly rulePrice: Money | null;
  /** The retail price the service had at the preview, or `null` (display only: no write is decided from it). */
  readonly existingPrice: Money | null;
}

/** What {@link decidePrice} reads of the service now: the quote, the stored price and the rule, read under the service lock. */
export interface PriceNow {
  /** The effective cost of now. */
  readonly cost: Money;
  /** The storefront floor of now. */
  readonly floor: Money;
  /** The stored retail price and whether it follows a rule. */
  readonly stored: StoredRetailPrice;
  /** The active rule that prices the service now, or `null`. */
  readonly rule: { readonly id: number; readonly autoFollowPercent: number } | null;
  /** That rule's price for the cost and floor of now (`RetailPricing.targets`), or `null` without a rule. */
  readonly rulePrice: RetailRulePrice | null;
}

/** The sentence of a published price that differs from the figure the preview showed, or `null`. */
function differsDetail(price: Money, shown: Money | null): string | null {
  if (shown === null || shown.eq(price)) return null;
  return `The price is ${dollars(price)}, not the ${dollars(shown)} of the preview.`;
}

/**
 * Decides the price a row writes at apply: a price to write (with its origin), the stored price to keep, or a refusal.
 *
 * Why: decision 040 and the price table of plan 31 section 6.2 (money, reviewed line by line). A typed price is never overwritten
 * unasked: only `replacesPrice`, which only staff's explicit choice in the row sets, licenses replacing one, and only while it is
 * still the stored typed price (`existingPrice` decides nothing). The rows:
 * - `manual` `P`: `P` at or above the floor of now is written as typed; under it the row is refused `below_floor` (a typed price is
 *   never raised silently).
 * - `keep` with a stored price: no write (typed or following, it stays). `keep` with the price gone: by the rule.
 * - `rule` with no stored price: by the rule. `rule` and a following price: no write (it is the rule's already, or a proposal
 *   waits). `rule`, `replacesPrice` equal to the stored typed price: by the rule. `rule` and any other typed price: no write
 *   ({@link TYPED_SINCE_DETAIL}).
 * By the rule: no active rule or a cost of 0 now is `price_missing`; the publish limit (`costMoved(row cost, cost of now,
 * autoFollowPercent)`) is `cost_moved` with both costs; otherwise the rule price of now (never the preview's figure; at or above the
 * floor by construction) with the cost of now. A published price that differs from the preview's figure says so in its detail.
 *
 * @param row the row's choice and the figures of its preview
 * @param now the cost, floor, stored price and rule of now, read under the service lock
 * @returns the decision
 * @throws {RangeError} when a `manual` row has no price above zero (the row's CHECK forbids it)
 */
export function decidePrice(row: PriceRow, now: PriceNow): PriceDecision {
  if (row.mode === 'manual') {
    const price = row.override;
    if (price === null || !price.isPositive()) throw new RangeError('A typed price of a row is above zero.');
    if (price.cmp(now.floor) < 0) {
      return {
        kind: 'refuse',
        reason: 'below_floor',
        floor: now.floor,
        detail: belowStorefrontFloorMessage(now.floor),
      };
    }
    return { kind: 'write', origin: 'manual', price, detail: null };
  }
  const stored = now.stored.price;
  if (stored !== null) {
    if (row.mode === 'keep') {
      return { kind: 'keep', price: stored, why: 'kept', detail: differsDetail(stored, row.existingPrice) };
    }
    if (now.stored.following) {
      return { kind: 'keep', price: stored, why: 'following', detail: differsDetail(stored, row.rulePrice) };
    }
    if (row.replacesPrice === null || !row.replacesPrice.eq(stored)) {
      return { kind: 'keep', price: stored, why: 'typed_since', detail: TYPED_SINCE_DETAIL };
    }
    // Staff chose the rule over exactly this typed price: by the rule.
  }
  return byRule(row, now);
}

/** "By the rule" of plan 31 section 6.2: `price_missing`, then the publish limit, then the rule price of now. */
function byRule(row: PriceRow, now: PriceNow): PriceDecision {
  if (now.rule === null || now.rulePrice === null) {
    return { kind: 'refuse', reason: 'price_missing', missing: 'no_rule', detail: null };
  }
  if (now.rulePrice.kind === 'no_cost') {
    return { kind: 'refuse', reason: 'price_missing', missing: 'no_cost', detail: null };
  }
  if (costMoved(row.cost, now.cost, now.rule.autoFollowPercent)) {
    return {
      kind: 'refuse',
      reason: 'cost_moved',
      from: row.cost,
      to: now.cost,
      detail: `The cost moved from ${dollars(row.cost)} to ${dollars(now.cost)} since the preview. Check the preview again.`,
    };
  }
  const price = now.rulePrice.price;
  // A keep row whose price is gone showed the price it had; a rule row showed the rule price.
  const shown = row.mode === 'keep' ? row.existingPrice : row.rulePrice;
  return {
    kind: 'write',
    origin: 'rule',
    price,
    ruleId: now.rule.id,
    cost: now.cost,
    atFloor: now.rulePrice.atFloor,
    detail: differsDetail(price, shown),
  };
}

/** The fields of a row {@link reflag} reads: what will be published and what the rules detected. */
export interface ReflagInput {
  readonly flags: readonly string[];
  readonly title: string;
  readonly slug: string;
  readonly brand: string;
  readonly carrier: string;
  readonly country: string;
  readonly detected: {
    readonly title: string;
    readonly slug: string;
    readonly brand: string;
    readonly brandKind: BrandKind | null;
    readonly carrier: string;
    readonly country: string;
  };
  /** Whether the title is a listing's or another row's (one read of the caller); left out: the flag stays as it is. */
  readonly titleTaken?: boolean;
}

/**
 * Recomputes, after an edit, the flags that derive from the edited fields.
 *
 * Why: plan 31 section 3.2: `title_long`, `title_81_100`, `title_lacks_brand`, `no_brand` and `carrier_no_country` are worked out
 * again from the fields; `multi_country` stays only while the country is empty; a detection flag stays only while the field it
 * speaks of still holds the detected value (`country_from_group`: the country; `brackets_repaired`, `marketing_kept`: the title;
 * `slug_suffixed`: the slug); `title_taken` comes from the caller. The flags of the supplier name (`duplicate_name`,
 * `quantity_text`) and of the price stay as they are. A brand staff typed has no known kind, so it never lacks in the title.
 *
 * @param input the row's flags, fields and detected values
 * @returns the flags, in the order of {@link PUBLISH_FLAGS}
 */
export function reflag(input: ReflagInput): PublishFlag[] {
  const { detected } = input;
  const had = new Set(input.flags);
  const derived = new Set<string>([
    'title_long',
    'title_81_100',
    'title_lacks_brand',
    'no_brand',
    'carrier_no_country',
    'multi_country',
    'country_from_group',
    'brackets_repaired',
    'marketing_kept',
    'slug_suffixed',
    'title_taken',
  ]);
  const out = new Set<string>([...had].filter((flag) => !derived.has(flag)));
  const brandKind = input.brand === detected.brand ? detected.brandKind : null;
  for (const flag of titleFlags(input.title, input.brand, brandKind)) out.add(flag);
  if (input.carrier !== '' && input.country === '') out.add('carrier_no_country');
  if (had.has('multi_country') && input.country === '') out.add('multi_country');
  if (had.has('country_from_group') && input.country === detected.country) out.add('country_from_group');
  if (had.has('brackets_repaired') && input.title === detected.title) out.add('brackets_repaired');
  if (had.has('marketing_kept') && input.title === detected.title) out.add('marketing_kept');
  if (had.has('slug_suffixed') && input.slug === detected.slug) out.add('slug_suffixed');
  if (input.titleTaken === undefined ? had.has('title_taken') : input.titleTaken) out.add('title_taken');
  return ordered(out);
}

/**
 * Tells whether a live run has gone five minutes without a heartbeat.
 *
 * Why: plan 31 section 5.2: the queue `imports` has one attempt and no stalled re-run, so a worker that died leaves its run
 * `preparing`, `queued` or `running`; a read shows it `failed` and staff start again (a read never writes).
 *
 * @param run the run's status and heartbeat
 * @param nowMs the clock's time in epoch milliseconds
 * @returns true for a `preparing`, `queued` or `running` run whose heartbeat is older than {@link PUBLISH_STALE_MS}
 */
export function isStalled(
  run: { readonly status: PublishRunStatus; readonly heartbeatAt: Date },
  nowMs: number,
): boolean {
  if (run.status !== 'preparing' && run.status !== 'queued' && run.status !== 'running') return false;
  return nowMs - run.heartbeatAt.getTime() > PUBLISH_STALE_MS;
}

/**
 * Tells whether a live run switch has gone five minutes without a heartbeat.
 *
 * Why: plan 31 sections 5.2 and 6.7: the switch writes the run's heartbeat after every chunk; a stalled one reads `failed`.
 *
 * @param run the run's switch status and heartbeat
 * @param nowMs the clock's time in epoch milliseconds
 * @returns true for a `queued` or `running` switch whose heartbeat is older than {@link PUBLISH_STALE_MS}
 */
export function isSwitchStalled(
  run: { readonly switchStatus: PublishSwitchStatus | null; readonly heartbeatAt: Date },
  nowMs: number,
): boolean {
  if (run.switchStatus !== 'queued' && run.switchStatus !== 'running') return false;
  return nowMs - run.heartbeatAt.getTime() > PUBLISH_STALE_MS;
}

/**
 * What a run covers, as staff sent it (plan 31 section 5.2).
 *
 * Why: stored as sent in `listing_publish_runs.scope`; the console shows it.
 */
export type PublishScope =
  | { readonly kind: 'services'; readonly serviceIds: number[] }
  | { readonly kind: 'category'; readonly categoryId: number }
  | { readonly kind: 'supplier'; readonly supplierId: number }
  | { readonly kind: 'quickAddRun'; readonly runId: number }
  | { readonly kind: 'run'; readonly runId: number }
  | { readonly kind: 'all' };

/** The counts of a run's rows: the draft's states and the apply's results (a live read counts the rows). */
export interface PublishRunCounts {
  readonly ready: number;
  readonly review: number;
  readonly blocked: number;
  readonly included: number;
  /** Rows that wait for a pricing rule (flag `no_rule`). */
  readonly noRule: number;
  readonly published: number;
  readonly skipped: number;
  readonly refused: number;
  /** Rows without a result. */
  readonly pending: number;
}

/** A publish run as the console reads it (`PublishRun` of plan 31 section 5.2). */
export interface PublishRunView {
  readonly id: number;
  readonly status: PublishRunStatus;
  readonly source: PublishRunSource;
  readonly quickAddRunId: number | null;
  readonly scope: PublishScope;
  readonly listed: boolean;
  readonly auto: boolean;
  readonly total: number;
  readonly counts: PublishRunCounts;
  readonly switch: {
    readonly status: PublishSwitchStatus | null;
    readonly listed: boolean | null;
    readonly switched: number;
    readonly skipped: number;
    readonly error: string | null;
  };
  readonly replacedBy: number | null;
  readonly error: string | null;
  readonly requestedBy: number | null;
  readonly requestedByName: string | null;
  readonly createdAt: string;
  readonly preparedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/**
 * Turns a run row into what the console reads.
 *
 * Why: plan 31 section 5.2: a stalled run only **reads** `failed` (a read never writes): `PREPARE_STALLED_ERROR` when it stalled
 * while preparing, else `STALLED_ERROR`; a stalled switch reads `failed` with `SWITCH_STALLED_ERROR`.
 *
 * @param run the run row
 * @param counts the counts of its rows
 * @param requestedByName the name of the staff member who asked (a join), or `null`
 * @param nowMs the clock's time in epoch milliseconds
 * @returns the wire shape
 */
export function runView(
  run: ListingPublishRun,
  counts: PublishRunCounts,
  requestedByName: string | null,
  nowMs: number,
): PublishRunView {
  const stalled = isStalled(run, nowMs);
  const switchStalled = isSwitchStalled(run, nowMs);
  return {
    id: run.id,
    status: stalled ? 'failed' : run.status,
    source: run.source,
    quickAddRunId: run.sourceRunId,
    scope: run.scope as unknown as PublishScope,
    listed: run.listed,
    auto: run.auto,
    total: run.total,
    counts: { ...counts },
    switch: {
      status: switchStalled ? 'failed' : run.switchStatus,
      listed: run.switchListed,
      switched: run.switchedCount,
      skipped: run.switchSkippedCount,
      error: switchStalled ? SWITCH_STALLED_ERROR : run.switchError,
    },
    replacedBy: run.replacedByRunId,
    error: stalled ? (run.status === 'preparing' ? PREPARE_STALLED_ERROR : STALLED_ERROR) : run.error,
    requestedBy: run.requestedBy,
    requestedByName,
    createdAt: run.createdAt.toISOString(),
    preparedAt: run.preparedAt?.toISOString() ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * The reason a row that failed unexpectedly reports in `result_detail`.
 *
 * Why: plan 31 section 6.2 step 4: the console shows it to staff, so it never carries SQL, values or stack traces: the violated
 * constraint's name, else `unexpected error` (the full error goes to the log only).
 *
 * @param error whatever the row's transaction threw
 * @returns the constraint name, or `unexpected error`
 */
export function failureReason(error: unknown): string {
  return pgErrorInfo(error)?.constraint ?? 'unexpected error';
}

/**
 * Joins the sentences of a row's result and cuts them to {@link MAX_RESULT_DETAIL_LENGTH} characters.
 *
 * @param parts the sentences (`null` and empty ones are left out)
 * @returns the detail, or `null` when there is none
 */
export function resultDetail(parts: readonly (string | null | undefined)[]): string | null {
  const text = parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
  return text === '' ? null : text.slice(0, MAX_RESULT_DETAIL_LENGTH);
}
