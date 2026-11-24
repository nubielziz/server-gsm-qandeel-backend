// Rank-open routes (decision 064): the routes declared with `rank: 'any'` in the contract registry are exactly the pinned list of
// rank-open-routes.ts, every gated route says it can answer RANK_NOT_ALLOWED, and no route that is open to every rank does.
import { describe, expect, it } from 'bun:test';
import { RANK_GATED_ACCESS_KINDS, isRankGatedAccess, parseRouteKey } from '@src/common/contract/define-route';
import { appSnapshot, type RouteSnapshot } from './lib/snapshot';
import { RANK_OPEN_ROUTES } from './rank-open-routes';

/**
 * A route of the snapshot with the rank its contract compiled to. `rank` is written by dump-app.ts; the field is optional here so a
 * snapshot taken without it fails the checks below with a message instead of a type error.
 */
type RankedRoute = RouteSnapshot & { readonly rank?: 'merchant' | 'retail' | 'any' | null };

const snapshot = await appSnapshot();
const routes: readonly RankedRoute[] = snapshot.contracts;
const gated = routes.filter((route) => isRankGatedAccess(route.access as never));
const pinned = new Set<string>(RANK_OPEN_ROUTES);

describe('the pinned list (rank-open-routes.ts)', () => {
  it('has the six keys of the expand release (five after the contract release)', () => {
    expect(RANK_OPEN_ROUTES).toHaveLength(6);
  });

  it('lists each key once, in alphabetical order, as a valid route key', () => {
    expect(pinned.size).toBe(RANK_OPEN_ROUTES.length);
    expect([...RANK_OPEN_ROUTES]).toEqual([...RANK_OPEN_ROUTES].sort());
    for (const key of RANK_OPEN_ROUTES) expect(() => parseRouteKey(key), key).not.toThrow();
  });

  it('names only routes that change something, never a read', () => {
    for (const key of RANK_OPEN_ROUTES) expect(parseRouteKey(key).method, key).toBe('POST');
  });
});

describe('the registry against the pinned list', () => {
  it('carries a rank on every route behind the gate (dump-app.ts writes it into the snapshot)', () => {
    expect(
      gated.filter((route) => route.rank === undefined || route.rank === null).map((route) => route.key),
      'a snapshot without the rank of its contracts',
    ).toEqual([]);
    for (const route of gated) expect(['merchant', 'retail', 'any'].includes(String(route.rank)), route.key).toBe(true);
  });

  it('opens to every rank exactly the pinned routes', () => {
    const open = routes.filter((route) => route.rank === 'any').map((route) => route.key);
    const openButNotPinned = open.filter((key) => !pinned.has(key)).sort();
    const pinnedButNotOpen = [...pinned].filter((key) => !open.includes(key)).sort();
    expect(openButNotPinned, 'declared rank: any but missing from test/contract/rank-open-routes.ts').toEqual([]);
    expect(pinnedButNotOpen, 'pinned in test/contract/rank-open-routes.ts but not declared rank: any').toEqual([]);
  });

  it('pins only routes that use a session of an account', () => {
    for (const key of RANK_OPEN_ROUTES) {
      const route = routes.find((candidate) => candidate.key === key);
      expect(route, `${key} has no contract`).toBeDefined();
      expect((RANK_GATED_ACCESS_KINDS as readonly string[]).includes(String(route?.access)), key).toBe(true);
    }
  });

  it('keeps a route without a session free of a rank', () => {
    for (const route of routes.filter((candidate) => !isRankGatedAccess(candidate.access as never)))
      expect(route.rank ?? null, route.key).toBeNull();
  });

  it('documents RANK_NOT_ALLOWED on every route that serves one rank only, and on no route open to every rank', () => {
    const missing = gated
      .filter((route) => route.rank !== 'any' && !route.errors.includes('RANK_NOT_ALLOWED'))
      .map((route) => route.key);
    const surplus = gated
      .filter((route) => route.rank === 'any' && route.errors.includes('RANK_NOT_ALLOWED'))
      .map((route) => route.key);
    expect(missing, 'a gated route that does not list RANK_NOT_ALLOWED').toEqual([]);
    expect(surplus, 'a route open to every rank that lists RANK_NOT_ALLOWED').toEqual([]);
  });
});
