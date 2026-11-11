// AudiencePreviewService: how many people an audience reaches (feature 23, plan section 5.4). Counts only, never names or addresses;
// used by the preview route and by send and schedule (the confirmed number and the "nobody is reachable" refusal).
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../../common/errors';
import { DbService } from '../../../../infra/db';
import type { NotificationCampaignPurpose } from '../../db/schema';
import { type AudienceSpec, audienceProblems, selectionsOf } from './audience-spec';
import { type AudienceCounts, type CampaignChannel, NO_COUNTS, NotificationAudiences } from './notification-audiences';

/** The answer of the audience preview. */
export interface AudiencePreview {
  readonly total: number;
  readonly reachable: number;
  readonly byType: { staff: number; client: number; customer: number };
  readonly byChannel: { inApp: number; email: number; telegram: number };
  readonly byLocale: { en: number; ar: number };
  readonly excluded: { noConsent: number; optedOut: number; noTelegram: number; noAccount: number };
}

/**
 * Counts audiences.
 *
 * Why: staff see how many people a campaign reaches before they send it (owner list E), and `send` compares that number with the
 * one staff confirmed (S11). The providers of the targeted types run in parallel on the pool, outside any transaction.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class AudiencePreviewService {
  constructor(
    private readonly db: DbService,
    private readonly audiences: NotificationAudiences,
  ) {}

  /**
   * Counts an audience after checking it.
   *
   * @param spec the audience
   * @param channels the channels
   * @param purpose the purpose
   * @returns the counts
   * @throws {AppError} `VALIDATION_FAILED` for an audience that targets nobody, a duplicate person, or Telegram without merchants
   */
  async preview(
    spec: AudienceSpec,
    channels: readonly CampaignChannel[],
    purpose: NotificationCampaignPurpose,
  ): Promise<AudiencePreview> {
    const errors = audienceProblems(spec, channels);
    if (errors.length > 0) throw new AppError('VALIDATION_FAILED', { errors });
    return this.count(spec, channels, purpose);
  }

  /**
   * Counts an audience that was already checked.
   *
   * @param spec the audience
   * @param channels the channels
   * @param purpose the purpose
   * @returns the counts
   */
  async count(
    spec: AudienceSpec,
    channels: readonly CampaignChannel[],
    purpose: NotificationCampaignPurpose,
  ): Promise<AudiencePreview> {
    const selections = selectionsOf(spec);
    const counts = await Promise.all(
      selections.map((selection) =>
        this.audiences.get(selection.type).count(this.db.db, { ...selection, purpose, channels }),
      ),
    );
    const byType = { staff: 0, client: 0, customer: 0 };
    let sum: AudienceCounts = NO_COUNTS;
    selections.forEach((selection, index) => {
      const one = counts[index]!;
      byType[selection.type] = one.reachable;
      sum = {
        total: sum.total + one.total,
        reachable: sum.reachable + one.reachable,
        inApp: sum.inApp + one.inApp,
        email: sum.email + one.email,
        telegram: sum.telegram + one.telegram,
        en: sum.en + one.en,
        ar: sum.ar + one.ar,
        noConsent: sum.noConsent + one.noConsent,
      };
    });
    const chosen = (channel: CampaignChannel, value: number) => (channels.includes(channel) ? value : 0);
    return {
      total: sum.total,
      reachable: sum.reachable,
      byType,
      byChannel: {
        inApp: chosen('in_app', sum.inApp),
        email: chosen('email', sum.email),
        telegram: chosen('telegram', sum.telegram),
      },
      byLocale: { en: sum.en, ar: sum.ar },
      excluded: {
        noConsent: sum.noConsent,
        optedOut: chosen('email', sum.total - sum.email),
        noTelegram: chosen('telegram', sum.total - sum.telegram),
        noAccount: chosen('in_app', sum.total - sum.inApp),
      },
    };
  }
}
