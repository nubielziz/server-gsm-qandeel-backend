// Generated names of a new merchant (POST /client/auth/register, B122): the Dhru username and the referral code. Pure
// functions over an injected random source, so the unit tests need no luck.

/** Picks a whole number from 0 up to, but not including, `max` (the service passes `crypto.randomInt`). */
export type RandomInt = (max: number) => number;

/** Referral codes look like the console's seed: `GSM` and six characters. */
export const REFERRAL_PREFIX = 'GSM';
/** No `0/O` and no `1/I`: a code read out over the phone cannot be mistaken. */
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_LENGTH = 6;
const USERNAME_BASE_MAX = 16;
const USERNAME_DIGITS = 5;

/**
 * Makes a referral code.
 *
 * Why: B122 gives every merchant a unique referral code; random characters keep one merchant's code from hinting at another's.
 *
 * @param randomInt the random source
 * @returns for example `GSM7K2QXD`
 */
export function referralCodeFor(randomInt: RandomInt): string {
  let code = REFERRAL_PREFIX;
  for (let index = 0; index < REFERRAL_LENGTH; index++)
    code += REFERRAL_ALPHABET.charAt(randomInt(REFERRAL_ALPHABET.length));
  return code;
}

/**
 * Makes a Dhru username from the email's local part.
 *
 * Why: the Dhru `username` is a generated, unique, lower-case word (B122); the merchant never chooses it. Letters and digits
 * only, so Dhru client software accepts it, and random digits keep two people called `ali` apart.
 *
 * @param email the merchant's email
 * @param randomInt the random source
 * @returns for example `ali48213`
 */
export function usernameFor(email: string, randomInt: RandomInt): string {
  const local = email.split('@')[0] ?? '';
  const base =
    local
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, USERNAME_BASE_MAX) || 'merchant';
  let digits = '';
  for (let index = 0; index < USERNAME_DIGITS; index++) digits += String(randomInt(10));
  return `${base}${digits}`;
}
