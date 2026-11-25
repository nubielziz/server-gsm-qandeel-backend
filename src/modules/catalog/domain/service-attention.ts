// The closed vocabularies of the Catalog page's reads (decision 060): why a live service needs staff attention, and why it cannot
// go on the shop. Pure lists; the SQL of each value is in infra/service-attention.sql.ts.

/**
 * Why a live service needs staff attention, in the order a row lists them.
 *
 * Why: decision 060: the "Needs attention" view of the catalog, its count and the badges of a row read one list, so they never
 * disagree. `no_supplier`: an automatic service with no active supplier link (and, decision 069, no available code when it is delivered
 * from code stock). `below_floor`: the price is under the effective
 * cost plus the minimum profit. `price_proposal`: a proposed change of the shop price waits for staff (decision 040).
 * `publish_failed`: the last publish attempt of a service that has no shop page was refused.
 */
export const ATTENTION_REASONS = ['no_supplier', 'below_floor', 'price_proposal', 'publish_failed'] as const;

/** One value of {@link ATTENTION_REASONS}. */
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/**
 * Why a service cannot go on the shop, in the order the publish rule judges them.
 *
 * Why: decision 060: the catalog row says why "Put on the shop" cannot work before a publish run is started. The values and their
 * order are the first four blocking reasons of the storefront's publish rule after `already_listed` (its `evaluateItem`); a test
 * keeps the two equal. The reasons a draft judges (supplier, title, price, address) are not mirrored: they belong to a run.
 */
export const SHOP_BLOCKS = ['service_disabled', 'category_inactive', 'b2b_only', 'not_orderable'] as const;

/** One value of {@link SHOP_BLOCKS}. */
export type ShopBlock = (typeof SHOP_BLOCKS)[number];
