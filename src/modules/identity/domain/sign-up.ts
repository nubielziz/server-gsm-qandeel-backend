// The rules of a shop sign-up with details (decision 079): the names, the phone and the full name the account gets, and the pure part of the
// decision the exchange of the link takes (apply the form, keep it pending for its owner, or drop it). Pure functions, unit-tested; the shop's
// route contracts (the sign-up and its finish) apply the field rules through `ports/sign-up-fields.ts`, and the link service applies the
// decision.

/** The most characters a first or a last name may have once trimmed (the owner's order of 2026-11-27). */
export const SIGN_UP_NAME_MAX_LENGTH = 60;

/**
 * The most characters the account's name may have: first name, one space, last name.
 *
 * Why: the review of decision 079 (S4): two names of 60 make 121, one more than the account name takes everywhere else (`MAX_NAME_LENGTH`
 * of the staff create and edit and of `PATCH /store/v1/me`, counted as that check counts: UTF-16 code units), so a name the sign-up made
 * could not be saved again unchanged.
 */
export const SIGN_UP_FULL_NAME_MAX_LENGTH = 120;

/** The fewest and the most digits of a phone number (E.164 allows 15; 7 is the shortest national number the shop accepts). */
export const SIGN_UP_PHONE_DIGITS = { min: 7, max: 15 } as const;

/**
 * The characters a typed phone number may carry for readability, removed before it is judged and stored: spaces (Unicode space separators,
 * not tabs or line breaks), dashes, dots, brackets.
 */
const PHONE_SEPARATORS = /[\p{Zs}.()\p{Pd}]/gu;

/** A cleaned phone number: an optional leading `+` and 7 to 15 ASCII digits. */
const PHONE_SHAPE = new RegExp(`^\\+?[0-9]{${SIGN_UP_PHONE_DIGITS.min},${SIGN_UP_PHONE_DIGITS.max}}$`);

/**
 * The characters no name or phone may hold: the control characters (Unicode category Cc: U+0000-U+001F and U+007F-U+009F), the line and
 * paragraph separators (U+2028, U+2029) and the invisible direction marks and overrides (U+061C, U+200E, U+200F, U+202A-U+202E,
 * U+2066-U+2069).
 *
 * Why: a line break or a tab breaks the mails and the CSV exports that print the name, and U+2028 and U+2029 are line breaks to many
 * readers; a direction mark or override makes the name read as something else in the console and the mails (the review of decision 079,
 * S4, and its re-review: U+061C, the Arabic letter mark, is one too). Arabic letters are data and stay.
 */
const HIDDEN = /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/** The sentence for a name or a phone that holds one of the {@link HIDDEN} characters. */
const HIDDEN_PROBLEM = 'Remove the line breaks, tabs and invisible characters.';

/**
 * The oldest a session may be for the finish of a sign-up to set the first password: 60 minutes.
 *
 * Why: the re-review of decision 079. An account without a password can only have been signed in by a link, so a session opened at most
 * an hour ago means its holder proved the mailbox minutes ago; an older one (a session left open on a shared computer, an older account
 * made by a link) must not be able to choose the account's password: its holder asks for a new sign-in link first.
 */
export const SIGN_UP_FINISH_SESSION_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Tells whether a session is young enough for the finish of a sign-up (see {@link SIGN_UP_FINISH_SESSION_MAX_AGE_MS}).
 *
 * @param openedAtMs when the session was opened, in milliseconds
 * @param nowMs the time of the injected clock, in milliseconds
 * @returns true when the session was opened at most 60 minutes ago
 */
export function signUpFinishSessionFresh(openedAtMs: number, nowMs: number): boolean {
  return nowMs - openedAtMs <= SIGN_UP_FINISH_SESSION_MAX_AGE_MS;
}

/** Which name a sentence is about: the first or the last one. */
export type SignUpNamePart = 'first' | 'last';

/**
 * Tidies a typed name: trimmed, nothing else (inner spaces, case and script stay as typed: an Arabic name is data).
 *
 * @param name the name as typed
 * @returns the trimmed name
 */
export function cleanSignUpName(name: string): string {
  return name.trim();
}

/**
 * Judges a trimmed first or last name.
 *
 * Why: decision 079: each name is required, 1 to 60 characters (counted as Unicode code points, so a letter outside the Basic Multilingual
 * Plane counts once), with no control character and no invisible direction mark (see {@link HIDDEN}).
 *
 * @param name the trimmed name
 * @param part which name it is, for the sentence
 * @returns the sentence for the form field, or `undefined` when the name is acceptable
 */
export function signUpNameProblem(name: string, part: SignUpNamePart): string | undefined {
  const length = Array.from(name).length;
  if (length === 0) return part === 'first' ? 'Enter your first name.' : 'Enter your last name.';
  if (length > SIGN_UP_NAME_MAX_LENGTH) return `Use at most ${SIGN_UP_NAME_MAX_LENGTH} characters.`;
  if (HIDDEN.test(name)) return HIDDEN_PROBLEM;
  return undefined;
}

/**
 * Judges the two names together: the account's name (first, a space, last) must fit the account name's limit.
 *
 * Why: the review of decision 079 (S4): see {@link SIGN_UP_FULL_NAME_MAX_LENGTH}. The sentence belongs to the last name, the one to shorten.
 *
 * @param firstName the trimmed first name
 * @param lastName the trimmed last name
 * @returns the sentence for the `lastName` field, or `undefined` when the joined name fits
 */
export function signUpFullNameProblem(firstName: string, lastName: string): string | undefined {
  if (signUpFullName(firstName, lastName).length <= SIGN_UP_FULL_NAME_MAX_LENGTH) return undefined;
  return `Your first and last name together can have at most ${SIGN_UP_FULL_NAME_MAX_LENGTH - 1} characters.`;
}

/**
 * Cleans a typed phone number: the spaces, dashes, dots and brackets people type for readability are removed.
 *
 * Why: decision 079: the number is stored in this cleaned form, so the same number typed two ways is one value. Tabs, line breaks and the
 * invisible marks are not separators: they stay, and {@link signUpPhoneProblem} refuses them.
 *
 * @param phone the phone number as typed
 * @returns the number without its separators (not yet judged: see {@link signUpPhoneProblem})
 */
export function cleanSignUpPhone(phone: string): string {
  return phone.replace(PHONE_SEPARATORS, '');
}

/**
 * Judges a cleaned phone number.
 *
 * @param phone the number after {@link cleanSignUpPhone}
 * @returns the sentence for the form field, or `undefined` when it is an optional leading `+` and 7 to 15 digits
 */
export function signUpPhoneProblem(phone: string): string | undefined {
  if (PHONE_SHAPE.test(phone)) return undefined;
  if (HIDDEN.test(phone)) return HIDDEN_PROBLEM;
  return `Enter a phone number of ${SIGN_UP_PHONE_DIGITS.min} to ${SIGN_UP_PHONE_DIGITS.max} digits, with the country code (+962 79 123 4567).`;
}

/**
 * The name an account made by a sign-up gets.
 *
 * Why: the account has one `name` column (decision 064); the sign-up asks for two names, so the account's name is both, in that order.
 *
 * @param firstName the trimmed first name
 * @param lastName the trimmed last name
 * @returns the first name, one space, the last name
 */
export function signUpFullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`;
}

/**
 * What the exchange of a link that carries sign-up details does with them.
 *
 * - `apply`: the account this exchange made takes the name, the country (and its currency), the phone and the password of the form.
 * - `pending`: the account this exchange made takes nothing of the form; the answer shows the details (never the password) to the person
 *   who proved the mailbox, who confirms or corrects them with `POST /store/v1/auth/sign-up/finish`.
 * - `discard`: the account already had its login: the link is a plain sign-in and the form is dropped untouched.
 */
export type SignUpOutcome = 'apply' | 'pending' | 'discard';

/**
 * Decides what the exchange of a sign-up link does with the form that waits beside it.
 *
 * Why: decision 079 and its fix round. The form belongs to the account only when this exchange made it (no row, or a guest row that this
 * exchange turned into an account): an account that already had a login keeps everything it has. Even then the form is applied only in
 * the browser that sent it (`requestedHere`): the link proves the mailbox, not the form. Anywhere else a stranger could have signed up
 * with someone else's address and a password, name, phone and country of their own, waited for the owner of the mailbox to open the link,
 * and then signed in to the owner's new account with that password (or left their own details on it). Phone mail apps open links in their
 * own browser, so "elsewhere" is common: the account is then made and signed in with nothing of the form, the waiting hash is discarded,
 * and the person who opened the link sees the details as typed to confirm or correct them.
 *
 * @param facts whether this exchange made the account, and whether the browser that opened the link is the one that asked for it
 * @returns `apply`, `pending` or `discard`
 */
export function signUpOutcome(facts: { readonly madeHere: boolean; readonly requestedHere: boolean }): SignUpOutcome {
  if (!facts.madeHere) return 'discard';
  return facts.requestedHere ? 'apply' : 'pending';
}
