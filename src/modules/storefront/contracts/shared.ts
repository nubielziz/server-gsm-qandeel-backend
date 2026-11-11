// Field schemas the storefront content contracts share (feature 15): the two languages, titles, slugs and Markdown bodies.
// Shapes follow the console's types (frontend src/features/storefront/types); limits are the server's own.
import { z } from 'zod';
import { STOREFRONT_LOCALES, type StorefrontLocale } from '../domain/locales';

/**
 * A language of the storefront on the wire.
 *
 * Why: the console types `locale` as a plain string, so the schema is a string checked against `en` and `ar` (an enum would
 * fail the shape parity test in the request direction).
 */
export const LocaleField = z
  .string()
  .trim()
  .refine((value): value is StorefrontLocale => (STOREFRONT_LOCALES as readonly string[]).includes(value), {
    error: 'Choose a language: en or ar.',
  })
  .meta({ description: 'The language: `en` or `ar`.', examples: ['en'] });

/**
 * A title, trimmed, 1 to 200 characters.
 *
 * @param empty the message for an empty title
 * @returns the field schema
 */
export const titleField = (empty: string) => z.string().trim().min(1, empty).max(200, 'Use at most 200 characters.');

/** A slug as typed: trimmed; its form is checked by the use case (`chooseSlug`) so the answer can name the field. */
export const SlugField = z.string().trim().max(120, 'Use at most 120 characters.');

/** An SEO title: trimmed, up to 200 characters, empty clears it. */
export const SeoTitleField = z.string().trim().max(200, 'Use at most 200 characters.');

/** An SEO description: trimmed, up to 400 characters, empty clears it. */
export const SeoDescriptionField = z.string().trim().max(400, 'Use at most 400 characters.');

/**
 * One line of text: trimmed, no control characters (a new line, a tab), at most `max` characters; empty clears it.
 *
 * @param max the most characters accepted
 * @returns the field schema
 */
export const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    // eslint-disable-next-line no-control-regex -- the point of the rule is to refuse control characters
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { error: 'Use one line, without line breaks or tabs.' });

/** A country on a listing: empty, or two letters (stored upper case). */
export const ListingCountryField = z
  .string()
  .trim()
  .regex(/^([A-Za-z]{2})?$/, 'Use a two-letter country code like GB, or leave it empty.')
  .transform((value) => value.toUpperCase());

/** The position of a listing in the shop's own order: a whole number from 0 to 1 000 000. */
export const ListingSortField = z.number().int('Enter a whole number.').min(0, 'Enter 0 or more.').max(1_000_000);

/**
 * Markdown exactly as typed (spaces and new lines kept); HTML inside is stored as sent.
 *
 * @param max the most characters accepted
 * @returns the field schema
 */
export const markdown = (max: number) => z.string().max(max, `Use at most ${max} characters.`);

/**
 * Markdown that may not be blank (a help answer, a legal text).
 *
 * @param max the most characters accepted
 * @param empty the message for a blank text
 * @returns the field schema
 */
export const requiredMarkdown = (max: number, empty: string) =>
  markdown(max).refine((value) => value.trim() !== '', { error: empty });

/** The largest page or legal body, in characters. */
export const BODY_MAX = 200_000;

/** The largest help answer, in characters. */
export const ANSWER_MAX = 50_000;

export { STOREFRONT_LOCALES };
