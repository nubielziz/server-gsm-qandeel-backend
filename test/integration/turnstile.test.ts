// Integration tests of the anti-bot wiring (decision 034): which verifier the configuration selects, that the check runs on the
// contract flag only, and that it counts refusals in the metrics registry.
import { afterAll, describe, expect, it } from 'bun:test';
import { OutboundHttp } from '../../src/infra/http';
import {
  DummyTurnstileVerifier,
  SiteverifyTurnstileVerifier,
  TURNSTILE_VERIFIER,
  TurnstileGuard,
} from '../../src/infra/turnstile';
import { MetricsService } from '../../src/infra/metrics';
import { createTestApp } from '../support/app';
import { TURNSTILE_HEADERS } from '../support/storefront';

const apps: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const app of apps) await app.close();
});

describe('the verifier the configuration selects', () => {
  it('is the dummy verifier without TURNSTILE_SECRET_KEY (development and tests)', async () => {
    const t = await createTestApp();
    apps.push(t);
    expect(t.app.get(TURNSTILE_VERIFIER)).toBeInstanceOf(DummyTurnstileVerifier);
    expect(t.app.get(TurnstileGuard)).toBeDefined();
  });

  it("is the siteverify verifier with a secret, which refuses Cloudflare's dummy token it cannot verify offline", async () => {
    const t = await createTestApp({ env: { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' } });
    apps.push(t);
    expect(t.app.get(TURNSTILE_VERIFIER)).toBeInstanceOf(SiteverifyTurnstileVerifier);
  });
});

describe('the check runs on the contract flag only', () => {
  it('lets a store read through with no token and a flagged write through with the dummy token', async () => {
    const t = await createTestApp();
    apps.push(t);
    const read = await t.app.inject({ method: 'GET', url: '/store/v1/config' });
    expect(read.statusCode).toBe(200);
    const refused = await t.app.inject({ method: 'POST', url: '/store/v1/imei/check', payload: { imei: 'x' } });
    expect(refused.statusCode).toBe(403);
    const passed = await t.app.inject({
      method: 'POST',
      url: '/store/v1/imei/check',
      headers: TURNSTILE_HEADERS,
      payload: { imei: 'x' },
    });
    // The token passed: the body is judged next (the IMEI is not valid).
    expect(passed.statusCode).toBe(422);
  });

  it('counts the refusals by reason', async () => {
    const t = await createTestApp();
    apps.push(t);
    await t.app.inject({ method: 'POST', url: '/store/v1/imei/check', payload: { imei: 'x' } });
    await t.app.inject({
      method: 'POST',
      url: '/store/v1/imei/check',
      headers: { 'x-turnstile-token': 'wrong' },
      payload: { imei: 'x' },
    });
    const text = await t.app.get(MetricsService).registry.metrics();
    expect(text).toContain('turnstile_failures_total{reason="missing"} 1');
    expect(text).toContain('turnstile_failures_total{reason="rejected"} 1');
  });
});

describe('the siteverify verifier over the real outbound HTTP service', () => {
  /** A local stand-in for Cloudflare: records what it was sent and answers as told. */
  function fakeCloudflare(answer: (request: Record<string, unknown>) => { status?: number; body: unknown }) {
    const received: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const payload = (await request.json()) as Record<string, unknown>;
        received.push({ ...payload, contentType: request.headers.get('content-type') });
        const reply = answer(payload);
        return Response.json(reply.body, { status: reply.status ?? 200 });
      },
    });
    return { received, url: `http://127.0.0.1:${server.port}/turnstile/v0/siteverify`, stop: () => server.stop(true) };
  }

  it("posts the JSON the decision names and reads Cloudflare's verdict", async () => {
    const t = await createTestApp();
    apps.push(t);
    const cloudflare = fakeCloudflare((payload) => ({
      body:
        payload.response === 'good-token'
          ? { success: true, hostname: 'shop.example.com' }
          : { success: false, 'error-codes': ['invalid-input-response'] },
    }));
    try {
      const verifier = new SiteverifyTurnstileVerifier({
        secret: 'secret-1',
        hostnames: ['shop.example.com'],
        http: t.app.get(OutboundHttp),
        url: cloudflare.url,
        allowPrivateNetwork: true,
      });
      expect(await verifier.verify('good-token', '203.0.113.7')).toEqual({ ok: true });
      expect(await verifier.verify('bad-token', '203.0.113.7')).toEqual({
        ok: false,
        reason: 'rejected',
        errorCodes: ['invalid-input-response'],
      });
      expect(cloudflare.received[0]).toMatchObject({
        secret: 'secret-1',
        response: 'good-token',
        remoteip: '203.0.113.7',
        contentType: 'application/json',
      });
      expect(String(cloudflare.received[0]?.idempotency_key)).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await cloudflare.stop();
    }
  });

  it('fails closed when Cloudflare answers with an error status or cannot be reached', async () => {
    const t = await createTestApp();
    apps.push(t);
    const broken = fakeCloudflare(() => ({ status: 503, body: { success: true } }));
    const verifier = new SiteverifyTurnstileVerifier({
      secret: 's',
      hostnames: [],
      http: t.app.get(OutboundHttp),
      url: broken.url,
      allowPrivateNetwork: true,
    });
    expect(await verifier.verify('tok', '203.0.113.7')).toEqual({ ok: false, reason: 'bad_response' });
    await broken.stop();
    // Nothing listens any more: a connection failure is a refusal, never a pass.
    expect(await verifier.verify('tok', '203.0.113.7')).toEqual({ ok: false, reason: 'network' });
  });

  it('refuses to call a private address without the test-only switch (the SSRF guard of decision 023)', async () => {
    const t = await createTestApp();
    apps.push(t);
    const cloudflare = fakeCloudflare(() => ({ body: { success: true } }));
    try {
      const verifier = new SiteverifyTurnstileVerifier({
        secret: 's',
        hostnames: [],
        http: t.app.get(OutboundHttp),
        url: cloudflare.url,
      });
      expect(await verifier.verify('tok', '203.0.113.7')).toEqual({ ok: false, reason: 'network' });
      expect(cloudflare.received).toEqual([]);
    } finally {
      await cloudflare.stop();
    }
  });
});
