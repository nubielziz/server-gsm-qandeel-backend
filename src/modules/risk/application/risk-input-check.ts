// RiskInputCheck: names at API boot every switched-on risk rule and every signal whose input this installation cannot supply (decision 050).
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { type InputGap, inputSourcesOf, rulesWithoutInput } from '../domain/risk-inputs';
import { RiskRules } from './risk-rules.service';

/**
 * Warns at boot about risk rules that have no input.
 *
 * Why: decision 050: a rule that is switched on but has no input never applies; the operator must not believe it protects the shop. The
 * rules routes keep their shape, so the boot log is where the gap is said (the risk module's README lists the same inputs). Only the API
 * loads this (the worker does not serve checkouts).
 *
 * Side effects: reads `settings` once at boot; log lines only (never an error's text: it could hold statement values; never stops the boot).
 */
@Injectable()
export class RiskInputCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(RiskInputCheck.name);

  constructor(
    private readonly rules: RiskRules,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Lists the rules and signals that have no input source now.
   *
   * @returns the gaps, the rules first and then the signals without a switch
   */
  async gaps(): Promise<InputGap[]> {
    return rulesWithoutInput(await this.rules.load(), inputSourcesOf(this.config.http.geoipCountryHeader));
  }

  /** Logs one warning per gap; a failed read logs one fixed sentence and the boot goes on. */
  async onApplicationBootstrap(): Promise<void> {
    let gaps: InputGap[];
    try {
      gaps = await this.gaps();
    } catch {
      this.logger.warn('The risk rules could not be read at boot, so their inputs were not checked.');
      return;
    }
    for (const gap of gaps) this.logger.warn(`Risk rule without an input source: ${gap.label}. ${gap.reason}`);
  }
}
