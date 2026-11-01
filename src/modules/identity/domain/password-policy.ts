// The staff password policy (route POST /admin/auth/password/set, decision 007): a pure check, so it is unit-tested.
// The console hints "at least 10 characters"; the server also refuses trivially weak passwords (RULES auth, MISMATCHES B3).

/** The fewest characters a staff password may have (the console shows the same number). */
export const MIN_PASSWORD_LENGTH = 10;
/** The most characters accepted; far below the hasher's 1024-byte bound, so a four-byte character cannot exceed it. */
export const MAX_PASSWORD_LENGTH = 128;

/** Words that make a password guessable whatever digits or symbols follow them ("Password123!"). */
const COMMON_BASES: ReadonlySet<string> = new Set([
  'password',
  'passw0rd',
  'passwort',
  'qwerty',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'letmein',
  'welcome',
  'admin',
  'administrator',
  'iloveyou',
  'changeme',
  'trustno',
  'abcdefgh',
  'abcdefghij',
  'football',
  'baseball',
  'monkey',
  'dragon',
  'master',
  'login',
  'secret',
  'gsm',
  'gsmsupply',
]);

/** Digit runs that are not a password however long they are. */
const DIGIT_RUNS = ['01234567890123456789', '98765432109876543210'];

/** What was wrong with a password: a short sentence for the form field. */
export interface PasswordProblem {
  readonly message: string;
}

/** The account details a password must not contain. */
export interface PasswordContext {
  readonly email?: string;
  readonly name?: string;
}

/**
 * Judges a new staff password.
 *
 * Why: a long enough password can still be trivial ("1111111111", "password123"), and one that holds the person's own name
 * or email is the first thing guessed. The server decides; the console's hint is only advice.
 *
 * @param password the plain password the person chose
 * @param context the email and name of the account, which the password must not contain
 * @returns the problem, or `undefined` when the password is acceptable
 */
export function checkPasswordPolicy(password: string, context: PasswordContext = {}): PasswordProblem | undefined {
  const characters = Array.from(password);
  if (characters.length < MIN_PASSWORD_LENGTH) {
    return { message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (characters.length > MAX_PASSWORD_LENGTH) {
    return { message: `Use at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  if (new Set(characters).size < 5) return { message: 'Use more different characters.' };

  const lower = password.toLowerCase();
  const alnum = lower.replace(/[^\p{L}\p{N}]/gu, '');
  if (DIGIT_RUNS.some((run) => run.includes(alnum))) return { message: 'This password is too easy to guess.' };
  // "Password123!" is the word "password" plus digits and symbols: drop the digits around the word.
  const base = alnum.replace(/^\d+|\d+$/g, '');
  if (COMMON_BASES.has(base)) return { message: 'This password is too easy to guess.' };

  const local =
    context.email
      ?.split('@')[0]
      ?.toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '') ?? '';
  if (local.length >= 4 && alnum.includes(local)) return { message: 'Do not use your email address in your password.' };
  for (const part of (context.name ?? '').toLowerCase().split(/\s+/)) {
    const word = part.replace(/[^\p{L}\p{N}]/gu, '');
    if (word.length >= 4 && alnum.includes(word)) return { message: 'Do not use your name in your password.' };
  }
  return undefined;
}
