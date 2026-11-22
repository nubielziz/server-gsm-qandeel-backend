// Route contract of the smart sign-in (feature 24A, ROADMAP 1.3): POST /client/auth/sign-in, one email + password form for merchants
// and customers. A route beyond the map (scripts/map-additions/24a.mjs, decision 035); the storefront site is its only caller.
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';

/** Which account signed in, and so which surface's cookies and `X-CSRF-Token` came back: `merchant` = `/client`, `customer` = `/store/v1`. */
export const SignInKindSchema = z.enum(['merchant', 'customer']);

/**
 * What the site does next: replace a temporary password (merchant: `POST /client/auth/password/change`; customer:
 * `POST /store/v1/me/password`), type the authenticator code (merchants only: `POST /client/auth/2fa`), or the sign-in is complete.
 */
export const SignInNextSchema = z.enum(['password', 'totp', 'done']);

/** `POST /client/auth/sign-in`. */
export const smartSignIn = defineRoute({
  key: 'POST /client/auth/sign-in',
  summary: 'Sign in as a merchant or a customer with one form',
  description:
    'One email and password form for both account kinds. An email that belongs to a merchant with a password and a verified email ' +
    'signs in as that merchant (the merchant wins over a customer with the same email: a wrong merchant password is `401`, and the ' +
    'customer area stays reachable through the emailed sign-in link); a merchant whose email is not verified signs in only when no ' +
    'customer account with a password has the email; otherwise a customer account with a password signs in. The answer says ' +
    'which: `kind` `merchant` sets the `/client` session cookies and its `X-CSRF-Token`, `kind` `customer` the `/store/v1` ones. `next` ' +
    'is `password` after a temporary password (a `pending_password` session), `totp` for a merchant with two-factor sign-in on (a ' +
    '`pending_totp` session: continue with `POST /client/auth/2fa`), or `done`. A session of the other kind in the same browser stays ' +
    'signed in. One `401` answers an unknown email, a wrong password, an account with no password yet and an erased customer; ' +
    '`403 ACCOUNT_SUSPENDED` comes only after a correct password. Every attempt counts against the limits of both ' +
    '`POST /client/auth/login` and `POST /store/v1/auth/login` (5 per email and network in 15 minutes) and ten failures (a success in between does not cancel them) lock ' +
    'the email for 15 minutes for every network the account being signed into has not signed in from, whatever the email is: both ' +
    'answer `429 RATE_LIMITED` with `Retry-After`. While the lock runs, the attempts a network the account has signed in from is still ' +
    'allowed share one budget per network: five in 15 minutes, then `429 RATE_LIMITED` like any other attempt. A temporary password works for 72 hours after it was set; after that it is ' +
    'refused like a wrong password. Needs the anti-bot token (`X-Turnstile-Token`) and an `Origin` the API allows.',
  tags: ['auth'],
  surface: 'client',
  access: 'public',
  turnstile: true,
  csrf: false,
  body: z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(1024) }),
  success: { status: 200, schema: z.object({ kind: SignInKindSchema, next: SignInNextSchema }) },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED', 'CSRF_FAILED', 'RATE_LIMITED'],
  examples: {
    request: { email: 'ali@example.com', password: 'a-long-password' },
    response: { kind: 'merchant', next: 'done' },
  },
});
