// The merchant audience of notification campaigns (identity module, feature 23, plan section 5.3): merchants by status, group and
// country, plus listed people; the email and Telegram flags are the SQL twin of `choiceFor` for `broadcast.announcement`.
import { Injectable } from '@nestjs/common';
import { type SQL, and, asc, gt, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import {
  type AudienceCounts,
  type AudienceFlagsSql,
  type AudienceMember,
  type AudienceProvider,
  type AudienceQuery,
  type MerchantSegment,
  type NotificationCampaignPurpose,
  audienceCountFields,
  memberQuery,
} from '../../platform';
import { clients } from '../db/schema';

/**
 * A merchant's saved switch of `broadcast.announcement` for one channel, else the event's default (on).
 *
 * Why: B165 and O4/O11: the merchant's preferences decide; a value that is not a JSON boolean reads as "never saved", exactly like
 * `savedChoices` + `choiceFor` (a test walks a matrix of stored preferences and keeps the two equal).
 */
function switchSql(channel: 'email' | 'telegram'): SQL {
  const path = sql.raw(`'{events,broadcast.announcement,${channel}}'`);
  return sql`(case when jsonb_typeof(${clients.notificationPrefs} #> ${path}) = 'boolean' then (${clients.notificationPrefs} #>> ${path})::boolean else true end)`;
}

const FLAGS: AudienceFlagsSql = {
  inApp: sql`true`,
  email: switchSql('email'),
  telegram: sql`(${clients.telegramChatId} is not null and ${switchSql('telegram')})`,
};

/**
 * The condition of the merchant audience.
 *
 * Why: plan 5.1: a listed merchant counts when `active` or `pending`; the segment takes its own statuses (default `active`), groups
 * and countries; suspended merchants are never in; excluded people are removed last.
 *
 * @param query the selection
 * @returns a condition over `clients`
 */
export function merchantAudienceSql(query: AudienceQuery): SQL {
  const segment = query.segment as MerchantSegment | undefined;
  const parts: SQL[] = [];
  if (segment !== undefined) {
    parts.push(
      and(
        inArray(clients.status, segment.statuses ?? ['active']),
        segment.groupIds ? inArray(clients.groupId, segment.groupIds) : undefined,
        segment.countries ? inArray(clients.country, segment.countries) : undefined,
      )!,
    );
  }
  if (query.include.length > 0) parts.push(inArray(clients.id, [...query.include]));
  const selected = parts.length === 0 ? sql`false` : (or(...parts) ?? sql`false`);
  return and(
    inArray(clients.status, ['active', 'pending']),
    selected,
    query.exclude.length > 0 ? notInArray(clients.id, [...query.exclude]) : undefined,
  )!;
}

/**
 * Selects and counts merchants for campaigns.
 *
 * Why: identity owns `clients`; platform reaches the table only through this provider (decision 032).
 */
@Injectable()
export class MerchantAudience implements AudienceProvider {
  readonly type = 'client' as const;

  /**
   * Counts the audience.
   *
   * @param db the pool or a transaction
   * @param query the selection, purpose and channels
   * @returns the counts (`noConsent` is always 0: merchants opt out by their switches)
   */
  async count(db: DbExecutor, query: AudienceQuery): Promise<AudienceCounts> {
    const [row] = await db
      .select(audienceCountFields(FLAGS, query.channels))
      .from(clients)
      .where(merchantAudienceSql(query));
    return { ...row!, noConsent: 0 };
  }

  /**
   * Reads one page of the audience.
   *
   * @param db the pool or a transaction
   * @param query the selection
   * @param afterId the last id of the previous page
   * @param limit the page size
   * @returns the members, id ascending
   */
  async page(db: DbExecutor, query: AudienceQuery, afterId: number, limit: number): Promise<AudienceMember[]> {
    const rows = await db
      .select({
        id: clients.id,
        email: FLAGS.email.mapWith(Boolean),
        telegram: FLAGS.telegram.mapWith(Boolean),
      })
      .from(clients)
      .where(and(merchantAudienceSql(query), gt(clients.id, afterId)))
      .orderBy(asc(clients.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      inApp: true,
      email: row.email,
      telegram: row.telegram,
    }));
  }

  /**
   * Tells whether one merchant may still get a campaign, with the switches as they are now.
   *
   * @param db the pool or a transaction
   * @param purpose the campaign's purpose
   * @param id the merchant
   * @returns the member, or `undefined` when gone or suspended
   */
  async member(db: DbExecutor, purpose: NotificationCampaignPurpose, id: number): Promise<AudienceMember | undefined> {
    const [member] = await this.page(db, memberQuery(purpose, id), 0, 1);
    return member;
  }
}
