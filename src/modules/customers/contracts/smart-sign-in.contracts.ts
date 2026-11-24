// Route contract of the one sign-in (feature 24A, ROADMAP 1.3; decision 064): POST /client/auth/sign-in, one email + password form for every
// account, merchant or retail. A route beyond the map (scripts/map-additions/24a.mjs, decision 035); the shop is its caller.
import { z } from 'zod';
import { defineRoute, zId } from '../../../common/contract';

/**
 * Which area the account that signed in belongs to: `merchant` for a merchant rank, `customer` for the retail rank.
 *
 * Why: the shop of the time before accounts became one picks its area from this word, so it stays until the contract release; the new
 * shop reads `rank.kind` and ignores it.
 */
export const SignInKindSchema = z.enum(['merchant', 'customer']);

/**
 * What the caller does next: replace a temporary password (`POST /client/auth/password/change`), type the authenticator code
 * (`POST /client/auth/2fa`), or the sign-in is complete.
 */
export const SignInNextSchema = z.enum(['password', 'totp', 'done']);

/** The rank of the account that signed in: the shop picks its area by `kind`. */
export const SignInRankSchema = z.object({
  id: zId,
  name: z.string(),
  kind: z.enum(['retail', 'merchant']),
});

/** `POST /client/auth/sign-in`. */
export const smartSignIn = defineRoute({
  key: 'POST /client/auth/sign-in',
  summary: 'Sign in with one form',
  description:
    'The one email and password form of every account, merchant rank or retail rank. An email is one account with a login (a guest is ' +
    'never found here), so there is nothing to choose between. The answer says which area the account belongs to: `rank.kind` is ' +
    '`merchant` or `retail` (`kind` says `merchant` or `customer` for the same fact, and stays until the contract release). The ' +
    'session cookie is the one cookie of every account, and the readable CSRF cookie is `csrf_token_client` for a merchant rank and ' +
    '`csrf_token_store` for the retail rank, with the `X-CSRF-Token` header. `next` ' +
    'is `password` after a temporary password (a `pending_password` session: continue with `POST /client/auth/password/change`), `totp` for an ' +
    'account with two-factor sign-in on (a `pending_totp` session: continue with `POST /client/auth/2fa`), or `done`. One `401` answers an ' +
    'unknown email, a wrong password, an account with no password yet and an erased account; ' +
    '`403 ACCOUNT_SUSPENDED` comes only after a correct password. Every attempt counts against the one budget of `POST /client/auth/login` and ' +
    '`POST /store/v1/auth/login` (5 per email and network in 15 minutes) and ten failures (a success in between does not cancel them) lock ' +
    'the email for 15 minutes for every network the account being signed into has not signed in from, whatever the email is: both ' +
    'answer `429 RATE_LIMITED` with `Retry-After`. While the lock runs, the attempts a network the account has signed in from is still ' +
    'allowed share one budget per network: five in 15 minutes, then `429 RATE_LIMITED` like any other attempt. A temporary password works for 72 hours after it was set; after that it is ' +
    'refused like a wrong password. Needs the anti-bot token (`X-Turnstile-Token`, always) and an `Origin` the API allows.',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  turnstile: true,
  csrf: false,
  body: z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(1024) }),
  success: {
    status: 200,
    schema: z.object({ kind: SignInKindSchema, next: SignInNextSchema, rank: SignInRankSchema }),
  },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: {
    request: { email: 'ali@example.com', password: 'a-long-password' },
    response: { kind: 'merchant', next: 'done', rank: { id: 1, name: 'Standard', kind: 'merchant' } },
  },
});
