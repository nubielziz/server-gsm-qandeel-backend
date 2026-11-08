// Reads the parts of a notification's payload that code depends on (platform module, feature 12a): the placeholder values and the digest
// items. The column is free jsonb, so every read checks the types and drops what does not fit.
import type { DigestItem } from './digest-rules';
import type { Recipient } from './notification-foreign-reads';
import type { NotificationPayload } from './notification.repository';

/**
 * Tells whether a value is a string.
 *
 * @param value anything
 * @returns true for a string
 */
export const asString = (value: unknown): value is string => typeof value === 'string';

/**
 * Reads the placeholder values of a payload.
 *
 * @param payload the stored payload
 * @returns name to value, string values only
 */
export function variablesOf(payload: NotificationPayload): Record<string, string> {
  const raw = payload.variables;
  const variables: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) if (asString(value)) variables[name] = value;
  }
  return variables;
}

/**
 * Reads the digest items of a payload, dropping anything that is not an item.
 *
 * @param payload the stored payload
 * @returns the items in order
 */
export function itemsOf(payload: NotificationPayload): DigestItem[] {
  const items: DigestItem[] = [];
  for (const raw of payload.items ?? []) {
    const item = raw as Partial<DigestItem> | null;
    if (
      item &&
      typeof item.eventId === 'number' &&
      typeof item.serviceId === 'number' &&
      asString(item.serviceName) &&
      asString(item.price) &&
      asString(item.currency)
    ) {
      items.push({
        eventId: item.eventId,
        serviceId: item.serviceId,
        serviceName: item.serviceName,
        previousPrice: asString(item.previousPrice) ? item.previousPrice : null,
        price: item.price,
        currency: item.currency,
      });
    }
  }
  return items;
}

/**
 * The `recipient_id` of a message that goes to the ops address or chat named by configuration, not to a person's row.
 *
 * Why: feature 12b: the messages of alerts have no staff member to point at, and `recipient_id` is not null. No `staff_users` row has id 0, so the
 * pair (`staff`, 0) names "operations" and the address or chat travels in the payload (`to`, `chatId`).
 */
export const OPERATIONS_RECIPIENT_ID = 0;

/**
 * The recipient of an operations message, built from its payload.
 *
 * @param payload the stored payload (`to` holds the addresses of an email)
 * @returns a staff-audience recipient with the addresses as its `email`, no linked chat (the chat is the payload's `chatId`) and no suspension
 */
export function operationsRecipientOf(payload: NotificationPayload): Recipient {
  return {
    type: 'staff',
    id: OPERATIONS_RECIPIENT_ID,
    audience: 'staff',
    name: 'Operations',
    email: asString(payload.to) ? payload.to : '',
    locale: 'en',
    telegramChatId: null,
    prefs: {},
    suspended: false,
  };
}
