// Unit tests of the IP rule matcher (scenario ip-rules): block rules first, the admin allowlist when the restriction is on,
// scopes, expiry, IPv6, specificity and the verdict the future "check an address" route needs.
import { describe, expect, it } from 'bun:test';
import { parseIpAddress } from '@src/common/ip-address';
import type { IpRuleKind, IpRuleScope } from '@src/modules/identity/db/schema';
import type { IpAudience } from '@src/modules/identity/security/ip-rules/ip-audience';
import {
  type ActiveIpRule,
  compileIpRules,
  decideIpAccess,
  shutOut,
  shutOutNowOrLater,
} from '@src/modules/identity/security/ip-rules/ip-rule-matcher';

const NOW = Date.parse('2026-03-01T12:00:00.000Z');

let nextId = 1;
const rule = (
  kind: IpRuleKind,
  scope: IpRuleScope,
  cidr: string,
  expiresAt: string | null = null,
  id = nextId++,
): ActiveIpRule => ({ id, kind, scope, cidr, expiresAt });

function decide(
  rules: ActiveIpRule[],
  ip: string | undefined,
  audience: IpAudience | readonly IpAudience[],
  restricted = false,
) {
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

  it('refuse a request with two audiences when a rule covers either one (the shared sign-in routes, decision 064)', () => {
    const store = rule('block', 'store', '203.0.113.9');
    const api = rule('block', 'api', '203.0.113.10');
    const everywhere = rule('block', 'all', '198.51.100.231');
    const both = ['store', 'other'] as const;
    expect(decide([store], '203.0.113.9', both)).toEqual({ decision: 'refused', rule: store, reason: 'blocked' });
    expect(decide([everywhere], '198.51.100.231', both).decision).toBe('refused');
    // A rule of a scope neither audience has does not apply, and an address no rule covers passes.
    expect(decide([api], '203.0.113.10', both).decision).toBe('allowed');
    expect(decide([store], '8.8.8.8', both).decision).toBe('allowed');
    // The audience `other` alone is covered by "all" rules only, as before: a store rule never reaches the merchant portal.
    expect(decide([store], '203.0.113.9', 'other').decision).toBe('allowed');
    expect(decide([store], '203.0.113.9', ['other']).decision).toBe('allowed');
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

describe('shutOut', () => {
  const owner = parseIpAddress('203.0.113.7');
  if (owner === undefined) throw new Error('the test address must parse');
  const compile = (rules: ActiveIpRule[], restricted = false) => compileIpRules({ version: 'v', restricted, rules });
  const shut = (
    before: ActiveIpRule[],
    after: ActiveIpRule[],
    restrictedBefore = false,
    restrictedAfter = restrictedBefore,
  ) => shutOut([owner], compile(before, restrictedBefore), compile(after, restrictedAfter), NOW);

  it('finds an address that a new block of the console or of everything refuses', () => {
    expect(shut([], [rule('block', 'admin', '203.0.113.0/24')])).toEqual([owner]);
    expect(shut([], [rule('block', 'all', '203.0.113.7')])).toEqual([owner]);
    expect(shut([], [rule('block', 'store', '203.0.113.0/24')])).toEqual([]);
  });

  it('finds an address that loses its only allow rule while the restriction is on', () => {
    const entry = rule('allow', 'admin', '203.0.113.0/24');
    const other = rule('allow', 'admin', '192.0.2.0/24');
    expect(shut([entry, other], [other], true)).toEqual([owner]);
    expect(shut([entry, other], [entry], true)).toEqual([]);
  });

  it('finds an address left outside the allow list when the restriction is turned on', () => {
    const elsewhere = rule('allow', 'admin', '192.0.2.0/24');
    expect(shut([elsewhere], [elsewhere], false, true)).toEqual([owner]);
    expect(
      shut(
        [elsewhere, rule('allow', 'admin', '203.0.113.7')],
        [elsewhere, rule('allow', 'admin', '203.0.113.7')],
        false,
        true,
      ),
    ).toEqual([]);
  });

  it('ignores an address that was already refused before the change', () => {
    const block = rule('block', 'admin', '203.0.113.7');
    expect(shut([block], [block, rule('block', 'all', '203.0.113.0/24')])).toEqual([]);
    expect(shut([], [], true)).toEqual([]);
  });

  it('is empty when nothing changes, and for an expired rule', () => {
    const entry = rule('allow', 'admin', '203.0.113.7');
    expect(shut([entry], [entry], true)).toEqual([]);
    const expired = rule('block', 'admin', '203.0.113.7', '2026-03-01T11:59:59.999Z');
    expect(shut([], [expired])).toEqual([]);
  });
});

describe('shutOutNowOrLater', () => {
  const owner = parseIpAddress('203.0.113.7');
  if (owner === undefined) throw new Error('the test address must parse');
  const SOON = '2026-03-01T12:02:00.000Z';
  const compile = (rules: ActiveIpRule[], restricted: boolean) => compileIpRules({ version: 'v', restricted, rules });
  const judge = (
    before: ActiveIpRule[],
    after: ActiveIpRule[],
    restrictedBefore: boolean,
    restrictedAfter = restrictedBefore,
  ) => shutOutNowOrLater([owner], compile(before, restrictedBefore), compile(after, restrictedAfter), NOW);

  it('finds what shutOut finds now', () => {
    expect(judge([], [rule('block', 'admin', '203.0.113.0/24')], false)).toEqual([owner]);
    const entry = rule('allow', 'admin', '203.0.113.7');
    expect(judge([entry], [], true)).toEqual([owner]);
  });

  it('finds an owner who is covered only by an allow rule that runs out when the restriction is turned on', () => {
    const own = rule('allow', 'admin', '203.0.113.50');
    const short = rule('allow', 'admin', '203.0.113.7', SOON);
    expect(shutOut([owner], compile([own, short], false), compile([own, short], true), NOW)).toEqual([]);
    expect(judge([own, short], [own, short], false, true)).toEqual([owner]);
  });

  it('finds an owner who loses the lasting allow rule while a short one still covers the address', () => {
    const lasting = rule('allow', 'admin', '203.0.113.7');
    const short = rule('allow', 'admin', '203.0.113.0/24', SOON);
    const other = rule('allow', 'admin', '203.0.113.50');
    expect(shutOut([owner], compile([lasting, short, other], true), compile([short, other], true), NOW)).toEqual([]);
    expect(judge([lasting, short, other], [short, other], true)).toEqual([owner]);
  });

  it('lets an unrelated change through when an owner is covered only by an allow rule that runs out', () => {
    const short = rule('allow', 'admin', '203.0.113.7', SOON);
    const other = rule('allow', 'admin', '203.0.113.50');
    expect(judge([short, other], [short], true)).toEqual([]);
    expect(judge([short, other], [short, other, rule('block', 'store', '198.51.100.9')], true)).toEqual([]);
    expect(judge([short, other], [short, other], true)).toEqual([]);
  });

  it('lets a lasting rule be added or an unrelated lasting rule be removed', () => {
    const lasting = rule('allow', 'admin', '203.0.113.7');
    const other = rule('allow', 'admin', '203.0.113.50');
    expect(judge([lasting], [lasting, other], true)).toEqual([]);
    expect(judge([lasting, other], [lasting], true)).toEqual([]);
  });

  it('finds an owner whose long allow rule is removed while a short rule still covers the address', () => {
    const MONTH = '2026-03-31T12:00:00.000Z';
    const month = rule('allow', 'admin', '203.0.113.7', MONTH);
    const short = rule('allow', 'admin', '203.0.113.0/29', SOON);
    const other = rule('allow', 'admin', '203.0.113.50');
    // With the short rule present the removal is harmless now but leaves the address refused once the short rule is gone.
    expect(shutOut([owner], compile([month, short, other], true), compile([short, other], true), NOW)).toEqual([]);
    expect(judge([month, short, other], [short, other], true)).toEqual([owner]);
    // Without the short rule the same removal is refused now.
    expect(judge([month, other], [other], true)).toEqual([owner]);
    // The month rule alone, with no other change, is not a reason to refuse an unrelated removal.
    expect(judge([month, short, other], [month, short], true)).toEqual([]);
  });

  it('finds the lasting allow rule removed, and the restriction turned on, while a temporary block hides the address', () => {
    const block = rule('block', 'admin', '203.0.113.7', SOON);
    const lasting = rule('allow', 'admin', '203.0.113.7');
    const other = rule('allow', 'admin', '203.0.113.50');
    // The owner is refused by the block now, so neither change shows at this moment.
    expect(shutOut([owner], compile([lasting, block, other], true), compile([block, other], true), NOW)).toEqual([]);
    expect(judge([lasting, block, other], [block, other], true)).toEqual([owner]);

    expect(shutOut([owner], compile([block, other], false), compile([block, other], true), NOW)).toEqual([]);
    expect(judge([block, other], [block, other], false, true)).toEqual([owner]);
    // With a lasting allow rule for the address the restriction may be turned on.
    expect(judge([block, other, lasting], [block, other, lasting], false, true)).toEqual([]);
  });

  it('finds a second block that outlasts a temporary block over the address', () => {
    const first = rule('block', 'admin', '203.0.113.0/24', SOON);
    const second = rule('block', 'all', '203.0.113.7', '2026-03-01T13:00:00.000Z');
    expect(shutOut([owner], compile([first], false), compile([first, second], false), NOW)).toEqual([]);
    expect(judge([first], [first, second], false)).toEqual([owner]);
    // A second block that ends no later than the first one changes nothing the address could use.
    const within = rule('block', 'admin', '203.0.113.7', '2026-03-01T12:01:00.000Z');
    expect(judge([first], [first, within], false)).toEqual([]);
  });

  it('treats a rule that expires exactly now as gone, and judges a later expiry as the state right after it', () => {
    const other = rule('allow', 'admin', '203.0.113.50');
    const exactlyNow = rule('allow', 'admin', '203.0.113.7', '2026-03-01T12:00:00.000Z');
    expect(judge([exactlyNow, other], [other], true)).toEqual([]);
    // One millisecond later it still counts now, and the removal is found.
    const justAfter = rule('allow', 'admin', '203.0.113.7', '2026-03-01T12:00:00.001Z');
    expect(judge([justAfter, other], [other], true)).toEqual([owner]);
  });
});
