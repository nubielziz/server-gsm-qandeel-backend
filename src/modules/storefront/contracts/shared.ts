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
