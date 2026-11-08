// MerchantNotificationSettings: the use cases behind `GET|PUT /client/notification-preferences` (feature 12a, MISMATCHES B165): what a
// merchant is told about, by which channel, and the wallet level that raises a low-balance alert.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError, type FieldError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { NotificationEventRegistry, applyPreferences, choiceFor, parseThreshold, thresholdOf } from '../../platform';
import { findClientById } from '../infra/merchant-auth.repository';
import { lockClient, saveNotificationPrefs } from '../infra/merchant-notification.repository';
import type { Client } from '../db/schema';

/** What the portal's preferences screen shows. */
export interface PreferencesView {
  readonly email: { readonly address: string };
  readonly telegram: { readonly linked: boolean };
  /** The wallet level that raises `wallet.low_balance`, a money string, or `null` for no alert. */
  readonly lowBalanceThreshold: string | null;
  /** Every event a merchant may switch, with its two switches. */
  readonly events: Array<{
    readonly event: string;
    readonly label: string;
    readonly email: boolean;
    readonly telegram: boolean;
  }>;
}

/** The body of a save, as the contract parses it. */
export interface PreferencesInput {
  /** A money amount of zero or more; `null` removes the alert; left out keeps it. */
  readonly lowBalanceThreshold?: string | null | undefined;
  /** The events to replace; the ones left out keep their value. */
  readonly events: ReadonlyArray<{ readonly event: string; readonly email: boolean; readonly telegram: boolean }>;
}

const MAX_EVENTS = 50;

/**
 * Reads and saves a merchant's notification preferences.
 *
 * Why: B165. The choices live in `clients.notification_prefs` (the key `lowBalanceThreshold` is the one `WalletLowBalanceWatch` reads);
 * the events a merchant may switch are the non-transactional merchant events of the platform's registry, so the screen and the delivery
 * agree. An event never saved reads as email on and Telegram off (the order results stay off until chosen); Telegram can be switched on
 * only while a chat is linked. The merchant portal writes no audit rows (B121).
 *
 * Side effects: `update` rewrites `clients.notification_prefs` under a row lock.
 *
 * @see docs/contract/MISMATCHES.md (B165)
 */
@Injectable()
export class MerchantNotificationSettings {
  constructor(
    private readonly db: DbService,
    private readonly registry: NotificationEventRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads the preferences of a merchant.
   *
   * @param clientId the signed-in merchant
   * @returns the screen's data
   * @throws {AppError} `NOT_FOUND` when the merchant row is gone
   */
  async get(clientId: number): Promise<PreferencesView> {
    const client = await findClientById(this.db.db, clientId);
    if (!client) throw new AppError('NOT_FOUND', { detail: 'This account no longer exists.' });
    return this.view(client, client.notificationPrefs);
  }

  /**
   * Saves the preferences.
   *
   * @param clientId the signed-in merchant
   * @param input the threshold and the events to replace
   * @returns the preferences after the save
   * @throws {AppError} `VALIDATION_FAILED` on `events.<n>.event` for an unknown, transactional or repeated event, on `events.<n>.telegram`
   *   for Telegram switched on with no chat linked ("Link Telegram first."), and on `lowBalanceThreshold` for a negative or malformed amount
   */
  async update(clientId: number, input: PreferencesInput): Promise<PreferencesView> {
    const errors: FieldError[] = [];
    let threshold: string | null | undefined;
    if (input.lowBalanceThreshold !== undefined && input.lowBalanceThreshold !== null) {
      threshold = parseThreshold(input.lowBalanceThreshold);
      if (threshold === undefined) {
        errors.push({
          field: 'lowBalanceThreshold',
          code: 'invalid',
          message: 'Enter an amount of zero or more with up to four decimals, like 50 or 12.50.',
        });
      }
    } else {
      threshold = input.lowBalanceThreshold;
    }
    if (input.events.length > MAX_EVENTS) {
      errors.push({ field: 'events', code: 'too_many', message: `Send at most ${MAX_EVENTS} events.` });
    }

    return this.db.runInTransaction(async ({ tx }) => {
      const client = await lockClient(tx, clientId);
      if (!client) throw new AppError('NOT_FOUND', { detail: 'This account no longer exists.' });
      const allowed = new Set(this.registry.merchantPreferenceEvents().map((definition) => definition.key));
      const seen = new Set<string>();
      input.events.forEach((entry, index) => {
        if (!allowed.has(entry.event)) {
          errors.push({
            field: `events.${index}.event`,
            code: 'unknown_event',
            message: `${entry.event} is not an event you can switch on or off.`,
          });
        } else if (seen.has(entry.event)) {
          errors.push({
            field: `events.${index}.event`,
            code: 'duplicate',
            message: `${entry.event} is listed twice.`,
          });
        }
        seen.add(entry.event);
        if (entry.telegram && client.telegramChatId === null) {
          errors.push({
            field: `events.${index}.telegram`,
            code: 'telegram_not_linked',
            message: 'Link Telegram first.',
          });
        }
      });
      if (errors.length > 0) throw new AppError('VALIDATION_FAILED', { errors });

      const prefs = applyPreferences(client.notificationPrefs, {
        lowBalanceThreshold: threshold === undefined ? thresholdOf(client.notificationPrefs) : threshold,
        events: input.events,
      });
      await saveNotificationPrefs(tx, clientId, prefs, this.clock.now());
      return this.view(client, prefs);
    });
  }

  /** The screen's data for a merchant with these stored preferences. */
  private view(client: Client, prefs: Record<string, unknown>): PreferencesView {
    return {
      email: { address: client.email },
      telegram: { linked: client.telegramChatId !== null },
      lowBalanceThreshold: thresholdOf(prefs),
      events: this.registry.merchantPreferenceEvents().map((definition) => ({
        event: definition.key,
        label: definition.label,
        ...choiceFor(definition, prefs),
      })),
    };
  }
}
