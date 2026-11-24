// The wire row of an account on the staff routes (decision 064): one schema for a merchant, a retail account and a guest. The list, the
// detail and the answers of every staff write send it, so they cannot drift apart.
import { z } from 'zod';
import { zDecimal, zId, zIsoDateTime, zMoney, zSignedMoney } from '../../../common/contract';
import { CLIENT_STATUSES } from '../db/schema';
import { PersonRef } from './shared';

/** The two kinds of rank on the wire (the stored kinds `b2b` and `b2c_retail` stay inside the catalog). */
export const ACCOUNT_RANK_KINDS = ['retail', 'merchant'] as const;

/** One value of {@link ACCOUNT_RANK_KINDS}. */
export type AccountRankKind = (typeof ACCOUNT_RANK_KINDS)[number];

/** The kinds of wallet an account can hold on the wire: `merchant` (wallet and hold, credit when the rank allows it) and `store` (pay first). */
export const ACCOUNT_WALLET_KINDS = ['merchant', 'store'] as const;

/**
 * The rank of an account as the staff routes show it.
 *
 * Why: the rank is the one thing that tells a merchant from a retail account (decision 064); the console shows its name and reads its
 * kind to decide which parts of the account page exist.
 */
export const AccountRankSchema = z.object({
  id: zId,
  name: z.string(),
  kind: z.enum(ACCOUNT_RANK_KINDS),
  discountPercent: zDecimal,
  creditAllowed: z.boolean(),
});

/** How the account signs in and what staff can still do about it; `null` in the row of a guest (a guest has no login). */
export const AccountSecuritySchema = z.object({
  hasPassword: z.boolean(),
  mustChangePassword: z.boolean(),
  passwordChangedAt: zIsoDateTime.nullable(),
  twofaEnabled: z.boolean(),
  lastLoginAt: zIsoDateTime.nullable(),
  lastLoginIp: z.string().nullable(),
  activeSessions: z.number().int().min(0),
  linkSentAt: zIsoDateTime.nullable(),
  verificationSentAt: zIsoDateTime.nullable(),
});

/** Why, when and by whom the account was suspended. */
export const AccountSuspensionSchema = z.object({
  at: zIsoDateTime.nullable(),
  reason: z.string().nullable(),
  by: PersonRef.nullable(),
});

/** The live wallet of the account (only for staff who hold `wallet:read`; absent for a guest). */
export const AccountWalletSchema = z.object({
  kind: z.enum(ACCOUNT_WALLET_KINDS),
  balance: zSignedMoney,
  reserved: zMoney,
  creditLimit: zMoney,
  available: zSignedMoney,
  frozen: z.boolean(),
});

/** The last 30 days of orders of the account, both doors (only for staff who hold `wallet:read`). */
export const AccountStatsSchema = z.object({
  orders: z.number().int().min(0),
  spend: zMoney,
  profit: zSignedMoney,
  margin: zDecimal.nullable(),
  successRate: z.number().nullable(),
  lastOrderAt: zIsoDateTime.nullable(),
});

/**
 * An account as the staff routes read it. Never carries a password hash, TOTP data or preferences.
 *
 * Why: merchants, shop customers and guests are one kind of row (decision 064), so the console reads one shape and tells them apart by
 * `rank.kind` and `hasAccount`. `username` is null until the account holds a merchant rank; `security` is null for a guest;
 * `invitationPending` is true for an account with a login, no password yet and an active status. `ordersCount` and `lastOrderAt` count
 * every order of the account, whatever the door and the status.
 */
export const AccountRowSchema = z.object({
  id: zId,
  createdAt: zIsoDateTime,
  name: z.string(),
  email: z.string(),
  emailVerifiedAt: zIsoDateTime.nullable(),
  phone: z.string(),
  country: z.string(),
  company: z.string(),
  address: z.string(),
  taxId: z.string(),
  internalNotes: z.string(),
  username: z.string().nullable(),
  status: z.enum(CLIENT_STATUSES),
  rank: AccountRankSchema,
  hasAccount: z.boolean(),
  invitationPending: z.boolean(),
  currencyCode: z.string().nullable(),
  marketingOptIn: z.boolean(),
  createdBy: PersonRef.nullable(),
  suspension: AccountSuspensionSchema.nullable(),
  anonymizedAt: zIsoDateTime.nullable(),
  lastLoginAt: zIsoDateTime.nullable(),
  ordersCount: z.number().int().min(0),
  lastOrderAt: zIsoDateTime.nullable(),
  security: AccountSecuritySchema.nullable(),
  wallet: AccountWalletSchema.optional(),
  stats: AccountStatsSchema.optional(),
});

/** An account row as the wire carries it. */
export type AccountRow = z.infer<typeof AccountRowSchema>;

/** The example of a merchant account with a wallet and figures (what a staff member who holds `wallet:read` reads). */
export const ACCOUNT_ROW_EXAMPLE = {
  id: 1,
  createdAt: '2025-09-01T09:30:00.000Z',
  name: 'Zain Mobile Hub',
  email: 'ops@zainmobilehub.example',
  emailVerifiedAt: '2025-09-01T10:30:00.000Z',
  phone: '',
  country: 'JO',
  company: 'Zain Mobile Hub',
  address: 'Abdali Boulevard, Amman',
  taxId: 'JO-1234567',
  internalNotes: 'Pays by bank transfer on Sundays.',
  username: 'zain-mobile-hub',
  status: 'active',
  rank: { id: 3, name: 'VIP', kind: 'merchant', discountPercent: '8.0000', creditAllowed: true },
  hasAccount: true,
  invitationPending: false,
  currencyCode: null,
  marketingOptIn: false,
  createdBy: { id: 2, name: 'Rami K.' },
  suspension: null,
  anonymizedAt: null,
  lastLoginAt: '2026-11-01T09:30:00.000Z',
  ordersCount: 42,
  lastOrderAt: '2026-11-01T08:00:00.000Z',
  security: {
    hasPassword: true,
    mustChangePassword: false,
    passwordChangedAt: '2025-09-01T10:35:00.000Z',
    twofaEnabled: true,
    lastLoginAt: '2026-11-01T09:30:00.000Z',
    lastLoginIp: '203.0.113.24',
    activeSessions: 2,
    linkSentAt: null,
    verificationSentAt: null,
  },
  wallet: {
    kind: 'merchant',
    balance: '1480.0000',
    reserved: '0.0000',
    creditLimit: '2000.0000',
    available: '3480.0000',
    frozen: false,
  },
  stats: {
    orders: 12,
    spend: '640.0000',
    profit: '96.0000',
    margin: '15.0',
    successRate: 97.5,
    lastOrderAt: '2026-11-01T08:00:00.000Z',
  },
} as const;

/** The example of a guest: a retail row without a login, a username or a wallet (`security` is null). */
export const GUEST_ROW_EXAMPLE = {
  id: 101,
  createdAt: '2026-10-20T14:00:00.000Z',
  name: 'Lina Haddad',
  email: 'lina@example.com',
  emailVerifiedAt: null,
  phone: '',
  country: 'GB',
  company: '',
  address: '',
  taxId: '',
  internalNotes: '',
  username: null,
  status: 'active',
  rank: { id: 9, name: 'Storefront retail', kind: 'retail', discountPercent: '0.0000', creditAllowed: false },
  hasAccount: false,
  invitationPending: false,
  currencyCode: 'USD',
  marketingOptIn: false,
  createdBy: null,
  suspension: null,
  anonymizedAt: null,
  lastLoginAt: null,
  ordersCount: 1,
  lastOrderAt: '2026-10-20T14:05:00.000Z',
  security: null,
} as const;
