// The registry of audience providers (feature 23, plan section 5.2): identity registers the staff and merchant providers, customers the
// customer provider, at boot. Platform imports no module (decision 032), so the SQL over `staff_users`, `clients` and `customers` lives
// with the module that owns each table, behind this interface.
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../../infra/db';
import type { NotificationCampaignPurpose, NotificationRecipientType } from '../../db/schema';
import type { TypeSelection } from './audience-spec';

/** The channels of a campaign. */
export type CampaignChannel = 'in_app' | 'email';

/** What a provider is asked: the selection of its type, the campaign's purpose and channels. */
export interface AudienceQuery extends TypeSelection {
  readonly purpose: NotificationCampaignPurpose;
  /** The campaign's channels: `reachable` counts the people at least one of them reaches. */
  readonly channels: readonly CampaignChannel[];
}

/** One eligible person of an audience, with the channels that may reach them. */
export interface AudienceMember {
  readonly id: number;
  /** Can see an inbox (customers: has an account). */
  readonly inApp: boolean;
  /** May be emailed for this purpose (merchants: the announcement email switch). */
  readonly email: boolean;
}

/** The counts of one provider for one query. */
export interface AudienceCounts {
  /** Eligible people in the audience, reachable or not. */
  readonly total: number;
  /** People at least one of the chosen channels reaches. */
  readonly reachable: number;
  readonly inApp: number;
  readonly email: number;
  /** Customers left out by a marketing purpose (no consent); 0 for the other types. */
  readonly noConsent: number;
}

/**
 * Selects and counts the people of one recipient type.
 *
 * Why: plan 5.2: each owning module answers for its table with one predicate used by `count`, `page` and `member`, so the
 * preview, the fan-out and the send-time check can never disagree about who is in.
 */
export interface AudienceProvider {
  readonly type: NotificationRecipientType;
  /**
   * Counts the audience.
   *
   * @param db the pool or a transaction
   * @param query the selection, purpose and channels
   * @returns the counts
   */
  count(db: DbExecutor, query: AudienceQuery): Promise<AudienceCounts>;
  /**
   * Reads one page of the audience, by id.
   *
   * @param db the pool or a transaction
   * @param query the selection, purpose and channels
   * @param afterId the last id of the previous page (0 for the first)
   * @param limit the page size
   * @returns the members with `id > afterId`, id ascending
   */
  page(db: DbExecutor, query: AudienceQuery, afterId: number, limit: number): Promise<AudienceMember[]>;
  /**
   * Tells whether one person may still get a campaign of this purpose, ignoring segment filters.
   *
   * @param db the pool or a transaction
   * @param purpose the campaign's purpose
   * @param id the person
   * @returns the member with its channels, or `undefined` when the person is gone or no longer eligible
   */
  member(db: DbExecutor, purpose: NotificationCampaignPurpose, id: number): Promise<AudienceMember | undefined>;
}

/** Counts with every number at zero. */
export const NO_COUNTS: AudienceCounts = {
  total: 0,
  reachable: 0,
  inApp: 0,
  email: 0,
  noConsent: 0,
};

/** The SQL of one provider's per-person flags, over its own table. */
export interface AudienceFlagsSql {
  readonly inApp: SQL;
  readonly email: SQL;
}

/**
 * The SQL that is true when at least one chosen channel reaches the person.
 *
 * @param flags the provider's flag expressions
 * @param channels the campaign's channels
 * @returns a boolean condition (`false` when no channel is chosen)
 */
export function reachableSql(flags: AudienceFlagsSql, channels: readonly CampaignChannel[]): SQL {
  const parts: SQL[] = [];
  if (channels.includes('in_app')) parts.push(sql`(${flags.inApp})`);
  if (channels.includes('email')) parts.push(sql`(${flags.email})`);
  return parts.length === 0 ? sql`false` : sql`(${sql.join(parts, sql` or `)})`;
}

/**
 * The select fields of {@link AudienceProvider.count}, built from a provider's flags.
 *
 * Why: the three providers count the same way (plan 5.2: one predicate for count, page and member); only their flags differ.
 *
 * @param flags the provider's flag expressions
 * @param channels the campaign's channels
 * @returns drizzle select fields (every count but `noConsent`)
 */
export function audienceCountFields(flags: AudienceFlagsSql, channels: readonly CampaignChannel[]) {
  const reach = reachableSql(flags, channels);
  return {
    total: sql<number>`count(*)::int`,
    reachable: sql<number>`(count(*) filter (where ${reach}))::int`,
    inApp: sql<number>`(count(*) filter (where ${flags.inApp}))::int`,
    email: sql<number>`(count(*) filter (where ${flags.email}))::int`,
  };
}

/**
 * The query `member` runs: the person as an `include` id with no segment and every channel.
 *
 * Why: the send-time check is the fan-out's predicate for one id; building it here keeps the three providers the same.
 *
 * @param purpose the campaign's purpose
 * @param id the person
 * @returns the query
 */
export function memberQuery(purpose: NotificationCampaignPurpose, id: number): AudienceQuery {
  return { segment: undefined, include: [id], exclude: [], purpose, channels: ['in_app', 'email'] };
}

/**
 * The providers of the audiences, by recipient type.
 *
 * Why: platform cannot import identity or customers (decision 032); they register here in `onModuleInit`, like the notification
 * events (`support-events.module.ts`). Provided by the global `NotificationEventsModule`, so the API and the worker share one.
 */
@Injectable()
export class NotificationAudiences {
  private readonly providers = new Map<NotificationRecipientType, AudienceProvider>();

  /**
   * Adds a provider.
   *
   * @param provider the provider of one type
   * @throws {Error} when the type already has one (a boot-time mistake)
   */
  register(provider: AudienceProvider): void {
    if (this.providers.has(provider.type))
      throw new Error(`An audience provider for "${provider.type}" is already registered.`);
    this.providers.set(provider.type, provider);
  }

  /**
   * Finds the provider of a type.
   *
   * @param type `staff`, `client` or `customer`
   * @returns the provider
   * @throws {Error} when no module registered one (the module is not loaded in this process)
   */
  get(type: NotificationRecipientType): AudienceProvider {
    const provider = this.providers.get(type);
    if (!provider) throw new Error(`No audience provider is registered for "${type}".`);
    return provider;
  }

  /**
   * Tells whether a type has a provider.
   *
   * @param type the recipient type
   * @returns true when one is registered
   */
  has(type: NotificationRecipientType): boolean {
    return this.providers.has(type);
  }

  /**
   * Lists the registered types.
   *
   * @returns the types, in registration order
   */
  types(): NotificationRecipientType[] {
    return [...this.providers.keys()];
  }
}
