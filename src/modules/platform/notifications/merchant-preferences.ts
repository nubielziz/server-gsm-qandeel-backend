// Pure rules of a merchant's notification preferences (platform module, feature 12a, MISMATCHES B165): how
// `clients.notification_prefs` is read, which channels an event uses for a merchant, and how a PUT changes the stored value.
import { Money } from '../../../common/money';
import type { NotificationChannel } from '../db/schema';
import type { NotificationEventDefinition } from './notification-events';

/** The key of the merchant's low-balance threshold in `notification_prefs`; feature 7b's watch reads it by this name. */
export const LOW_BALANCE_THRESHOLD_KEY = 'lowBalanceThreshold';
/** The key that holds the per-event switches. */
export const EVENTS_KEY = 'events';

/** What a merchant chose for one event. */
export interface EventChoice {
  readonly email: boolean;
  readonly telegram: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads what a merchant saved for each event.
 *
 * Why: the column is a free jsonb object (it also holds the threshold), so every read tolerates a missing key, a wrong type and an
 * event that is no longer registered: they read as "never saved".
 *
 * @param prefs `clients.notification_prefs`
 * @returns the saved choices by event key
 */
export function savedChoices(
  prefs: Readonly<Record<string, unknown>> | null | undefined,
): Map<string, Partial<EventChoice>> {
  const choices = new Map<string, Partial<EventChoice>>();
  const events = prefs?.[EVENTS_KEY];
  if (!isRecord(events)) return choices;
  for (const [key, value] of Object.entries(events)) {
    if (!isRecord(value)) continue;
    const choice: { email?: boolean; telegram?: boolean } = {};
    if (typeof value['email'] === 'boolean') choice.email = value['email'];
    if (typeof value['telegram'] === 'boolean') choice.telegram = value['telegram'];
    choices.set(key, choice);
  }
  return choices;
}

/**
 * Tells what a merchant gets for an event: its saved choice, else the event's default.
 *
 * Why: B165: "an event never saved reads as email on, telegram off", except the order results, which the registry keeps off until
 * a merchant opts in (brief 12a). A transactional event ignores the saved choice: it is always sent by email (or Telegram for the
 * bot's own answers).
 *
 * @param definition the event
 * @param prefs `clients.notification_prefs`
 * @returns the effective switches
 */
export function choiceFor(
  definition: NotificationEventDefinition,
  prefs: Readonly<Record<string, unknown>> | null | undefined,
): EventChoice {
  if (definition.transactional) {
    return { email: definition.channels.includes('email'), telegram: definition.channels.includes('telegram') };
  }
  const saved = savedChoices(prefs).get(definition.key);
  return {
    email: definition.channels.includes('email') && (saved?.email ?? definition.defaultEmail),
    telegram: definition.channels.includes('telegram') && (saved?.telegram ?? definition.defaultTelegram),
  };
}

/**
 * Lists the channels an event is sent through for a merchant.
 *
 * Why: a Telegram message needs a linked chat; a merchant who switched Telegram on and later sent `/stop` has none, so the
 * channel is left out instead of creating a row that can only fail.
 *
 * @param definition the event
 * @param prefs `clients.notification_prefs`
 * @param telegramLinked whether the merchant has a linked chat
 * @returns the channels, email first
 */
export function channelsFor(
  definition: NotificationEventDefinition,
  prefs: Readonly<Record<string, unknown>> | null | undefined,
  telegramLinked: boolean,
): NotificationChannel[] {
  const choice = choiceFor(definition, prefs);
  const channels: NotificationChannel[] = [];
  if (choice.email) channels.push('email');
  if (choice.telegram && telegramLinked) channels.push('telegram');
  return channels;
}

const THRESHOLD = /^\d{1,14}(\.\d{1,4})?$/;

/**
 * Reads the low-balance threshold of a merchant for display.
 *
 * @param prefs `clients.notification_prefs`
 * @returns the threshold as a money string with 4 decimals, or `null` when none is set
 */
export function thresholdOf(prefs: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const raw = prefs?.[LOW_BALANCE_THRESHOLD_KEY];
  if (typeof raw !== 'string' || !THRESHOLD.test(raw.trim())) return null;
  return Money.of(raw.trim()).toWire();
}

/**
 * Checks a threshold sent by the portal.
 *
 * Why: B165: `lowBalanceThreshold` is a money amount of zero or more, or `null` for no alert; a negative or malformed amount is a
 * 422 on that field.
 *
 * @param text the amount as sent
 * @returns the money string to store, or `undefined` when the amount is not valid
 */
export function parseThreshold(text: string): string | undefined {
  const trimmed = text.trim();
  return THRESHOLD.test(trimmed) ? Money.of(trimmed).toWire() : undefined;
}

/**
 * Applies a PUT to the stored preferences.
 *
 * Why: B165: the listed events are replaced, the events left out keep their value, and the threshold is set or removed; keys this
 * code does not know stay untouched, so another feature's preference survives a save.
 *
 * @param prefs the stored `notification_prefs`
 * @param change the new threshold (`null` removes it) and the events to replace
 * @returns the new stored object
 */
export function applyPreferences(
  prefs: Readonly<Record<string, unknown>> | null | undefined,
  change: {
    readonly lowBalanceThreshold: string | null;
    readonly events: ReadonlyArray<{ event: string } & EventChoice>;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(prefs ?? {}) };
  if (change.lowBalanceThreshold === null) delete next[LOW_BALANCE_THRESHOLD_KEY];
  else next[LOW_BALANCE_THRESHOLD_KEY] = change.lowBalanceThreshold;
  const events: Record<string, unknown> = isRecord(next[EVENTS_KEY]) ? { ...next[EVENTS_KEY] } : {};
  for (const entry of change.events) events[entry.event] = { email: entry.email, telegram: entry.telegram };
  next[EVENTS_KEY] = events;
  return next;
}

/**
 * Turns every Telegram switch off.
 *
 * Why: B165: `/stop` clears the chat and "turns its telegram events off", so nothing waits for a chat that is gone.
 *
 * @param prefs the stored `notification_prefs`
 * @returns the new stored object
 */
export function withoutTelegram(prefs: Readonly<Record<string, unknown>> | null | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(prefs ?? {}) };
  const events = isRecord(next[EVENTS_KEY]) ? next[EVENTS_KEY] : {};
  const off: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(events)) {
    off[key] = { ...(isRecord(value) ? value : {}), telegram: false };
  }
  next[EVENTS_KEY] = off;
  return next;
}
