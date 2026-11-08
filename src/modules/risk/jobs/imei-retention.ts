// ImeiRetention: erases the IMEI of old IMEI checks (feature 18, the `data_retention` job, RESOLUTIONS b2c-4): the same erasure as the
// anonymization of a customer, applied by age.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { SettingsReader } from '../../platform';
import { eraseChecksOlderThan } from '../infra/imei-check-admin.repository';

/** The setting that says how many days an IMEI is kept (RULES settings; the privacy panel edits it). */
export const IMEI_RETENTION_KEY = 'imeiRetentionDays';

/** The retention of a shop that never saved the setting: the demo's 180 days. */
export const DEFAULT_IMEI_RETENTION_DAYS = 180;

/** The longest retention the setting accepts: ten years. */
export const MAX_IMEI_RETENTION_DAYS = 3650;

/** How many checks one batch erases. */
export const RETENTION_BATCH = 1000;

/** The most batches one run does; a larger backlog continues the next night. */
export const RETENTION_MAX_BATCHES = 50;

/** What a run did. */
export interface RetentionOutcome {
  /** The retention in force, in days. */
  readonly days: number;
  /** How many checks lost their IMEI in this run. */
  readonly erased: number;
}

/**
 * Applies the IMEI retention period.
 *
 * Why: the privacy promise of the storefront ("How long do you keep my IMEI?"): the IMEI of a check is kept for
 * `imeiRetentionDays` (0 means do not keep it), then `imei_enc`, `imei_hash` and `cached_until` are set to NULL together, which
 * stops the row matching a lookup. The brand, model, result and the staff log row stay; the console then shows the TAC and
 * bullets. The cutoff comes from the injected clock; the update is by id in batches, so a repeat or a parallel run only finds
 * fewer rows (a row that is erased cannot be erased twice).
 *
 * Side effects: updates `imei_checks`.
 */
@Injectable()
export class ImeiRetention {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Erases the checks that are past the retention period.
   *
   * @returns the retention in force and how many checks were erased
   */
  async run(): Promise<RetentionOutcome> {
    const days = await this.settings.integer(IMEI_RETENTION_KEY, DEFAULT_IMEI_RETENTION_DAYS, {
      min: 0,
      max: MAX_IMEI_RETENTION_DAYS,
    });
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    let erased = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
      const done = await eraseChecksOlderThan(this.db.db, cutoff, now, RETENTION_BATCH);
      erased += done;
      if (done < RETENTION_BATCH) break;
    }
    return { days, erased };
  }
}
