// The rules of the legal documents (feature 15, b2c-14): the type words, their names, the public slug of each type, the version
// text, and which versions can be published. Pure functions.
import { LEGAL_DOCUMENT_TYPES, type LegalDocumentType } from '../db/schema';

/** The names of the four document types, as the console and the audit labels print them (RESOLUTIONS b2c-14). */
export const LEGAL_TYPE_LABEL: Readonly<Record<LegalDocumentType, string>> = {
  terms: 'Terms of service',
  privacy: 'Privacy policy',
  refund: 'Refund policy',
  cookies: 'Cookie policy',
};

/** The longest version text. */
export const LEGAL_VERSION_MAX_LENGTH = 32;

/** A version text: letters, digits, dots, hyphens and underscores, such as `3.2` or `2026-01`. */
export const LEGAL_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/**
 * Reads a public page slug as a legal document type.
 *
 * Why: `GET /store/v1/pages/:slug` serves the current legal documents next to the content pages; the slug of a legal page
 * is its type word (`terms`, `privacy`, `refund`, `cookies`), which no content page may use.
 *
 * @param slug the slug of the request
 * @returns the type, or `undefined` when the slug is not a type word
 */
export function legalTypeOfSlug(slug: string): LegalDocumentType | undefined {
  return (LEGAL_DOCUMENT_TYPES as readonly string[]).includes(slug) ? (slug as LegalDocumentType) : undefined;
}

/**
 * Tells whether a content page may not use a slug because a legal document does.
 *
 * @param slug the slug staff chose
 * @returns true for the four type words
 */
export function isReservedSlug(slug: string): boolean {
  return legalTypeOfSlug(slug) !== undefined;
}

/** Where a version stands. */
export type LegalState = 'draft' | 'current' | 'earlier';

/**
 * Tells where a legal version stands: a draft was never published, the current one is in force, an earlier one was in
 * force and has been replaced.
 *
 * Why: the console groups the versions the same way (`lib/legal.ts`): current = `isCurrent`; draft = not current and no
 * `effectiveFrom`; earlier = not current with `effectiveFrom` set.
 *
 * @param version the two columns that decide
 * @returns the state
 */
export function legalState(version: { isCurrent: boolean; effectiveFrom: Date | null }): LegalState {
  if (version.isCurrent) return 'current';
  return version.effectiveFrom === null ? 'draft' : 'earlier';
}

/**
 * Names a version for the audit log: `Terms of service (EN) 3.2`.
 *
 * Why: the demo logs `type (LANG) version` as the label of a legal document entry.
 *
 * @param version the type, language and version text
 * @returns the label
 */
export function legalLabel(version: { type: LegalDocumentType; locale: string; version: string }): string {
  return `${LEGAL_TYPE_LABEL[version.type]} (${version.locale.toUpperCase()}) ${version.version}`;
}
