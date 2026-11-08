// ClientReferrals: `GET /client/referrals` (stage 11, MISMATCHES B164): the signed-in merchant's referral code and link, its current plan
// and the merchants that signed up with its code, as names and dates only.
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { DbService } from '../../../infra/db';
import type { CommissionPlanKind } from '../db/schema';
import { currentAssignmentOf } from '../infra/assignment.repository';
import { referralSourceOf, referredMerchantsOf } from '../infra/foreign-reads.repository';

/** The most referred merchants the page lists (their count is always exact). */
export const REFERRED_LIST_LIMIT = 100;

/** What the referral page shows. */
export interface ReferralsView {
  readonly referralCode: string;
  /** `<PORTAL_BASE_URL>/register?ref=<code>`. */
  readonly referralLink: string;
  /** The merchant's current plan, or `null` when it is on none. */
  readonly plan: {
    readonly name: string;
    readonly kind: CommissionPlanKind;
    readonly percent: string;
    readonly basis: string;
    readonly period: string;
    readonly startsAt: string;
  } | null;
  readonly referredCount: number;
  /** Newest first, at most {@link REFERRED_LIST_LIMIT}. */
  readonly referred: Array<{ readonly name: string; readonly joinedAt: string }>;
}

/**
 * Builds the referral page of a merchant.
 *
 * Why: B164 (identity-platform-16): the merchant portal has no console screen, so the lead specified it: the code and the link the
 * merchant shares, the plan it is on, and the merchants that registered with its code (a name and a join date each, never an id,
 * order or figure of theirs). The map's "a merchant without a referral code gets one on this read" cannot happen here: the
 * column is `NOT NULL` and every merchant gets its code when it is created, so nothing is generated on read.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class ClientReferrals {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Reads the referral page.
   *
   * @param clientId the signed-in merchant
   * @returns the code, the link, the current plan and the referred merchants
   * @throws {AppError} `UNAUTHORIZED` when the merchant no longer exists
   */
  async of(clientId: number): Promise<ReferralsView> {
    const me = await referralSourceOf(this.db.db, clientId);
    if (!me) throw new AppError('UNAUTHORIZED');
    const [current, referred] = await Promise.all([
      currentAssignmentOf(this.db.db, clientId),
      referredMerchantsOf(this.db.db, clientId, REFERRED_LIST_LIMIT),
    ]);
    return {
      referralCode: me.referralCode,
      referralLink: `${this.config.http.portalBaseUrl}/register?ref=${encodeURIComponent(me.referralCode)}`,
      plan: current
        ? {
            name: current.plan.name,
            kind: current.plan.kind,
            percent: current.plan.percent,
            basis: current.plan.basis,
            period: current.plan.period,
            startsAt: current.assignment.startsAt.toISOString(),
          }
        : null,
      referredCount: referred.total,
      referred: referred.rows.map((row) => ({ name: row.name, joinedAt: row.joinedAt.toISOString() })),
    };
  }
}
