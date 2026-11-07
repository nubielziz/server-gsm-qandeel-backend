// Seeder of the identity module: the 6 roles, the 6 staff members, the IP rules, and the 20 merchants (with the demo client
// groups they sit in) of the frontend demo. Mirrors the frontend mocks (src/mocks/roles.ts, staff.ts, ipRules.ts and
// src/features/merchants/mocks/seed.ts); the development sign-in credentials are dev-credentials.ts (P2.6). The wallets of the
// merchants are feature 3's seed (money.ts).
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

/** The demo's role keys, in id order. */
export type RoleKey = 'owner' | 'admin' | 'finance' | 'support' | 'risk' | 'viewer';

/** The six built-in roles with the ids and names the frontend mock gives them. */
export const ROLES: ReadonlyArray<{ key: RoleKey; id: number; name: string }> = [
  { key: 'owner', id: 1, name: 'Owner' },
  { key: 'admin', id: 2, name: 'Admin' },
  { key: 'finance', id: 3, name: 'Finance' },
  { key: 'support', id: 4, name: 'Support' },
  { key: 'risk', id: 5, name: 'Risk reviewer' },
  { key: 'viewer', id: 6, name: 'Read only' },
];

// Access level per demo area, in AREA_PERMISSIONS order: 0 none, 1 view, 2 manage (frontend ROLE_MATRIX).
const ROLE_MATRIX: Record<RoleKey, readonly number[]> = {
  owner: [2, 2, 2, 2, 2, 2, 2, 2, 2],
  admin: [2, 2, 2, 2, 2, 2, 2, 1, 2],
  finance: [1, 1, 0, 1, 2, 1, 0, 0, 1],
  support: [1, 2, 2, 1, 0, 1, 0, 0, 1],
  risk: [1, 1, 1, 2, 1, 0, 0, 0, 1],
  viewer: [1, 1, 1, 1, 1, 1, 0, 0, 1],
};

// The permission areas behind each demo area: Orders, Customers, Support, Risk, Money, Catalog, Settings, Admins, System.
const AREA_PERMISSIONS: ReadonlyArray<readonly string[]> = [
  ['orders', 'inventory', 'files'],
  ['customers', 'clients', 'wallet', 'groups', 'kyc', 'api_keys', 'growth'],
  ['support'],
  ['risk'],
  ['ledger', 'payments', 'invoices', 'commissions', 'refunds', 'disputes', 'reports'],
  ['catalog', 'pricing', 'suppliers', 'storefront', 'legal'],
  ['settings', 'tax', 'currencies', 'webhooks', 'notifications'],
  ['staff', 'access', 'roles', 'sessions', 'audit', 'queues'],
  ['system', 'alerts', 'incidents'],
];

/**
 * The permission strings of a built-in role.
 *
 * Why: the exact lists the frontend mock grants (`permissionsOf` in src/mocks/roles.ts): the owner has `*`, the others
 * `dashboard:read` plus `area:*` where they manage and `area:read` where they only view.
 *
 * @param key the role key
 * @returns the permissions in the order the mock writes them
 */
export function permissionsOf(key: RoleKey): string[] {
  if (key === 'owner') return ['*'];
  const granted = new Set<string>(['dashboard:read']);
  ROLE_MATRIX[key].forEach((level, area) => {
    for (const permissionArea of AREA_PERMISSIONS[area] ?? []) {
      if (level === 2) granted.add(`${permissionArea}:*`);
      else if (level === 1) granted.add(`${permissionArea}:read`);
    }
  });
  return [...granted];
}

/** An admin of the demo seed, as the demo stores it (the fields the seed uses). */
interface DemoAdmin {
  id: string;
  name: string;
  email: string;
  role: RoleKey;
  status: 'invited' | 'active' | 'suspended';
  twofa: boolean;
  mustChangePw: boolean;
  lastLogin: number | null;
  lastIp: string | null;
  createdAt: number;
  createdBy: string;
  pwChangedAt: number | null;
  suspendedAt: number | null;
  suspendedReason: string;
}

/** An IP rule of the demo seed, as the demo stores it. */
interface DemoIpRule {
  id: string;
  kind: 'allow' | 'block';
  cidr: string;
  scope: 'store' | 'api' | 'admin' | 'all';
  label: string;
  reason: string;
  source: 'manual' | 'auto';
  by: string;
  ts: number;
  expires: number | null;
  hits: number;
  lastHit: number | null;
}

/** A merchant of the demo seed, as the demo stores it (the fields the seed uses). */
interface DemoMerchant {
  id: string;
  name: string;
  cc: string;
  group: 'std' | 'whl' | 'vip';
  status: 'active' | 'pending' | 'suspended';
  /** days since the merchant joined */
  joined: number;
  referredBy: string | null;
  email: string;
  kyc: string;
}

const DAY_MS = 86_400_000;

/**
 * The demo's client groups with the ids and values the frontend mock gives them (`GROUPS` in
 * src/features/merchants/mocks/seed.ts): three merchant groups and the storefront's retail group (`b2c_retail`).
 *
 * Why: `clients.group_id` needs a group, and no other seeder creates them yet (the catalog feature's seeder takes this list
 * over). Note: the frontend mock gives Standard `overdraft_allowed = false` while its merchants have a credit limit above
 * zero; user rule 2 forbids that pair, so the wallet seed (feature 3) must settle it.
 */
export const CLIENT_GROUPS = [
  { id: 1, name: 'Standard', discount: 0, threshold: 0, deposit: 5000, isDefault: true, overdraft: false, kind: 'b2b' },
  {
    id: 2,
    name: 'Wholesale',
    discount: 4,
    threshold: 5000,
    deposit: 20000,
    isDefault: false,
    overdraft: true,
    kind: 'b2b',
  },
  {
    id: 3,
    name: 'VIP',
    discount: 8,
    threshold: 25000,
    deposit: 100000,
    isDefault: false,
    overdraft: true,
    kind: 'b2b',
  },
  {
    id: 4,
    name: 'Storefront retail',
    discount: 0,
    threshold: 0,
    deposit: 1000,
    isDefault: false,
    overdraft: false,
    kind: 'b2c_retail',
  },
] as const;

/** The demo's group keys and the ids of the groups they name. */
const GROUP_IDS = { std: 1, whl: 2, vip: 3 } as const;

/**
 * Seeds the demo client groups.
 *
 * @param db the transaction to write with
 * @param now the rebased "now" of the demo; the groups are dated 400 days before it
 * @returns the report of `client_groups`
 */
export async function seedClientGroups(db: DbExecutor, now: number): Promise<SeedReport> {
  const report = await insertRows(
    db,
    s.clientGroups,
    CLIENT_GROUPS.map((group) => ({
      id: group.id,
      name: group.name,
      kind: group.kind,
      discountPercent: toMoney(group.discount),
      isDefault: group.isDefault,
      earnThreshold: toMoney(group.threshold),
      depositLimit: toMoney(group.deposit),
      overdraftAllowed: group.overdraft,
      sort: group.id,
      createdAt: new Date(now - 400 * DAY_MS),
    })),
  );
  await syncIdentity(db, s.clientGroups);
  return report;
}

/** The Dhru username of a demo merchant: its name as a slug (the frontend mock's `slug`). */
function usernameOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Seeds the demo merchants.
 *
 * Why: the console's merchant pages and every later feature (orders, wallets, prices) start from the same 20 merchants, with
 * the ids, names, groups, statuses and referrers the frontend mock gives them (`m3` is 3, `GSM0003` its referral code). No
 * password is stored: a merchant sets one through the invitation or forgot-password link. The wallet (ledger accounts, credit
 * limit, balance) is feature 3's seed; the credit limits of the demo are not written here.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns the report of `clients`
 */
export async function seedMerchants(db: DbExecutor, demo: DemoSeed): Promise<SeedReport> {
  const report = await insertRows(
    db,
    s.clients,
    demoRows<DemoMerchant>(demo, 'merchants').map((merchant) => {
      const id = demoNumericId(merchant.id);
      const created = demo.now - merchant.joined * DAY_MS;
      return {
        id,
        username: usernameOf(merchant.name),
        email: merchant.email,
        name: merchant.name,
        company: merchant.name,
        phone: '',
        country: merchant.cc,
        groupId: GROUP_IDS[merchant.group],
        status: merchant.status,
        kycStatus: merchant.kyc === 'Verified' ? ('approved' as const) : ('pending' as const),
        referredById: merchant.referredBy === null ? null : demoNumericId(merchant.referredBy),
        referralCode: `GSM${String(id).padStart(4, '0')}`,
        // A merchant who accepted the invitation has proven the email; pending ones have not yet.
        emailVerifiedAt: merchant.status === 'pending' ? null : new Date(created + 3_600_000),
        createdAt: new Date(created),
      };
    }),
  );
  await syncIdentity(db, s.clients);
  return report;
}

/**
 * Seeds roles, staff, IP rules, client groups and merchants.
 *
 * Why: the console needs six roles to pick from, the six demo staff members to show in the admin-team pages, the
 * demo IP rules (scenario ip-rules) and the demo merchants with their groups. Passwords and TOTP secrets stay empty here: `seedDevCredentials` sets them in development.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 */
export async function seedIdentity(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const roleIds = new Map<RoleKey, number>(ROLES.map((role) => [role.key, role.id]));
  const roles = await insertRows(
    db,
    s.roles,
    ROLES.map((role) => ({ id: role.id, name: role.name, permissions: permissionsOf(role.key) })),
  );

  const admins = demoRows<DemoAdmin>(demo, 'admins');
  // "Created by Rami K." becomes a staff id; "Setup" (the account made outside the console) stays null.
  const staffIds = new Map(admins.map((admin) => [admin.name, demoNumericId(admin.id)]));
  const staff = await insertRows(
    db,
    s.staffUsers,
    admins.map((admin) => {
      const createdBy = staffIds.get(admin.createdBy) ?? null;
      return {
        id: demoNumericId(admin.id),
        email: admin.email,
        name: admin.name,
        roleId: roleIds.get(admin.role)!,
        status: admin.status,
        twofaEnabled: admin.twofa,
        mustChangePassword: admin.mustChangePw,
        passwordChangedAt: toDate(admin.pwChangedAt),
        suspendedAt: toDate(admin.suspendedAt),
        suspendedReason: admin.suspendedReason || null,
        // The demo does not record who suspended; the person who added the account stands in (as in the frontend mock).
        suspendedBy: admin.status === 'suspended' ? createdBy : null,
        createdBy,
        lastLoginAt: toDate(admin.lastLogin),
        lastLoginIp: admin.lastIp,
        createdAt: toDate(admin.createdAt)!,
      };
    }),
  );

  const ipRules = await insertRows(
    db,
    s.ipRules,
    demoRows<DemoIpRule>(demo, 'ipRules').map((rule) => ({
      id: demoNumericId(rule.id),
      kind: rule.kind,
      scope: rule.scope,
      cidr: rule.cidr,
      label: rule.label,
      reason: rule.reason,
      source: rule.source,
      expiresAt: toDate(rule.expires),
      hitCount: rule.hits,
      lastHitAt: toDate(rule.lastHit),
      createdAt: toDate(rule.ts)!,
      createdBy: rule.source === 'auto' ? null : (staffIds.get(rule.by) ?? null),
    })),
  );
  // The demo turns the admin allowlist on with documentation-range offices only: without these two rules a console
  // running against a local API (127.0.0.1 / ::1) could not sign in. Development seed only; ids 8 and 9 (after the demo's 7) keep it
  // idempotent.
  const loopback = await insertRows(
    db,
    s.ipRules,
    [
      { id: 8, cidr: '127.0.0.1/32' },
      { id: 9, cidr: '::1/128' },
    ].map(({ id, cidr }) => ({
      id,
      kind: 'allow' as const,
      scope: 'admin' as const,
      cidr,
      label: 'Local development (loopback)',
      reason: 'Seeded so the console can sign in against a local API',
      source: 'manual' as const,
      createdAt: new Date(),
    })),
  );

  for (const table of [s.roles, s.staffUsers, s.ipRules]) await syncIdentity(db, table);
  const clientGroups = await seedClientGroups(db, demo.now);
  const clients = await seedMerchants(db, demo);
  return [roles, staff, ipRules, loopback, clientGroups, clients];
}
