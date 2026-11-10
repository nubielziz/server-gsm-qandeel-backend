// Removes personal data from an error event before it leaves the process (decision 015, feature 24D). Pure and unit-tested.
import { maskEmail, maskImei } from '../logging/mask';

/** Longest exception message or value that is sent; a longer one is cut (messages can embed a whole SQL statement). */
const MAX_TEXT_LENGTH = 1000;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** 12 to 19 digits, in one run or in groups separated by single spaces or dashes: an IMEI, a card number, an account number. */
const DIGIT_RUN_PATTERN = /\b\d(?:[ -]?\d){11,18}\b/g;

/**
 * Masks e-mail addresses and long digit runs in a piece of text.
 *
 * Why: exception messages can quote the data a request carried (a unique-violation detail names the e-mail, a failed lookup
 * names the IMEI); decision 012 keeps both out of logs and this keeps them out of Sentry. The masks are those of the log
 * serializers: `r***@domain` and the last four digits.
 *
 * @param text any message
 * @returns the text with addresses and 12 to 19 digit runs masked, cut to 1000 characters
 */
export function scrubText(text: string): string {
  const masked = text
    .replace(EMAIL_PATTERN, (address) => maskEmail(address))
    .replace(DIGIT_RUN_PATTERN, (digits) => maskImei(digits));
  return masked.length > MAX_TEXT_LENGTH ? `${masked.slice(0, MAX_TEXT_LENGTH)}...` : masked;
}

/** The parts of an SDK event this module touches; the SDK's own event type is assignable to it. */
export interface ScrubbableEvent {
  message?: string;
  request?: unknown;
  user?: unknown;
  breadcrumbs?: unknown;
  extra?: unknown;
  server_name?: string;
  modules?: unknown;
  exception?: { values?: { type?: string; value?: string }[] };
  logentry?: { message?: string; params?: unknown };
  contexts?: Record<string, unknown>;
}

/** Contexts that describe the runtime, not the request or the person; everything else is dropped. */
const KEPT_CONTEXTS = new Set(['runtime', 'trace']);

/**
 * Cleans an event for `beforeSend`: no request, user, breadcrumbs, extra data, host name or module list, masked messages.
 *
 * Why: the owner turns Sentry on to learn which code failed (stack, route, request id), never to receive customers' data.
 * The tags the reporter sets (process, surface, route, method, code, request id, queue, job) and the stack stay.
 *
 * @param event the event the SDK built
 * @returns the same object, cleaned (the SDK sends what is returned)
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.server_name;
  delete event.modules;
  if (event.message !== undefined) event.message = scrubText(event.message);
  if (event.logentry) {
    delete event.logentry.params;
    if (event.logentry.message !== undefined) event.logentry.message = scrubText(event.logentry.message);
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) exception.value = scrubText(exception.value);
  }
  if (event.contexts) {
    for (const name of Object.keys(event.contexts)) {
      if (!KEPT_CONTEXTS.has(name)) delete event.contexts[name];
    }
  }
  return event;
}
