// StorefrontPolicies: the storefront switches staff set in Settings (guest checkout, the withdrawal waiver, the IMEI pre-check).
// They live as flat keys of the settings table (RULES settings 3); feature 16 builds the route that writes them.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { SettingsService } from '../../platform';

/** The switches the storefront reads. */
export interface StorefrontPolicySwitches {
  /** Off means an account is required at checkout. */
  readonly guestCheckout: boolean;
  /** On means a checkout records the waiver of the withdrawal right, and a session is not complete without it. */
  readonly withdrawalWaiver: boolean;
  /** On means the IMEI is checked before payment. */
  readonly imeiPrecheck: boolean;
}

/** Every switch is on until staff turn it off (the demo's defaults). */
export const DEFAULT_POLICY_SWITCHES: StorefrontPolicySwitches = {
  guestCheckout: true,
  withdrawalWaiver: true,
  imeiPrecheck: true,
};

/**
 * Reads the storefront policy switches.
 *
 * Why: RULES settings 5: `guestCheckout` off makes an account required, `withdrawalWaiver` makes checkout record the waiver
 * consent, `imeiPrecheck` turns the pre-payment IMEI check on. A key that was never set, or holds anything but `true` or
 * `false`, means the default (on): the shop keeps selling when a setting row is missing or damaged.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class StorefrontPolicies {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Reads the three switches.
   *
   * @param db the database or a transaction to read with
   * @returns the switches, defaults filled in
   */
  async switches(db: DbExecutor): Promise<StorefrontPolicySwitches> {
    const read = async (key: keyof StorefrontPolicySwitches): Promise<boolean> => {
      const value = await this.settings.get(key, db);
      return typeof value === 'boolean' ? value : DEFAULT_POLICY_SWITCHES[key];
    };
    return {
      guestCheckout: await read('guestCheckout'),
      withdrawalWaiver: await read('withdrawalWaiver'),
      imeiPrecheck: await read('imeiPrecheck'),
    };
  }
}
