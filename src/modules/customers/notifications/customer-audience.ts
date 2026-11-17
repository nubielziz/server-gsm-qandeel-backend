// The customer audience of notification campaigns (customers module, feature 23, plan section 5.3): active customers, accounts or
// guests, by country, plus listed people; a marketing campaign also needs the customer's consent (`consentSql`).
import { Injectable } from '@nestjs/common';
import { type SQL, and, asc, eq, gt, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import {
  type AudienceCounts,
  type AudienceFlagsSql,
  type AudienceMember,
  type AudienceProvider,
  type AudienceQuery,
  type CustomerSegment,
  type NotificationCampaignPurpose,
  audienceCountFields,
  memberQuery,
} from '../../platform';
import { customers } from '../db/schema';
import { consentSql } from '../infra/recovery.repository';

const FLAGS: AudienceFlagsSql = {
  inApp: sql`${customers.hasAccount}`,
  email: sql`true`,
  telegram: sql`false`,
};

/**
 * The condition of the customer audience.
 *
 * Why: plan 5.1 and O3: only `active` customers (suspended, blocked and anonymized ones never); the segment's account and country
 * filters; listed people added, excluded people removed; a marketing campaign keeps only customers whose
 * `marketing_opt_in` is on and whose latest marketing consent record grants it (the predicate of the recovery mail).
 *
 * @param query the selection and purpose
 * @param withConsent false to leave the consent condition out (the preview's "no consent" count)
 * @returns a condition over `customers`
 */
export function customerAudienceSql(query: AudienceQuery, withConsent = true): SQL {
  const segment = query.segment as CustomerSegment | undefined;
  const parts: SQL[] = [];
  if (segment !== undefined) {
    parts.push(
      and(
        sql`true`,
        segment.hasAccount === undefined ? undefined : eq(customers.hasAccount, segment.hasAccount),
        segment.countries ? inArray(customers.country, segment.countries) : undefined,
      )!,
    );
  }
  if (query.include.length > 0) parts.push(inArray(customers.id, [...query.include]));
  const selected = parts.length === 0 ? sql`false` : (or(...parts) ?? sql`false`);
  return and(
    eq(customers.status, 'active'),
    selected,
    query.exclude.length > 0 ? notInArray(customers.id, [...query.exclude]) : undefined,
    withConsent && query.purpose === 'marketing' ? consentSql : undefined,
  )!;
}

/**
 * Selects and counts customers for campaigns.
 *
 * Why: the customers module owns `customers` and `consent_records`; platform reaches them only through this provider (decision 032).
 */
@Injectable()
export class CustomerAudience implements AudienceProvider {
  readonly type = 'customer' as const;

  /**
   * Counts the audience.
   *
   * @param db the pool or a transaction
   * @param query the selection, purpose and channels
   * @returns the counts; `noConsent` = the customers a marketing purpose leaves out
   */
  async count(db: DbExecutor, query: AudienceQuery): Promise<AudienceCounts> {
    const [row] = await db
      .select(audienceCountFields(FLAGS, query.channels))
      .from(customers)
      .where(customerAudienceSql(query));
    let noConsent = 0;
    if (query.purpose === 'marketing') {
      const [all] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(customers)
        .where(customerAudienceSql(query, false));
      noConsent = (all?.total ?? 0) - row!.total;
    }
    return { ...row!, noConsent };
  }

  /**
   * Reads one page of the audience.
   *
   * @param db the pool or a transaction
   * @param query the selection and purpose
   * @param afterId the last id of the previous page
   * @param limit the page size
   * @returns the members, id ascending
   */
  async page(db: DbExecutor, query: AudienceQuery, afterId: number, limit: number): Promise<AudienceMember[]> {
    const rows = await db
      .select({ id: customers.id, hasAccount: customers.hasAccount })
      .from(customers)
      .where(and(customerAudienceSql(query), gt(customers.id, afterId)))
      .orderBy(asc(customers.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      inApp: row.hasAccount,
      email: true,
      telegram: false,
    }));
  }

  /**
   * Tells whether one customer may still get a campaign of this purpose (consent re-checked for marketing).
   *
   * @param db the pool or a transaction
   * @param purpose the campaign's purpose
   * @param id the customer
   * @returns the member, or `undefined` when gone, not active or (marketing) without consent
   */
  async member(db: DbExecutor, purpose: NotificationCampaignPurpose, id: number): Promise<AudienceMember | undefined> {
    const [member] = await this.page(db, memberQuery(purpose, id), 0, 1);
    return member;
  }
}
