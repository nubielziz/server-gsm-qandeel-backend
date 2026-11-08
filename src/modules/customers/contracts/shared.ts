// Field schemas the customers routes share (store and admin): the customer's email, name, country and locale as they are cleaned
// on the way in, and the closed vocabularies of the wire (docs/contract/endpoints/customers.md).
import { z } from 'zod';
import { CUSTOMER_STATUSES, RISK_LEVELS } from '../db/schema';
import {
  CUSTOMER_LOCALES,
  type CustomerLocale,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PHONE_LENGTH,
  MIN_NAME_LENGTH,
  cleanName,
} from '../domain/customer-input';

/** The status words of a customer on the wire. */
export const CustomerStatusWire = z.enum(CUSTOMER_STATUSES);

/** The risk words of a customer on the wire. */
export const RiskLevelWire = z.enum(RISK_LEVELS);

/** An email: trimmed, lower-cased and shaped like an address (the account email is case-insensitive). */
export const EmailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address.' }).max(254, 'This email address is too long.'));

/** A customer name: tidied (inner spaces collapsed), 2 to 120 characters. */
export const NameField = z
  .string()
  .transform(cleanName)
  .pipe(
    z
      .string()
      .min(MIN_NAME_LENGTH, 'Enter the customer’s name.')
      .max(MAX_NAME_LENGTH, `Use at most ${MAX_NAME_LENGTH} characters.`),
  );

/** An ISO 3166 alpha-2 country, written in upper case on the way in. */
export const CountryField = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Choose a country.')
  .toUpperCase();

/**
 * The customer's language: `en` or `ar`, typed as a plain string like the console's body type (`locale: string`).
 *
 * Why: the contract tests compare the request with the console's type, and a narrower enum would differ from it; the check is a
 * refinement, so a wrong value is still `422` on `locale`.
 */
export const LocaleField = z
  .string()
  .trim()
  .refine((value): value is CustomerLocale => (CUSTOMER_LOCALES as readonly string[]).includes(value), {
    error: 'Choose English or Arabic.',
  })
  .describe('`en` or `ar`.');

/** A phone number: trimmed, at most 40 characters, empty for none. */
export const PhoneField = z.string().trim().max(MAX_PHONE_LENGTH, `Use at most ${MAX_PHONE_LENGTH} characters.`);

/** The internal note: at most 300 characters. */
export const NotesField = z.string().trim().max(MAX_NOTES_LENGTH, `Use at most ${MAX_NOTES_LENGTH} characters.`);

/** How a customer gets a password: an emailed link to choose one, or a temporary one the server makes. */
export const PasswordModeField = z.enum(['reset_link', 'temporary_password'], {
  error: 'Choose how they get a password.',
});
