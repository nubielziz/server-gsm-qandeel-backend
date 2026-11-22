// The rules about a supplier's saved API key that need no database: the hint the console shows and where a saved key may be sent
// (decision 051). Pure.

/** The mask every hint starts with: four bullets (U+2022). */
export const KEY_HINT_MASK = '••••';
/** The shortest key whose last characters the hint shows. */
export const KEY_HINT_MIN_LENGTH = 16;
/** How many of the key's last characters a hint shows. */
const KEY_HINT_TAIL = 2;

/**
 * The hint shown for a saved API key.
 *
 * Why: decision 051: a hint never shows the key's beginning (it is copied into lists and audit rows); a short key shows only the mask, so
 * its few characters are not half revealed. The value stays a string: the console reads `null` as "no key saved".
 *
 * @param key the API key
 * @returns the mask, followed by the key's last 2 characters (code points) when the key has at least 16 of them
 */
export function apiKeyHintOf(key: string): string {
  const points = [...key];
  return points.length >= KEY_HINT_MIN_LENGTH ? KEY_HINT_MASK + points.slice(-KEY_HINT_TAIL).join('') : KEY_HINT_MASK;
}

/** The three things a saved key is bound to: where it is sent and as whom. */
export interface KeyBinding {
  readonly baseUrl: string;
  readonly username: string;
  readonly driver: string;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a change moves a saved key to another origin, username or driver.
 *
 * Why: decision 051: a saved key is only sent where it was saved for; moving it needs the key again. A new path on the same origin is not
 * a move. A stored address that does not parse counts as another origin, so an unreadable row never keeps its key through an edit.
 *
 * @param saved the supplier's stored address, username and driver
 * @param change the fields of the edit; a field the edit leaves out is not compared
 * @returns true when the given `baseUrl` has another origin, or the given `username` or `driver` differs
 */
export function keyBindingChanged(saved: KeyBinding, change: Partial<KeyBinding>): boolean {
  if (change.baseUrl !== undefined) {
    const to = originOf(change.baseUrl);
    const from = originOf(saved.baseUrl);
    if (to === null || from === null || to !== from) return true;
  }
  if (change.username !== undefined && change.username !== saved.username) return true;
  return change.driver !== undefined && change.driver !== saved.driver;
}
