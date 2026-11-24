// One account type (decision 064; spec B245): the routes beyond the map that merchants and shop customers becoming one
// account add (decision 035). Admin: the counts, the legacy lookup, the rank change, make an account, block, the privacy read, export,
// anonymize, and freeze and unfreeze of the live wallet. Store: the two-step sign-in routes of a retail account. Written in English only
// (decision 039): no Arabic sentence, the permission or the access name as auth text.
// Every admin route here is called by the console, so each has `successStatus`; the store routes are called by the shop only.
// Changed routes (the one sign-in, the list and the detail, the wallet routes, the old customer routes that now answer 410) are map rows or
// rows of older files and keep their place; this file holds only what is new.
import { R } from '../lib/map-additions.mjs';

const SPEC = 'B245';
const STAGE = 48;

/** An admin row of the Merchants and wallets group. */
const admin = (m, p, a, t, en, module, successStatus) =>
  R('admin', 'clients', m, p, undefined, a, STAGE, t, { en, module, spec: SPEC, successStatus });

/** A store row for the signed-in retail account (access name customer-session). */
const store = (p, t, en) =>
  R('store', 'account', 'POST', p, undefined, 'customer-session', STAGE, t, { en, module: 'customers', spec: SPEC });

export const rows = [
  admin(
    'GET',
    '/admin/clients/counts',
    'clients:read',
    ['clients'],
    'The counts of accounts in one aggregate: all, retail, merchant, guests, by status and invitations pending.',
    'identity',
    200,
  ),
  admin(
    'GET',
    '/admin/legacy-accounts/:type/:id',
    'clients:read',
    ['account_legacy_ids'],
    'Find the account an old merchant or customer number belongs to now.',
    'identity',
    200,
  ),
  admin(
    'POST',
    '/admin/clients/:id/account',
    'clients:update',
    ['clients', 'auth_tokens', 'notifications', 'audit_logs'],
    'Make a login account of a guest: send a set-password link or set a temporary password.',
    'identity',
    200,
  ),
  admin(
    'POST',
    '/admin/clients/:id/rank',
    'clients:update',
    [
      'clients',
      'client_groups',
      'ledger_accounts',
      'ledger_transactions',
      'ledger_entries',
      'account_rank_changes',
      'sessions',
      'api_keys',
      'auth_tokens',
      'audit_logs',
    ],
    'Change the rank of an account (Owner only, with an Idempotency-Key): across kinds the balance moves to the wallet of the new kind and the sessions end.',
    'money',
    200,
  ),
  admin(
    'POST',
    '/admin/clients/:id/block',
    'clients:block',
    ['clients', 'blocklist_entries', 'sessions', 'audit_logs'],
    'Block an account for fraud, or lift the block, with a reason; blocking adds its email and the card and IMEI fingerprints of its shop orders to the blocklist.',
    'customers',
    204,
  ),
  admin(
    'GET',
    '/admin/clients/:id/privacy',
    'clients:read',
    ['clients', 'consent_records', 'checkout_sessions', 'risk_assessments'],
    'The privacy facts of an account: the marketing choice, the consents of its latest shop order and its risk signals.',
    'customers',
    200,
  ),
  admin(
    'GET',
    '/admin/clients/:id/export',
    'customers:privacy',
    ['clients', 'orders', 'checkout_sessions', 'consent_records', 'support_tickets', 'files', 'data_requests'],
    'Export the data of an account for a data-protection request.',
    'customers',
    200,
  ),
  admin(
    'POST',
    '/admin/clients/:id/anonymize',
    'customers:privacy',
    ['clients', 'data_requests', 'sessions', 'api_keys', 'ledger_accounts', 'audit_logs'],
    'Anonymize the name, email and IMEI of a retail account while keeping the payment records for accounting.',
    'customers',
    204,
  ),
  admin(
    'POST',
    '/admin/clients/:id/wallet/freeze',
    'wallet:adjust',
    ['ledger_accounts', 'wallet_action_keys', 'audit_logs'],
    'Put the live wallet of an account on hold, with a reason and an Idempotency-Key.',
    'money',
    200,
  ),
  admin(
    'POST',
    '/admin/clients/:id/wallet/unfreeze',
    'wallet:adjust',
    ['ledger_accounts', 'wallet_action_keys', 'audit_logs'],
    'Lift the hold on the live wallet of an account, with an Idempotency-Key.',
    'money',
    200,
  ),
  store(
    '/store/v1/me/2fa/setup',
    ['clients'],
    'A new authenticator secret with a QR code for the signed-in account (a password is needed first).',
  ),
  store(
    '/store/v1/me/2fa/enable',
    ['clients'],
    'Turn on two-factor sign-in for the signed-in account after confirming a code.',
  ),
  store('/store/v1/me/2fa/disable', ['clients'], 'Turn off two-factor sign-in for the signed-in account with a code.'),
];
