// Unit tests of the IP rules hook with a fake rule cache: what it refuses, what it counts, what it never judges, and that it
// fails closed when the rules cannot be read.
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../../common/errors';
import type { RequestPipeline } from '../../../../common/pipeline';
import { TestClock } from '../../../../../test/support/clock';
import { expectRejection } from '../../../../../test/support/rejection';
import { type ActiveIpRule, type CompiledIpRules, compileIpRules } from './ip-rule-matcher';
import type { IpRuleCache } from './ip-rule-cache';
import type { IpRuleHits } from './ip-rule-hits';
import { IpRulesHook, clientAddressOf } from './ip-rules.hook';

const rules = (restricted: boolean, list: ActiveIpRule[]): CompiledIpRules =>
  compileIpRules({ version: 'v', restricted, rules: list });

/** A hook over a fake cache; `hits` collects the rule ids it counted. */
function hookWith(compiled: CompiledIpRules | Error) {
  const hits: number[] = [];
  const cache = { get: () => (compiled instanceof Error ? Promise.reject(compiled) : Promise.resolve(compiled)) };
  const registered: Array<{ stage: string }> = [];
  const pipeline = { register: (stage: string) => void registered.push({ stage }) } as unknown as RequestPipeline;
  const hook = new IpRulesHook(
    pipeline,
    cache as unknown as IpRuleCache,
    { record: (id: number) => void hits.push(id) } as unknown as IpRuleHits,
    new TestClock('2026-11-01T10:00:00.000Z'),
  );
  return { hook, hits, registered };
}

const request = (url: string, ip: string, template?: string) =>
  ({ url, ip, routeOptions: template ? { url: template } : {} }) as unknown as FastifyRequest;

const block = { id: 7, kind: 'block', scope: 'all', cidr: '203.0.113.9/32', expiresAt: null } as const;
const allow = { id: 8, kind: 'allow', scope: 'admin', cidr: '198.51.100.5/32', expiresAt: null } as const;

describe('IpRulesHook', () => {
  it('registers the ip-rules stage', () => {
    const { hook, registered } = hookWith(rules(false, []));
    hook.onModuleInit();
    expect(registered).toEqual([{ stage: 'ip-rules' }]);
  });

  it('refuses a blocked address with 403 IP_NOT_ALLOWED, names the address and counts the hit', async () => {
    const { hook, hits } = hookWith(rules(false, [block]));
    const refusal = (await expectRejection(hook.handle(request('/store/v1/x', '203.0.113.9')))) as AppError;
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal.code).toBe('IP_NOT_ALLOWED');
    expect(refusal.status).toBe(403);
    expect(refusal.detail).toBe('Your network address (203.0.113.9) is blocked.');
    expect(hits).toEqual([7]);
  });

  it('refuses an unlisted address on the restricted admin console, without a hit', async () => {
    const { hook, hits } = hookWith(rules(true, [allow]));
    const refusal = (await expectRejection(hook.handle(request('/admin/staff', '8.8.8.8')))) as AppError;
    expect(refusal.code).toBe('IP_NOT_ALLOWED');
    expect(refusal.detail).toContain('not on the list of addresses allowed to use the admin console');
    expect(hits).toEqual([]);
  });

  it('counts a hit when an allow rule lets an address in', async () => {
    const { hook, hits } = hookWith(rules(true, [allow]));
    await hook.handle(request('/admin/staff', '198.51.100.5'));
    expect(hits).toEqual([8]);
  });

  it('lets an open request through without a hit', async () => {
    const { hook, hits } = hookWith(rules(false, [block]));
    await hook.handle(request('/store/v1/x', '8.8.8.8'));
    expect(hits).toEqual([]);
  });

  it('never judges /health and /metrics, even for a blocked address', async () => {
    const { hook, hits } = hookWith(rules(true, [block]));
    await hook.handle(request('/health', '203.0.113.9', '/health'));
    await hook.handle(request('/metrics', '203.0.113.9', '/metrics'));
    expect(hits).toEqual([]);
  });

  it('judges a matched route by its template, so an escaped spelling cannot dodge a rule', async () => {
    const adminBlock = { id: 9, kind: 'block', scope: 'admin', cidr: '203.0.113.9/32', expiresAt: null } as const;
    const { hook } = hookWith(rules(false, [adminBlock]));
    await expectRejection(hook.handle(request('/%61dmin/staff/12?x=1', '203.0.113.9', '/admin/staff/:id')));
    // An unknown route is judged by its decoded path.
    await expectRejection(hook.handle(request('/%61dmin/nope', '203.0.113.9')));
  });

  it('fails closed with 503 DATABASE_UNAVAILABLE when the rules cannot be read', async () => {
    const { hook } = hookWith(new Error('connect ECONNREFUSED'));
    const refusal = (await expectRejection(hook.handle(request('/store/v1/x', '8.8.8.8')))) as AppError;
    expect(refusal.code).toBe('DATABASE_UNAVAILABLE');
    expect(refusal.status).toBe(503);
    expect(refusal.cause).toBeInstanceOf(Error);
    // ... but a probe is not judged at all, so it does not need the rules.
    await hook.handle(request('/health', '8.8.8.8', '/health'));
  });

  it('judges an address it cannot read: refused on the restricted admin console, open elsewhere', async () => {
    const { hook } = hookWith(rules(true, [allow]));
    await expectRejection(hook.handle(request('/admin/staff', 'not-an-ip')));
    await hook.handle(request('/store/v1/x', 'not-an-ip'));
  });
});

describe('clientAddressOf', () => {
  it('parses request.ip and folds a mapped address into IPv4', () => {
    expect(clientAddressOf({ ip: '203.0.113.9' })?.family).toBe(4);
    expect(clientAddressOf({ ip: '::ffff:203.0.113.9' })).toEqual(clientAddressOf({ ip: '203.0.113.9' }));
    expect(clientAddressOf({ ip: '2001:db8::1' })?.family).toBe(6);
  });

  it('is undefined for text that is not an address', () => {
    expect(clientAddressOf({ ip: '' })).toBeUndefined();
    expect(clientAddressOf({ ip: '<script>' })).toBeUndefined();
    expect(clientAddressOf({ ip: undefined as unknown as string })).toBeUndefined();
  });
});
