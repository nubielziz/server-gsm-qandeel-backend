// Sign-up with details (backend decision 079): the two routes beyond the map (decision 035): the sign-up that makes a shop account with an
// email, a password, both names, a country and a phone, and its finish, which a signed-in account without a password uses to set its
// details and its first password (a sign-up link opened in another browser applies nothing). The map's `POST /store/v1/auth/magic-link`
// keeps its row (it no longer makes an account). Written in English only (decision 039): no Arabic sentence, the access name as auth text.
// Called by the shop only, so no `successStatus`.
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R(
    'store',
    'account',
    'POST',
    '/store/v1/auth/sign-up',
    undefined,
    'public + Turnstile',
    79,
    ['clients', 'auth_tokens', 'account_signups', 'outbox_events'],
    {
      en: 'Sign up with an email, a password, both names, a country and a phone: the account is made when the mailed link is opened.',
      module: 'customers',
      spec: 'B-TBD sign-up-with-details',
    },
  ),
  R(
    'store',
    'account',
    'POST',
    '/store/v1/auth/sign-up/finish',
    undefined,
    'customer-session',
    79,
    ['clients', 'auth_tokens', 'sessions'],
    {
      en: 'Finish the sign-up of the signed-in account that has no password yet: its name, country, phone and first password.',
      module: 'customers',
      spec: 'B-TBD sign-up-with-details',
    },
  ),
];
