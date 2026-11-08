// AbandonedCheckoutsService: the use case of `GET /admin/checkouts/abandoned` (feature 19): the list with the consent and recovery verdicts.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { JsonObject, ParsedListQuery } from '../../../common/contract';
import { DbService } from '../../../infra/db';
import { StorefrontServices } from '../../catalog';
import { SettingsReader } from '../../platform';
import { effectiveStatus, maskEmail } from '../domain/checkout';
import {
  ABANDONED_MINUTES_BOUNDS,
  ABANDONED_MINUTES_KEY,
  DEFAULT_ABANDONED_MINUTES,
  recoveryVerdict,
} from '../domain/recovery';
import { type AbandonedSort, type RecoveryRow, listAbandoned } from '../infra/recovery.repository';
import { sessionOf } from './recovery-queue';

/** One abandoned checkout as the console reads it. */
export interface AbandonedCheckoutView {
  readonly id: number;
  readonly email: string;
  readonly grossAmount: string;
  readonly fxRate: string;
  readonly currencyCode: string;
  readonly serviceName: string;
  readonly status: 'open' | 'paid' | 'expired';
  readonly utm: JsonObject;
  readonly createdAt: string;
  readonly recoveryEmailedAt: string | null;
  readonly orderId: number | null;
  readonly marketingConsent: boolean;
  readonly canRecover: boolean;
}

/** The words used when a service is missing (it cannot be: sessions reference services, which are archived, never deleted). */
const UNKNOWN_SERVICE = 'Unknown service';

/**
 * Reads the abandoned checkouts.
 *
 * Why: the console's Checkouts page (RULES checkouts): a server-paged list whose rows carry the consent and recovery verdicts. The rows are judged with the same pure rule the send uses (`recoveryVerdict`), on the injected clock and the
 * `abandonedMinutes` setting, so the flag and the refusal never disagree; the SQL filter `canRecover=true` is its twin.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class AbandonedCheckoutsService {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsReader,
    private readonly services: StorefrontServices,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists one page of abandoned checkouts.
   *
   * @param query the parsed list request
   * @returns the rows and the exact total
   */
  async list(query: ParsedListQuery<AbandonedSort>): Promise<{ rows: AbandonedCheckoutView[]; total: number }> {
    const delayMinutes = await this.settings.integer(
      ABANDONED_MINUTES_KEY,
      DEFAULT_ABANDONED_MINUTES,
      ABANDONED_MINUTES_BOUNDS,
    );
    const now = this.clock.now();
    const { rows, total } = await listAbandoned(this.db.db, query, { now, delayMinutes });
    const names = await this.services.names(this.db.db, [...new Set(rows.map((row) => row.session.serviceId))]);
    return {
      rows: rows.map((row) =>
        this.view(row, names.get(row.session.serviceId)?.name ?? UNKNOWN_SERVICE, now, delayMinutes),
      ),
      total,
    };
  }

  private view(row: RecoveryRow, serviceName: string, now: Date, delayMinutes: number): AbandonedCheckoutView {
    const { session } = row;
    return {
      id: session.id,
      email: maskEmail(session.email),
      grossAmount: session.grossAmount,
      fxRate: session.fxRate,
      currencyCode: session.currency,
      serviceName,
      status: effectiveStatus(session.status, session.expiresAt, now),
      // `jsonb` holds plain JSON; the column type is wider only because Drizzle cannot say more.
      utm: session.utm as JsonObject,
      createdAt: session.createdAt.toISOString(),
      recoveryEmailedAt: session.recoveryEmailedAt?.toISOString() ?? null,
      orderId: session.orderId,
      marketingConsent: row.consent,
      canRecover: recoveryVerdict(sessionOf(row), row.consent, now, delayMinutes) === null,
    };
  }
}
