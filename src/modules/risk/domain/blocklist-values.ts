// What a blocklist entry holds and how a typed value becomes one (feature 18, /admin/blocklist, RESOLUTIONS b2c-5): the kinds staff may
// add, how each value is normalised, hashed and shown. Pure, no database.
import { type BlocklistKind } from '../db/schema';
import { imeiHashInput } from './imei-check';
import { maskedImei } from './imei-mask';

/** The kinds `POST /admin/blocklist` accepts (the console cannot add a device or a country, ANSWERS risk Q4). */
export const ADDABLE_BLOCKLIST_KINDS = ['email', 'domain', 'imei', 'card'] as const;

/** One value of {@link ADDABLE_BLOCKLIST_KINDS}. */
export type AddableBlocklistKind = (typeof ADDABLE_BLOCKLIST_KINDS)[number];

/** The longest card fingerprint or reason the route stores. */
export const MAX_FINGERPRINT_LENGTH = 200;

/** The longest reason text. */
export const MAX_BLOCK_REASON_LENGTH = 300;

const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A typed value after normalising: the text that is stored hashed, or the sentence that explains why it is refused. */
export type BlockValue =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string };

/**
 * Normalises what staff typed for a blocklist entry.
 *
 * Why: the same person is the same entry whatever the case or spaces they were typed with. An email and a domain are trimmed and
 * lower-case; an IMEI loses spaces and dashes and must be 15 digits (`An IMEI has 15 digits.`, the console's words); a card
 * fingerprint is the gateway's text, trimmed; a country is the upper-case ISO code.
 *
 * @param kind what the value is
 * @param raw the text as typed (or as the system found it)
 * @returns the normalised value, or the message to show under the `value` field
 */
export function normalizeBlockValue(kind: BlocklistKind, raw: string): BlockValue {
  const text = raw.trim();
  if (text === '') return { ok: false, message: 'Enter a value.' };
  switch (kind) {
    case 'email': {
      const email = text.toLowerCase();
      return EMAIL.test(email) ? { ok: true, value: email } : { ok: false, message: 'Enter a valid email address.' };
    }
    case 'domain': {
      const domain = text.toLowerCase().replace(/^@/, '');
      return DOMAIN.test(domain)
        ? { ok: true, value: domain }
        : { ok: false, message: 'Enter a domain such as example.com.' };
    }
    case 'imei': {
      const digits = text.replace(/[\s-]/g, '');
      return /^\d{15}$/.test(digits) ? { ok: true, value: digits } : { ok: false, message: 'An IMEI has 15 digits.' };
    }
    case 'card':
    case 'device':
      return text.length <= MAX_FINGERPRINT_LENGTH
        ? { ok: true, value: text }
        : { ok: false, message: `Use at most ${MAX_FINGERPRINT_LENGTH} characters.` };
    case 'country': {
      const country = text.toUpperCase();
      return /^[A-Z]{2}$/.test(country)
        ? { ok: true, value: country }
        : { ok: false, message: 'Use a two-letter country code.' };
    }
  }
}

/**
 * The text that is hashed to find an entry again.
 *
 * Why: `value_hash` is the keyed hash of decision 019 (`TokenService.hash`). An email is hashed as its normalised text, the recipe
 * the customer routes already use to refuse a blocked email (feature 14b); an IMEI uses the IMEI-check recipe, so an entry matches a
 * stored check; the other kinds sit behind their kind as a prefix.
 *
 * @param kind what the value is
 * @param value the normalised value
 * @returns the text for `TokenService.hash`
 */
export function blockHashInput(kind: BlocklistKind, value: string): string {
  switch (kind) {
    case 'email':
      return value;
    case 'imei':
      return imeiHashInput(value);
    case 'domain':
    case 'card':
    case 'device':
    case 'country':
      return `${kind}:${value}`;
  }
}

/**
 * The form of a value that is safe to show on the blocklist page.
 *
 * Why: the table keeps no readable value, only a hash, so the page shows a masked form made when the entry is added: an email
 * keeps its first two letters (`jt****@tempbox.example`, the demo's mask), an IMEI is grouped as the demo prints it, a card
 * fingerprint is shortened.
 *
 * @param kind what the value is
 * @param value the normalised value
 * @returns the display text
 */
export function blockDisplay(kind: BlocklistKind, value: string): string {
  switch (kind) {
    case 'email':
      return value.replace(/^(.{2}).*(@.*)$/, '$1****$2');
    case 'imei':
      return `${value.slice(0, 2)} ${value.slice(2, 8)} ${value.slice(8, 14)} ${value.slice(14)}`;
    case 'card':
      return `Card fingerprint ${shortened(value)}`;
    case 'device':
      return `Device ${shortened(value)}`;
    case 'domain':
    case 'country':
      return value;
  }
}

function shortened(text: string): string {
  return text.length <= 14 ? text : `${text.slice(0, 6)}…${text.slice(-3)}`;
}

/**
 * The display text of an entry in an audit row or a log line.
 *
 * Why: the blocklist page shows an IMEI in full (the demo does), but an audit row is kept for years and holds no readable IMEI
 * (decision 019): an IMEI entry is named by its TAC and bullets, the same mask an erased IMEI has. The other kinds are already masked
 * or are not personal.
 *
 * @param entry the entry's kind and display text
 * @returns for example `35389011•••••••`, `ja****@tempbox.example`
 */
export function auditBlockDisplay(entry: { readonly kind: BlocklistKind; readonly display: string }): string {
  return entry.kind === 'imei' ? maskedImei(entry.display.replace(/\s/g, '').slice(0, 8)) : entry.display;
}

/**
 * The label of an entry in an audit row (`<kind> <display>`, the demo's form) with {@link auditBlockDisplay}.
 *
 * @param entry the entry's kind and display text
 * @returns for example `imei 35389011•••••••`
 */
export function auditBlockLabel(entry: { readonly kind: BlocklistKind; readonly display: string }): string {
  return `${entry.kind} ${auditBlockDisplay(entry)}`;
}
