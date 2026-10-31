// Seeder of the identity module: the 6 roles, the 6 staff members and the IP rules of the frontend demo.
// Mirrors the frontend mocks (src/mocks/roles.ts, staff.ts, ipRules.ts); sign-in credentials are P2.6's job.
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { type DemoSeed, demoNumericId, demoRows, toDate } from './demo-state';
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

/**
 * Seeds roles, staff and IP rules.
 *
 * Why: the console needs six roles to pick from, the six demo staff members to show in the admin-team pages, and the
 * demo IP rules (scenario ip-rules). Passwords and TOTP secrets stay empty: P2.6 sets the development credentials.
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

  for (const table of [s.roles, s.staffUsers, s.ipRules]) await syncIdentity(db, table);
  return [roles, staff, ipRules];
}
