// Unit tests of the IP rule matcher (scenario ip-rules): block rules first, the admin allowlist when the restriction is on,
// scopes, expiry, IPv6, specificity and the verdict the future "check an address" route needs.
import { describe, expect, it } from 'bun:test';
import { parseIpAddress } from '../../../../common/ip-address';
import type { IpRuleKind, IpRuleScope } from '../../db/schema';
import type { IpAudience } from './ip-audience';
import { type ActiveIpRule, compileIpRules, decideIpAccess } from './ip-rule-matcher';

const NOW = Date.parse('2026-03-01T12:00:00.000Z');

let nextId = 1;
const rule = (
  kind: IpRuleKind,
  scope: IpRuleScope,
  cidr: string,
  expiresAt: string | null = null,
  id = nextId++,
): ActiveIpRule => ({ id, kind, scope, cidr, expiresAt });

function decide(rules: ActiveIpRule[], ip: string | undefined, audience: IpAudience, restricted = false) {
  const compiled = compileIpRules({ version: 'v', restricted, rules });
  return decideIpAccess(compiled, ip === undefined ? undefined : parseIpAddress(ip), audience, NOW);
}

describe('block rules', () => {
  it('refuse an address covered by a rule of the audience, and name the rule', () => {
    const block = rule('block', 'store', '192.0.2.0/24');
    expect(decide([block], '192.0.2.77', 'store')).toEqual({ decision: 'refused', rule: block, reason: 'blocked' });
    expect(decide([block], '192.0.3.1', 'store')).toEqual({ decision: 'allowed', rule: null, reason: 'open' });
  });

  it('apply to their own audience only, and "all" applies to every audience', () => {
    const store = rule('block', 'store', '203.0.113.9');
    const everywhere = rule('block', 'all', '198.51.100.231');
    for (const audience of ['admin', 'api', 'other'] as const) {
      expect(decide([store], '203.0.113.9', audience).decision, audience).toBe('allowed');
      expect(decide([everywhere], '198.51.100.231', audience).decision, audience).toBe('refused');
    }
    expect(decide([store], '203.0.113.9', 'store').decision).toBe('refused');
    expect(decide([everywhere], '198.51.100.231', 'store').decision).toBe('refused');
  });

  it('ignore a rule past its expiry, and keep one that has not expired yet', () => {
    const past = rule('block', 'all', '203.0.113.9', '2026-03-01T11:59:59.999Z');
    const exactly = rule('block', 'all', '203.0.113.10', '2026-03-01T12:00:00.000Z');
    const future = rule('block', 'all', '203.0.113.11', '2026-03-01T12:00:00.001Z');
    expect(decide([past], '203.0.113.9', 'store').decision).toBe('allowed');
    expect(decide([exactly], '203.0.113.10', 'store').decision).toBe('allowed');
    expect(decide([future], '203.0.113.11', 'store').decision).toBe('refused');
  });

  it('match IPv6 ranges and single addresses, and an IPv4-mapped client matches the IPv4 rule', () => {
    const range = rule('block', 'all', '2001:db8::/32');
    const single = rule('block', 'all', '203.0.113.9/32');
    expect(decide([range], '2001:db8:ffff::5', 'store').decision).toBe('refused');
    expect(decide([range], '2001:db9::5', 'store').decision).toBe('allowed');
    expect(decide([single], '::ffff:203.0.113.9', 'store').decision).toBe('refused');
    expect(decide([range], '203.0.113.9', 'store').decision).toBe('allowed');
  });

  it('report the most specific rule when several cover the address (longest prefix, then the lowest id)', () => {
    const wide = rule('block', 'all', '203.0.113.0/24', null, 10);
    const narrow = rule('block', 'all', '203.0.113.9/32', null, 11);
    const twin = rule('block', 'all', '203.0.113.9/32', null, 9);
    expect(decide([wide, narrow], '203.0.113.9', 'store').rule?.id).toBe(11);
    expect(decide([wide, narrow, twin], '203.0.113.9', 'store').rule?.id).toBe(9);
    expect(decide([wide, narrow], '203.0.113.200', 'store').rule?.id).toBe(10);
  });

  it('skip a rule whose network cannot be read', () => {
    const broken = rule('block', 'all', 'not-a-network');
    expect(decide([broken], '203.0.113.9', 'store').decision).toBe('allowed');
  });
});

describe('the admin allowlist', () => {
  const office = rule('allow', 'admin', '203.0.113.24/32');
  const lan = rule('allow', 'admin', '10.0.0.0/16');

  it('is not consulted while the restriction is off', () => {
    expect(decide([office], '8.8.8.8', 'admin', false)).toEqual({ decision: 'allowed', rule: null, reason: 'open' });
  });

  it('lets only listed addresses use the admin console while the restriction is on, and names the allow rule', () => {
    expect(decide([office, lan], '203.0.113.24', 'admin', true)).toEqual({
      decision: 'allowed',
      rule: office,
      reason: 'allowed',
    });
    expect(decide([office, lan], '10.0.200.5', 'admin', true).rule).toBe(lan);
    expect(decide([office, lan], '8.8.8.8', 'admin', true)).toEqual({
      decision: 'refused',
      rule: null,
      reason: 'not_listed',
    });
  });

  it('refuses everyone when the restriction is on and no live allow rule is left', () => {
    const expired = rule('allow', 'admin', '203.0.113.24', '2026-03-01T11:00:00.000Z');
    expect(decide([expired], '203.0.113.24', 'admin', true).reason).toBe('not_listed');
    expect(decide([], '203.0.113.24', 'admin', true).reason).toBe('not_listed');
  });

  it('does not touch the other audiences', () => {
    for (const audience of ['store', 'api', 'other'] as const) {
      expect(decide([office], '8.8.8.8', audience, true).decision, audience).toBe('allowed');
    }
  });

  it('is beaten by a block rule on the same address', () => {
    const block = rule('block', 'admin', '203.0.113.24');
    expect(decide([office, block], '203.0.113.24', 'admin', true)).toEqual({
      decision: 'refused',
      rule: block,
      reason: 'blocked',
    });
  });

  it('counts only allow rules meant for the admin console', () => {
    const odd = rule('allow', 'store', '203.0.113.24');
    expect(decide([odd], '203.0.113.24', 'admin', true).reason).toBe('not_listed');
    expect(decide([rule('allow', 'all', '203.0.113.24')], '203.0.113.24', 'admin', true).reason).toBe('allowed');
  });

  it('judges an address that could not be read: not listed on the restricted console, open elsewhere', () => {
    expect(decide([office], undefined, 'admin', true).reason).toBe('not_listed');
    expect(decide([office], undefined, 'admin', false).reason).toBe('open');
    expect(decide([rule('block', 'all', '0.0.0.0/0')], undefined, 'store').reason).toBe('open');
  });
});
