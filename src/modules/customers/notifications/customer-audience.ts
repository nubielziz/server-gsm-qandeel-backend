// The retail audience of notification campaigns (customers module, feature 23, plan section 5.3): active accounts that hold no merchant rank, with
// a login or guests, by country, plus listed people of that kind; no campaign reaches an account whose address was never proven
// (decision 053), and a marketing campaign also needs the account's consent (`consentSql`).
import { Injectable } from '@nestjs/common';
import { type SQL, and, asc, eq, gt, inArray, notInArray, or, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
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
import { consentSql, provenAddressSql } from '../infra/consent.repository';

/** The account table, read through the shared schema (the customers module owns no table of accounts: identity does, decision 032). */
const { clients } = s;

const FLAGS: AudienceFlagsSql = {
  inApp: sql`${clients.hasAccount}`,
  email: sql`true`,
};

/**
 * True for an account whose rank is not a merchant rank: every stored kind but `b2b` (the SQL twin of `rankKindOf`, which fails closed: a
 * kind this code has never heard of is a retail rank).
 */
const RETAIL_RANK = sql`not exists (select 1 from client_groups grp where grp.id = ${clients.groupId} and grp.kind = 'b2b')`;

/**
 * The condition of the retail audience.
 *
 * Why: decision 064, plan 5.1 and O3: an account is retail when its rank is not a merchant rank, a guest row included; only `active`
 * ones are reached (the SQL twin of `canAct`: suspended, blocked and erased accounts never); the segment's login and country filters;
 * listed people added (an account that holds a merchant rank is the merchant audience's, so nobody is reached twice), excluded people
 * removed; a marketing campaign keeps only accounts whose `marketing_opt_in` is on and whose latest marketing consent record grants it
 * (`consentSql`). Decision 053: every purpose (a service campaign too) keeps only accounts whose address was proven (a sign-in or
 * verification link was used, an invitation was accepted, or a checkout of theirs was paid), so a guest row made from a typed address
 * that nobody confirmed is never written to.
 *
 * @param query the selection and purpose
 * @param withConsent false to leave the consent condition out (the preview's "no consent" count)
 * @returns a condition over `clients`
 */
export function customerAudienceSql(query: AudienceQuery, withConsent = true): SQL {
  const segment = query.segment as CustomerSegment | undefined;
  const parts: SQL[] = [];
  if (segment !== undefined) {
    parts.push(
      and(
        sql`true`,
        segment.hasAccount === undefined ? undefined : eq(clients.hasAccount, segment.hasAccount),
        segment.countries ? inArray(clients.country, segment.countries) : undefined,
      )!,
    );
  }
  if (query.include.length > 0) parts.push(inArray(clients.id, [...query.include]));
  const selected = parts.length === 0 ? sql`false` : (or(...parts) ?? sql`false`);
  return and(
    eq(clients.status, 'active'),
    RETAIL_RANK,
    provenAddressSql,
    selected,
    query.exclude.length > 0 ? notInArray(clients.id, [...query.exclude]) : undefined,
    withConsent && query.purpose === 'marketing' ? consentSql : undefined,
  )!;
}

/**
 * Selects and counts retail accounts and guests for campaigns.
 *
 * Why: the customers module owns the consent records and the proof of an address; platform reaches them only through this provider
 * (decision 032). The class keeps its name; it serves the `retail` group of an audience (the wire key `customers`).
 */
@Injectable()
export class CustomerAudience implements AudienceProvider {
  readonly kind = 'retail' as const;

  /**
   * Counts the audience.
   *
   * @param db the pool or a transaction
   * @param query the selection, purpose and channels
   * @returns the counts; `noConsent` = the accounts a marketing purpose leaves out
   */
  async count(db: DbExecutor, query: AudienceQuery): Promise<AudienceCounts> {
    const [row] = await db
      .select(audienceCountFields(FLAGS, query.channels))
      .from(clients)
      .where(customerAudienceSql(query));
    let noConsent = 0;
    if (query.purpose === 'marketing') {
      const [all] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(clients)
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
      .select({ id: clients.id, hasAccount: clients.hasAccount })
      .from(clients)
      .where(and(customerAudienceSql(query), gt(clients.id, afterId)))
      .orderBy(asc(clients.id))
      .limit(limit);
    return rows.map((row) => ({ id: row.id, inApp: row.hasAccount, email: true }));
  }

  /**
   * Tells whether one account may still get a campaign of this purpose (consent re-checked for marketing).
   *
   * @param db the pool or a transaction
   * @param purpose the campaign's purpose
   * @param id the account
   * @returns the member, or `undefined` when gone, not active, holding a merchant rank now, or (marketing) without consent
   */
  async member(db: DbExecutor, purpose: NotificationCampaignPurpose, id: number): Promise<AudienceMember | undefined> {
    const [member] = await this.page(db, memberQuery(purpose, id), 0, 1);
    return member;
  }
}
