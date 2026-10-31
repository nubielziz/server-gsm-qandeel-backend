// Unit test of the permissions catalog (ALIGNMENT § 4): every concrete permission the registered contracts require,
// sorted, unique, and never an `area:*` wildcard.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';
import { PermissionsCatalog } from './permissions-catalog';

const route = (key: `GET /admin/spec/catalog/${string}`, permission: string | undefined) =>
  defineRoute({
    key,
    summary: 'A route',
    tags: ['spec'],
    surface: 'admin',
    access: permission ? 'staff-permission' : 'staff-session',
    ...(permission ? { permission } : {}),
    success: { status: 200, schema: z.object({}) },
    errors: [],
  } as never);

describe('PermissionsCatalog', () => {
  it('lists every concrete permission once, sorted, and ignores routes that carry no permission', () => {
    route('GET /admin/spec/catalog/b', 'zzspec:update');
    route('GET /admin/spec/catalog/a', 'zzspec:read');
    route('GET /admin/spec/catalog/a2', 'zzspec:read');
    route('GET /admin/spec/catalog/none', undefined);
    const list = new PermissionsCatalog().list();
    expect(list.filter((permission) => permission.startsWith('zzspec:'))).toEqual(['zzspec:read', 'zzspec:update']);
    expect([...list]).toEqual([...list].sort());
    expect(new Set(list).size).toBe(list.length);
    expect(list).not.toContain('');
    expect(list.every((permission) => /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(permission))).toBe(true);
  });

  it('leaves out the area wildcard a route may require (like `risk:*`): it is a grant, not a permission', () => {
    route('GET /admin/spec/catalog/star', 'zzspec:*');
    const list = new PermissionsCatalog().list();
    expect(list).not.toContain('zzspec:*');
    expect(list.some((permission) => permission.includes('*'))).toBe(false);
  });

  it('follows the registry, so it never drifts from the routes', () => {
    const before = new PermissionsCatalog().list();
    route('GET /admin/spec/catalog/late', 'zzlate:read');
    const after = new PermissionsCatalog().list();
    expect(before).not.toContain('zzlate:read');
    expect(after).toContain('zzlate:read');
  });
});
