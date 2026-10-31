// Integration tests of TRUST_PROXY: which proxies may set X-Forwarded-For. A hop count needs our own trust function
// because Fastify 5.12 ignores numbers; a CIDR list validates the nearest peer.
import { afterAll, describe, expect, it } from 'bun:test';
import { toFastifyTrustProxy } from '../../src/app.bootstrap';
import { type TestApp, createTestApp } from '../support/app';
import { TestController } from '../support/routes';

const apps: TestApp[] = [];
async function ipSeenBy(env: Record<string, string>, peer: string, forwardedFor?: string): Promise<string> {
  const t = await createTestApp({ controllers: [TestController], env });
  apps.push(t);
  const res = await t.app.inject({
    method: 'GET',
    url: '/t/ip',
    remoteAddress: peer,
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });
  return res.json().ip;
}
afterAll(async () => {
  await Promise.all(apps.map((t) => t.close()));
});

describe('request.ip', () => {
  it('ignores X-Forwarded-For when no proxy is trusted (default)', async () => {
    expect(await ipSeenBy({}, '10.0.0.1', '203.0.113.9')).toBe('10.0.0.1');
  });

  it('with a hop count of 1, takes the address the nearest proxy saw', async () => {
    expect(await ipSeenBy({ TRUST_PROXY: '1' }, '10.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('with a hop count of 1, a client-forged chain cannot override the proxy-appended address', async () => {
    expect(await ipSeenBy({ TRUST_PROXY: '1' }, '10.0.0.1', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('with a hop count of 2, trusts two hops', async () => {
    expect(await ipSeenBy({ TRUST_PROXY: '2' }, '10.0.0.1', '203.0.113.9, 10.0.0.2')).toBe('203.0.113.9');
  });

  it('with a CIDR list, trusts only those proxies', async () => {
    expect(await ipSeenBy({ TRUST_PROXY: '10.0.0.0/8' }, '10.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(await ipSeenBy({ TRUST_PROXY: '10.0.0.0/8' }, '192.168.1.1', '203.0.113.9')).toBe('192.168.1.1');
  });

  it('understands the named ranges', async () => {
    expect(await ipSeenBy({ TRUST_PROXY: 'loopback' }, '127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(await ipSeenBy({ TRUST_PROXY: 'loopback' }, '10.0.0.1', '203.0.113.9')).toBe('10.0.0.1');
  });
});

describe('toFastifyTrustProxy', () => {
  it('maps the configured value to what Fastify accepts', () => {
    expect(toFastifyTrustProxy(false)).toBe(false);
    expect(toFastifyTrustProxy(['10.0.0.0/8', 'loopback'])).toEqual(['10.0.0.0/8', 'loopback']);
    const hops = toFastifyTrustProxy(2) as (address: string, hop: number) => boolean;
    expect([hops('x', 0), hops('x', 1), hops('x', 2)]).toEqual([true, true, false]);
  });
});
