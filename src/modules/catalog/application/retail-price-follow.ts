// RetailPriceFollow: the follow pass (decision 040, plan 31 sections 3.4 and 6.4): it walks the following retail prices, works out what
// each one should be now, moves or proposes in one transaction per service, and tells staff at most once an hour.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { DbService, pgErrorInfo } from '../../../infra/db';
import { NotificationService, RETAIL_PRICES_FOLLOWED_EVENT } from '../../platform';
import { decideFollow, followHasWork } from '../domain/retail-follow';
import {
  hasUnnotifiedChange,
  lockRetailNotice,
  markChangesNotified,
  notifiedSince,
  waitingProposalsOf,
} from '../infra/retail-price-change.repository';
import { followServiceIdsAfter, ruleRowsOf } from '../infra/retail-price-rule.repository';
import { CatalogPriceVersion } from './catalog-price-version';
import { type FollowStep, RetailFollowSteps, followFactsOf, waitingProposalOf } from './retail-follow-steps';
import { RetailPricing, priceWithRules } from './retail-pricing';
import { retailRuleOf } from './retail-rules';

/** The following services one read of the pass covers. */
export const RETAIL_FOLLOW_PAGE = 200;
/** The hourly message goes out at most this often. */
export const RETAIL_NOTICE_INTERVAL_MS = 3_600_000;

/** The channels of the hourly message. */
const NOTICE_CHANNELS = ['email', 'telegram'] as const;

/** The SQLSTATEs of a transaction that lost to another one: a deadlock and a serialization failure. */
const LOST_RACE_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '40001']);

/** What one pass did (kept briefly with the BullMQ job, and in `job_runs` for a recorded run). */
export interface RetailFollowResult {
  /** Following services walked. */
  readonly checked: number;
  /** Those that needed a transaction of their own. */
  readonly candidates: number;
  /** Prices written at once. */
  readonly followed: number;
  /** Proposals opened. */
  readonly proposed: number;
  /** Waiting proposals written again with new figures. */
  readonly rewritten: number;
  /** Prices found changed another way: they are typed ones now. */
  readonly detached: number;
  /** Follow rows removed (an archived service, no retail row). */
  readonly removed: number;
  /** Prices the rule already gives: the follow row caught up. */
  readonly settled: number;
  /** Services whose transaction lost to another one; the next pass takes them. */
  readonly skipped: number;
  /** Services whose transaction failed for another reason (logged); the next pass tries again. */
  readonly failed: number;
  /** True when the hourly message was written. */
  readonly notified: boolean;
}

/** A pass that did nothing. */
export const NO_FOLLOW_RESULT: RetailFollowResult = {
  checked: 0,
  candidates: 0,
  followed: 0,
  proposed: 0,
  rewritten: 0,
  detached: 0,
  removed: 0,
  settled: 0,
  skipped: 0,
  failed: 0,
  notified: false,
};

/** The result of one service. */
type ServiceOutcome = FollowStep | 'lost' | 'failed';

/**
 * Makes following retail prices follow their rules.
 *
 * Why: decision 040: when the effective cost, the floor or the rule changes, a following price moves by itself inside the rule's limit,
 * and a bigger move waits for staff. Every candidate is one transaction under its service row lock, so the pass never holds two
 * services and cannot form a cycle with a supplier sync, a typed price or a publish. It compares stored state with computed state and
 * writes only differences, so a repeat, or two passes side by side, change nothing more. A price it wrote moves the catalog price
 * version once at the end; that schedules one more pass, which finds nothing and does not move it again, so the chain ends by itself.
 *
 * Side effects: through `RetailFollowSteps`, writes `service_group_prices`, `retail_price_follows`, `retail_price_changes` and
 * `audit_logs`; moves the catalog price version; at most once an hour marks `retail_price_changes.notified_at` and writes the
 * `retail.prices_followed` notifications with their outbox events.
 *
 * @see docs/decisions/040-retail-price-rules.md
 * @see docs/queues.md (maintenance, retail_price_follow)
 */
@Injectable()
export class RetailPriceFollow {
  private readonly logger = new Logger(RetailPriceFollow.name);

  constructor(
    private readonly db: DbService,
    private readonly pricing: RetailPricing,
    private readonly steps: RetailFollowSteps,
    private readonly priceVersion: CatalogPriceVersion,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs one pass over every following price, then tells staff when it is time to.
   *
   * @returns what the pass did
   * @throws {Error} when Postgres fails outside a service's own transaction (the job is retried; a repeat changes nothing more)
   */
  async run(): Promise<RetailFollowResult> {
    const counts = { checked: 0, candidates: 0, followed: 0, proposed: 0, rewritten: 0 };
    const more = { detached: 0, removed: 0, settled: 0, skipped: 0, failed: 0 };
    let after = 0;
    for (;;) {
      const ids = await followServiceIdsAfter(this.db.db, after, RETAIL_FOLLOW_PAGE);
      if (ids.length === 0) break;
      counts.checked += ids.length;
      for (const serviceId of await this.candidatesOf(ids)) {
        counts.candidates += 1;
        const outcome = await this.followOne(serviceId);
        if (outcome === 'lost') more.skipped += 1;
        else if (outcome === 'failed') more.failed += 1;
        else if (outcome === 'followed' || outcome === 'proposed' || outcome === 'rewritten') counts[outcome] += 1;
        else if (outcome === 'detached' || outcome === 'removed' || outcome === 'settled') more[outcome] += 1;
      }
      after = ids[ids.length - 1]!;
      if (ids.length < RETAIL_FOLLOW_PAGE) break;
    }
    // Before the message: a retry after a failed message finds nothing to write and would never move the version again.
    if (counts.followed > 0) await this.priceVersion.bump();
    return { ...counts, ...more, notified: await this.notifyStaff() };
  }

  /**
   * Finds, with one unlocked read, the services of a page that need a transaction: what the table would do now changes something.
   *
   * Why: plan 31 section 6.4 and risk 13: most passes find nothing, and they must lock nothing then. A figure that cannot be worked out
   * (a supplier's absurd cost, over `numeric(18,4)`) must stay the failure of its one service: the rules are applied one service at a
   * time, and when the page's own read cannot be finished every service of the page goes on to its own transaction.
   */
  private async candidatesOf(ids: readonly number[]): Promise<number[]> {
    try {
      return await this.judgePage(ids);
    } catch (error) {
      if (error instanceof RangeError) return [...ids];
      throw error;
    }
  }

  /** The candidates of a page, from the facts and rules of one set of reads. */
  private async judgePage(ids: readonly number[]): Promise<number[]> {
    const { db } = this.db;
    const facts = await this.pricing.facts(db, ids, this.clock.now());
    const rules = await this.pricing.activeRules(db, [...facts.values()]);
    const followRuleIds = [...facts.values()].flatMap((fact) =>
      fact.follow?.ruleId == null ? [] : [fact.follow.ruleId],
    );
    const followed = await ruleRowsOf(db, followRuleIds);
    const waiting = await waitingProposalsOf(db, ids);
    return ids.filter((id) => {
      const fact = facts.get(id);
      // No live service: its follow row goes.
      if (!fact) return true;
      if (!fact.follow) return false;
      try {
        const rule = fact.follow.ruleId === null ? undefined : followed.get(fact.follow.ruleId);
        const target = priceWithRules(fact, rules);
        const judged = followFactsOf(target, fact.follow, rule ? retailRuleOf(rule) : undefined);
        const proposal = waiting.get(id);
        return followHasWork(decideFollow(judged), judged, proposal ? waitingProposalOf(proposal) : null);
      } catch {
        return true;
      }
    });
  }

  /**
   * Follows one service in its own transaction, under its service row lock (plan 31 section 6.4): the follow row and the proposal are
   * read again under it, and a typed price that arrived meanwhile has no follow row, so nothing is written over it. One service that
   * fails never stops the pass: it is counted and the next pass takes it.
   */
  private async followOne(serviceId: number): Promise<ServiceOutcome> {
    try {
      return await this.db.runInTransaction(async ({ tx }) => {
        const locked = await this.steps.lock(tx, serviceId);
        const state = await this.steps.read(tx, locked);
        return state ? this.steps.carryOut(tx, state) : this.steps.drop(tx, locked);
      });
    } catch (error) {
      const code = pgErrorInfo(error)?.code;
      if (code !== undefined && LOST_RACE_SQLSTATES.has(code)) return 'lost';
      this.logger.error(
        `The retail price of service ${serviceId} could not be followed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
  }

  /**
   * Writes the hourly message when rows wait to be reported and none was reported in the last hour.
   *
   * Why: plan 31 section 6.4: staff get one message with the counts, by email and Telegram, at most once an hour. Marking the rows and
   * writing the notifications are one transaction under one lock, so two passes never send two messages, and a message exists exactly
   * when its rows are marked. A proposal closed before any message was sent is marked and counts for nothing, also for the hour; a
   * channel with no recipient is recorded as a failed notification with the reason (the console list is the notice either way).
   */
  private async notifyStaff(): Promise<boolean> {
    return this.db.runInTransaction(async ({ tx }) => {
      await lockRetailNotice(tx);
      // After the lock: `notified_at` is compared with `resolved_at`, and a pass may have waited here for another one's message.
      const now = this.clock.now();
      if (!(await hasUnnotifiedChange(tx))) return false;
      if (await notifiedSince(tx, new Date(now.getTime() - RETAIL_NOTICE_INTERVAL_MS))) return false;
      const rows = await markChangesNotified(tx, now);
      const changed = rows.filter((row) => row.kind === 'followed').length;
      const waiting = rows.filter((row) => row.kind === 'proposed' && row.resolvedAt === null).length;
      const detached = rows.filter((row) => row.kind === 'detached').length;
      if (changed + waiting + detached === 0) return false;
      const variables = {
        changed: String(changed),
        waiting: String(waiting),
        detached: String(detached),
        // The Shop price rules tab of the Catalog page (decision 060); the console redirects the older `/storefront?tab=pricing` here.
        link: `${this.config.http.consoleBaseUrl}/catalog?view=settings&tab=shop-prices`,
      };
      for (const channel of NOTICE_CHANNELS) {
        await this.notifications.enqueueToAddress(
          { tx },
          {
            event: RETAIL_PRICES_FOLLOWED_EVENT,
            channel,
            to: this.recipientOf(channel),
            noRecipientReason: `No alert recipient is configured for ${channel}.`,
            variables,
            // Per channel: the unique key of notifications covers the dedupe key alone.
            dedupeKey: `retail-follow:${rows[0]!.id}:${channel}`,
          },
        );
      }
      return true;
    });
  }

  /** Where a channel's message goes: the ops recipients of the configuration (one email to all); `undefined` when none is set. */
  private recipientOf(channel: (typeof NOTICE_CHANNELS)[number]): string | undefined {
    if (channel === 'email')
      return this.config.alerts.emailTo.length === 0 ? undefined : this.config.alerts.emailTo.join(',');
    return this.config.alerts.telegramChatId;
  }
}
