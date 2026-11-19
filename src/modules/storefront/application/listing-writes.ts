// The three writes of a listing that the listing routes, the bulk publisher and the run switch share (feature 31, plan 31 section
// 6.2): the insert with its conflict mapping, the typed retail price with its floor check, and the switch with its disabled and
// locked checks. One rule each, so the console and a publish run never decide differently.
import type { Money } from '../../../common/money';
import { type DbExecutor, isUniqueViolation } from '../../../infra/db';
import type { RetailPrices, RetailWrite } from '../../catalog';
import type { NewServiceListing, ServiceListing } from '../db/schema';
import { type Lock, retailPriceProblem } from '../domain/listing-rules';
import { insertListing, listingConflict, setListed } from '../infra/listing.repository';

/** The answer of {@link createListingRow}: the new listing, or the rule it would break. */
export type ListingInsert =
  | { readonly ok: true; readonly listing: ServiceListing }
  | { readonly ok: false; readonly conflict: 'serviceId' | 'slug' };

/**
 * Inserts a listing, or tells which rule it would break: the service has a listing already, or another listing holds the slug.
 *
 * Why: a service has one listing and a slug is unique for the site (decision 039, B224). The pre-check answers the usual case; two
 * writers that race past it meet at the unique keys, which this maps the same way. The insert runs in a savepoint, so a violation
 * rolls back the insert alone and a caller that turns it into an outcome (the publisher's next slug, `already_listed`) keeps its
 * transaction; the listing route turns it into `409 LISTING_EXISTS` and rolls everything back, as before.
 *
 * Side effects: inserts a `service_listings` row.
 *
 * @param db the caller's transaction (it holds the service row lock)
 * @param values the new row
 * @returns the listing, or the conflict
 * @throws any other database error
 */
export async function createListingRow(db: DbExecutor, values: NewServiceListing): Promise<ListingInsert> {
  const taken = await listingConflict(db, values.serviceId, values.slug);
  if (taken) return { ok: false, conflict: taken };
  try {
    const listing = await db.transaction((savepoint) => insertListing(savepoint, values));
    return { ok: true, listing };
  } catch (error) {
    if (isUniqueViolation(error, 'service_listings_service_uq')) return { ok: false, conflict: 'serviceId' };
    if (isUniqueViolation(error, 'service_listings_slug_uq')) return { ok: false, conflict: 'slug' };
    throw error;
  }
}

/** The answer of {@link checkTypedPrice}: the write to make, or the sentence of the refusal. */
export type TypedPriceCheck =
  { readonly ok: true; readonly write: RetailWrite } | { readonly ok: false; readonly message: string };

/**
 * Judges a retail price a person typed against the storefront floor of now.
 *
 * Why: RESOLUTIONS catalog-12 and b2c-7: a typed retail price under the floor is refused with the group price page's words; the
 * quote is read in the caller's transaction after the service row lock, so the floor cannot move before the write, and the write
 * carries that quote to `RetailPrices.set` (decision 040: it refuses a price under the floor itself).
 *
 * @param retail the catalog's retail price provider
 * @param db the caller's transaction (it holds the service row lock)
 * @param serviceId the live service
 * @param price the typed price
 * @returns the typed write with its quote, or the message for the `retailPrice` field
 * @throws {Error} when the service is not live (the caller locked it, so it is)
 */
export async function checkTypedPrice(
  retail: RetailPrices,
  db: DbExecutor,
  serviceId: number,
  price: Money,
): Promise<TypedPriceCheck> {
  const quote = (await retail.quotes(db, [serviceId])).get(serviceId);
  if (quote === undefined) throw new Error(`Service ${serviceId} has no quote: it is not live.`);
  const problem = retailPriceProblem(price, quote.floor);
  return problem === null
    ? { ok: true, write: { origin: { kind: 'manual' }, quote } }
    : { ok: false, message: problem };
}

/** Why a listing cannot be switched on: its service is disabled, or the lock rule keeps it off the shop (B2B only). */
export type SwitchRefusal = 'service_disabled' | 'locked';

/** What the switch is judged on: the status of the locked service and the lock rule of its category. */
export interface SwitchFacts {
  readonly serviceStatus: string;
  readonly lock: Lock;
}

/**
 * Tells whether a listing may be switched to a value.
 *
 * Why: B53 and the listing route's rule: switching on a disabled service is refused first (a fixable state, its own answer), then a
 * service the lock rule keeps off the shop; switching off is always allowed. The listing route, the publisher and the run switch
 * judge with this one function.
 *
 * @param facts the service status (read under the service lock) and the lock rule
 * @param isListed the target
 * @returns the refusal, or `null` when the switch may happen
 */
export function switchRefusal(facts: SwitchFacts, isListed: boolean): SwitchRefusal | null {
  if (!isListed) return null;
  if (facts.serviceStatus !== 'active') return 'service_disabled';
  if (facts.lock.locked) return 'locked';
  return null;
}

/**
 * Switches a listing on or off the site after {@link switchRefusal} allowed it.
 *
 * Why: the caller decides every refusal before its first write; this checks again so no writer can switch on a listing the rule
 * keeps off. The first switch-on sets `listed_at`, which never resets (feature 22).
 *
 * Side effects: updates `is_listed` and, on the first switch-on, `listed_at` of the listing.
 *
 * @param db the caller's transaction (it holds the service row lock, then the listing row)
 * @param listingId the listing
 * @param isListed the target
 * @param now the clock's time (the first publication's moment)
 * @param facts the facts the caller judged
 * @returns the updated row
 * @throws {Error} when the switch is refused (the caller forgot its check)
 */
export async function switchListing(
  db: DbExecutor,
  listingId: number,
  isListed: boolean,
  now: Date,
  facts: SwitchFacts,
): Promise<ServiceListing> {
  const refusal = switchRefusal(facts, isListed);
  if (refusal !== null) throw new Error(`Listing ${listingId} cannot be switched on: ${refusal}.`);
  return setListed(db, listingId, isListed, now);
}
