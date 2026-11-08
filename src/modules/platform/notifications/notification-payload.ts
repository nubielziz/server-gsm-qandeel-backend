// Reads the parts of a notification's payload that code depends on (platform module, feature 12a): the placeholder values and the digest
// items. The column is free jsonb, so every read checks the types and drops what does not fit.
import type { DigestItem } from './digest-rules';
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
