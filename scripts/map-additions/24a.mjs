// Feature 24A (smart sign-in): the one sign-in route beyond the map, and Turnstile added to the three public merchant auth rows
// (decision 035; plan docs/briefs/24A-smart-sign-in.md § 2.5). The flags are enforced only when TURNSTILE_MERCHANT_AUTH is on.
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R(
    'client',
    'auth',
    'POST',
    '/client/auth/sign-in',
    'تسجيل دخول موحّد: تاجر أو زبون بالبريد وكلمة المرور',
    'عام + Turnstile',
    24,
    ['clients', 'customers', 'customer_credentials', 'sessions'],
    {
      en: 'Sign in with email and password as a merchant or a customer.',
      module: 'customers',
      spec: 'B-TBD smart-sign-in',
    },
  ),
];

export const rowFlags = [
  { row: 'client POST /client/auth/register', turnstile: true, spec: 'B-TBD merchant-auth-turnstile' },
  { row: 'client POST /client/auth/login', turnstile: true, spec: 'B-TBD merchant-auth-turnstile' },
  { row: 'client POST /client/auth/password/forgot', turnstile: true, spec: 'B-TBD merchant-auth-turnstile' },
];
