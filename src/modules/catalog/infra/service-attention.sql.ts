// The Catalog page's facts as SQL over `services` (decision 060): each attention reason, the shop block, "not on the shop" and the
// shop price, held ONCE here, so the list's filters, its sort, its count and the flags of a row use the same expressions and cannot
// disagree. The fragments over other modules' tables come from foreign-reads.repository.ts (its deviation banner); this file composes
// them with the catalog's own tables.
import { type SQL, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { clientGroups, retailPriceChanges, serviceCategories, serviceGroupPrices, services } from '../db/schema';
import { ATTENTION_REASONS, type AttentionReason, type ShopBlock } from '../domain/service-attention';
import {
  hasActiveSupplierLinkSql,
  hasListingSql,
  isListedSql,
  latestPublishRefusedSql,
} from './foreign-reads.repository';
import { belowFloorSql } from './service-figures.sql';

// Every reason is about an enabled service: a switched-off service needs nothing (an archived one is never in the list).
const ACTIVE = sql`"services"."status" = 'active'`;

/** A proposal of the shop price waits for staff (`retail_price_changes_open_uq`, decision 040). */
const waitingProposalSql = sql`(exists (
  select 1 from ${retailPriceChanges} c
  where c.service_id = "services"."id" and c.kind = 'proposed' and c.resolved_at is null))`;

/** The service's category is switched on. */
const categoryActiveSql = sql`(exists (
  select 1 from ${serviceCategories} c where c.id = "services"."category_id" and c.is_active))`;

/**
 * The service's category is not offered to the shop's retail group: the storefront's `lockOf` (a group list that leaves the retail
 * group out, or no retail group at all; an empty list means every group).
 */
const b2bOnlySql = sql`(exists (
  select 1 from ${serviceCategories} c
  where c.id = "services"."category_id" and cardinality(c.allowed_group_ids) > 0
    and not coalesce((select g.id from ${clientGroups} g where g.kind = 'b2c_retail') = any(c.allowed_group_ids), false)))`;

/**
 * The condition of one attention reason (NULL-free, in parentheses).
 *
 * Why: decision 060: `no_supplier` is an automatic service with no active supplier link (a manual one needs none); `below_floor`
 * is `belowFloorSql` at the clock's now, the dashboard's figure; `price_proposal` a waiting proposal of the shop price;
 * `publish_failed` a refused last publish attempt of a service that has no listing at all. Each needs an enabled service.
 *
 * @param reason the reason
 * @param at the clock's now: the pricing rules in force at it set the floor (decision 031)
 * @returns the SQL condition
 */
export function attentionReasonSql(reason: AttentionReason, at: Date): SQL<boolean> {
  switch (reason) {
    case 'no_supplier':
      return sql`(${ACTIVE} and "services"."fulfillment" = 'auto' and not ${hasActiveSupplierLinkSql})`;
    case 'below_floor':
      return sql`(${ACTIVE} and ${belowFloorSql(at)})`;
    case 'price_proposal':
      return sql`(${ACTIVE} and ${waitingProposalSql})`;
    case 'publish_failed':
      return sql`(${ACTIVE} and ${latestPublishRefusedSql} and not ${hasListingSql})`;
  }
}

/**
 * The filter `needsAttention`: any of the reasons the caller may see.
 *
 * @param reasons the reasons the caller may see (decision 060); none gives `false`
 * @param at the clock's now
 * @returns the SQL condition
 */
export function needsAttentionSql(reasons: readonly AttentionReason[], at: Date): SQL<boolean> {
  if (reasons.length === 0) return sql`(false)`;
  return sql`(${sql.join(
    reasons.map((reason) => attentionReasonSql(reason, at)),
    sql` or `,
  )})`;
}

/**
 * Why the service cannot go on the shop: the first of `SHOP_BLOCKS` that applies, in the publish rule's order, or NULL.
 *
 * Why: decision 060: the SQL twin of the storefront publish rule's first checks (`evaluateItem`); a test keeps the two equal.
 */
export const shopBlockedSql: SQL<ShopBlock | null> = sql`(case
  when "services"."status" <> 'active' then 'service_disabled'
  when not ${categoryActiveSql} then 'category_inactive'
  when ${b2bOnlySql} then 'b2b_only'
  when "services"."type" = 'file' then 'not_orderable'
end)`;

/**
 * The filter `notOnShop`: an enabled service that is not listed (no listing, or one switched off) and could be.
 *
 * Why: decision 060: the "Not on the shop" view lists what staff can put on the shop, so it reaches zero; a B2B-only, inactive or
 * file service is never in it.
 */
export const notOnShopSql: SQL<boolean> = sql`(${ACTIVE} and not ${isListedSql} and ${shopBlockedSql} is null)`;

/** The shop price: the service's price for the single retail group (decision 040), or NULL. The list sorts on it (nulls last). */
export const retailPriceSql: SQL<string | null> = sql`(
  select gp.price from ${serviceGroupPrices} gp
  join ${clientGroups} g on g.id = gp.group_id
  where gp.service_id = "services"."id" and g.kind = 'b2c_retail'
  limit 1)`;

/** The flags of one service, worked out from the fragments above. */
export interface AttentionFlags {
  /** Every reason that holds, in the order of `ATTENTION_REASONS` (the caller narrows them to what may be seen). */
  readonly reasons: AttentionReason[];
  readonly shopBlocked: ShopBlock | null;
}

/**
 * Works out the attention reasons and the shop block of a page of services in one query.
 *
 * Why: decision 060: the row's `attention` and `shopBlocked` come from the same fragments as the filters, in their own select
 * (the page query also serves the bulk price change, which must not pay for them).
 *
 * @param db the database or a transaction
 * @param serviceIds the services of a page
 * @param at the clock's now
 * @returns the flags by service id; an unknown id is absent
 */
export async function attentionFlagsOf(
  db: DbExecutor,
  serviceIds: readonly number[],
  at: Date,
): Promise<Map<number, AttentionFlags>> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: services.id,
      noSupplier: attentionReasonSql('no_supplier', at),
      belowFloor: attentionReasonSql('below_floor', at),
      priceProposal: attentionReasonSql('price_proposal', at),
      publishFailed: attentionReasonSql('publish_failed', at),
      shopBlocked: shopBlockedSql,
    })
    .from(services)
    .where(inArray(services.id, ids));
  return new Map(
    rows.map((row) => {
      const holds: Record<AttentionReason, boolean> = {
        no_supplier: row.noSupplier,
        below_floor: row.belowFloor,
        price_proposal: row.priceProposal,
        publish_failed: row.publishFailed,
      };
      return [row.id, { reasons: ATTENTION_REASONS.filter((reason) => holds[reason]), shopBlocked: row.shopBlocked }];
    }),
  );
}
