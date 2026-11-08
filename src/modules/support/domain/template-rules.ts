// Rules of the reply templates (support module, RESOLUTIONS b2c-9, RULES support 7): the shortcut. Pure.
/** The language codes a template may be written in (ANSWERS support Q5). */
export const TEMPLATE_LOCALES = ['en', 'ar'] as const;

/** A shortcut is a slash and one to 39 characters with no space, like `/refund`. */
const SHORTCUT = /^\/\S{1,39}$/;

/**
 * Tells whether a (trimmed) shortcut is well formed.
 *
 * Why: RULES support 7: a shortcut is `''` or starts with a slash (`templateForm.ts`); the composer expands it as one word, so it has no
 * spaces.
 *
 * @param shortcut the trimmed shortcut; `''` means none
 * @returns true for `''` and for `/word`
 */
export function isValidShortcut(shortcut: string): boolean {
  return shortcut === '' || SHORTCUT.test(shortcut);
}

/**
 * Turns the shortcut of the wire into what is stored.
 *
 * Why: RESOLUTIONS b2c-9: the column keeps NULL for "none" so the unique index on `lower(shortcut)` never sees two empty strings;
 * the wire says `''` (the console's type is a plain string).
 *
 * @param shortcut the shortcut as sent
 * @returns the trimmed shortcut, or `null` when it is empty
 */
export function shortcutToStored(shortcut: string): string | null {
  const trimmed = shortcut.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Turns the stored shortcut into the wire word.
 *
 * @param stored the column value
 * @returns the shortcut, `''` when there is none
 */
export function shortcutToWire(stored: string | null): string {
  return stored ?? '';
}
