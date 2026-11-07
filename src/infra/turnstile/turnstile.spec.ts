// Unit tests of the anti-bot check (decision 034): the dummy verifier, the siteverify verifier with a stand-in for OutboundHttp,
// and the guard with a fake execution context. No network, no database.
import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { z } from 'zod';
import { defineRoute } from '../../common/contract';
import { CONTRACT_METADATA } from '../../common/contract/route.decorator';
import { AppError } from '../../common/errors';
import { HttpRequestError, type HttpResult, type OutboundRequestOptions } from '../http';
import { MetricsService } from '../metrics';
import { DummyTurnstileVerifier } from './dummy-turnstile.verifier';
import { SITEVERIFY_URL, SiteverifyTurnstileVerifier } from './siteverify-turnstile.verifier';
import { TurnstileGuard } from './turnstile.guard';
import {
  TURNSTILE_DUMMY_TOKEN,
  TURNSTILE_MAX_TOKEN_LENGTH,
  type TurnstileResult,
  type TurnstileVerifier,
} from './turnstile-verifier';

/** An HTTP answer with a JSON body. */
function answer(status: number, body: unknown): HttpResult {
  const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    body: bytes,
    durationMs: 1,
    text: () => new TextDecoder().decode(bytes),
    json: <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
  };
}

/** A stand-in for OutboundHttp that records the calls and plays back one reply. */
function fakeHttp(reply: () => HttpResult | Error) {
  const calls: OutboundRequestOptions[] = [];
  return {
    calls,
    http: {
      request: (options: OutboundRequestOptions) => {
        calls.push(options);
        const outcome = reply();
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
    },
  };
}

describe('DummyTurnstileVerifier', () => {
  it("accepts only Cloudflare's dummy token", async () => {
    const verifier = new DummyTurnstileVerifier();
    expect(await verifier.verify(TURNSTILE_DUMMY_TOKEN, '203.0.113.9')).toEqual({ ok: true });
    expect(await verifier.verify('anything-else', '203.0.113.9')).toEqual({ ok: false, reason: 'rejected' });
    expect(await verifier.verify(TURNSTILE_DUMMY_TOKEN.toLowerCase(), '203.0.113.9')).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });
});

describe('SiteverifyTurnstileVerifier', () => {
  const make = (reply: () => HttpResult | Error, hostnames: string[] = []) => {
    const fake = fakeHttp(reply);
    return { fake, verifier: new SiteverifyTurnstileVerifier({ secret: 's3cret', hostnames, http: fake.http }) };
  };

  it('posts the secret, token, address and a fresh idempotency key as JSON to the siteverify endpoint', async () => {
    const { fake, verifier } = make(() => answer(200, { success: true, hostname: 'shop.example.com' }));
    expect(await verifier.verify('tok-1', '198.51.100.7')).toEqual({ ok: true });
    await verifier.verify('tok-2', '198.51.100.7');
    const [first, second] = fake.calls;
    expect(first?.url).toBe(SITEVERIFY_URL);
    expect(first?.method).toBe('POST');
    expect(first?.timeoutMs).toBe(5000);
    expect(first?.target).toBe('turnstile');
    const body = JSON.parse(String(first?.body)) as Record<string, string>;
    expect(body).toMatchObject({ secret: 's3cret', response: 'tok-1', remoteip: '198.51.100.7' });
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(second?.body)).idempotency_key).not.toBe(body.idempotency_key);
  });

  it('refuses a token Cloudflare rejects and keeps its error codes for the log', async () => {
    const { verifier } = make(() => answer(200, { success: false, 'error-codes': ['timeout-or-duplicate', 7] }));
    expect(await verifier.verify('tok', '198.51.100.7')).toEqual({
      ok: false,
      reason: 'rejected',
      errorCodes: ['timeout-or-duplicate'],
    });
  });

  it('checks the hostname only when a list is configured', async () => {
    const ok = make(() => answer(200, { success: true, hostname: 'Shop.Example.com' }), ['shop.example.com']);
    expect(await ok.verifier.verify('tok', '198.51.100.7')).toEqual({ ok: true });
    const wrong = make(() => answer(200, { success: true, hostname: 'evil.example.net' }), ['shop.example.com']);
    expect(await wrong.verifier.verify('tok', '198.51.100.7')).toEqual({ ok: false, reason: 'hostname' });
    const missing = make(() => answer(200, { success: true }), ['shop.example.com']);
    expect(await missing.verifier.verify('tok', '198.51.100.7')).toEqual({ ok: false, reason: 'hostname' });
    const anyHost = make(() => answer(200, { success: true, hostname: 'evil.example.net' }));
    expect(await anyHost.verifier.verify('tok', '198.51.100.7')).toEqual({ ok: true });
  });

  it('fails closed on a timeout, a network failure, an error status and an unreadable answer', async () => {
    const timeout = make(() => new HttpRequestError('timeout', 'slow'));
    expect(await timeout.verifier.verify('tok', '198.51.100.7')).toEqual({ ok: false, reason: 'timeout' });
    const network = make(() => new HttpRequestError('network', 'down'));
    expect(await network.verifier.verify('tok', '198.51.100.7')).toEqual({ ok: false, reason: 'network' });
    const blocked = make(() => new HttpRequestError('blocked', 'nope'));
    expect(await blocked.verifier.verify('tok', '198.51.100.7')).toEqual({ ok: false, reason: 'network' });
    const status = make(() => answer(500, { success: true }));
    expect(await status.verifier.verify('tok', '198.51.100.7')).toEqual({ ok: false, reason: 'bad_response' });
    for (const text of ['<html>', 'null', '[]', '"yes"']) {
      const garbage = make(() => answer(200, text));
      expect(await garbage.verifier.verify('tok', '198.51.100.7')).toEqual({ ok: false, reason: 'bad_response' });
    }
  });

  it('treats anything but success:true as a refusal', async () => {
    for (const success of ['true', 1, null, undefined]) {
      const { verifier } = make(() => answer(200, { success }));
      expect((await verifier.verify('tok', '198.51.100.7')).ok).toBe(false);
    }
  });
});

describe('TurnstileGuard', () => {
  const plain = defineRoute({
    key: 'GET /store/v1/spec-guard-plain',
    summary: 'No anti-bot check',
    tags: ['spec'],
    surface: 'store',
    access: 'public',
    success: { status: 200, schema: z.object({ ok: z.boolean() }) },
    errors: [],
  });
  const guarded = defineRoute({
    key: 'POST /store/v1/spec-guard-checked',
    summary: 'With the anti-bot check',
    tags: ['spec'],
    surface: 'store',
    access: 'public',
    turnstile: true,
    body: z.object({ email: z.string() }),
    success: { status: 201, schema: z.object({ ok: z.boolean() }) },
    errors: [],
  });

  /** A context whose handler carries the contract and whose request carries the headers. */
  function context(contract: typeof plain | typeof guarded, headers: Record<string, string | string[]>) {
    const handler = () => undefined;
    Reflect.defineMetadata(CONTRACT_METADATA, contract, handler);
    return {
      getType: () => 'http',
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ headers, ip: '198.51.100.7' }) }),
    } as unknown as ExecutionContext;
  }

  function guardWith(verify: TurnstileVerifier['verify']) {
    const calls: Array<{ token: string; ip: string }> = [];
    const verifier: TurnstileVerifier = {
      verify: (token, ip) => {
        calls.push({ token, ip });
        return verify(token, ip);
      },
    };
    return { calls, guard: new TurnstileGuard(verifier, new MetricsService()) };
  }

  const refusal = async (promise: Promise<unknown>): Promise<AppError> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('lets a route without the flag through and never asks the verifier', async () => {
    const { calls, guard } = guardWith(() => Promise.resolve({ ok: false, reason: 'rejected' }));
    expect(await guard.canActivate(context(plain, {}))).toBe(true);
    expect(calls).toEqual([]);
  });

  it('refuses a missing, empty, blank, repeated or over-long token without an outbound call', async () => {
    const { calls, guard } = guardWith(() => Promise.resolve({ ok: true }));
    const bad: Array<Record<string, string | string[]>> = [
      {},
      { 'x-turnstile-token': '' },
      { 'x-turnstile-token': '   ' },
      { 'x-turnstile-token': ['a', 'b'] },
      { 'x-turnstile-token': 'x'.repeat(TURNSTILE_MAX_TOKEN_LENGTH + 1) },
    ];
    for (const headers of bad) {
      const error = await refusal(guard.canActivate(context(guarded, headers)));
      expect(error.code).toBe('TURNSTILE_FAILED');
      expect(error.status).toBe(403);
      expect(error.detail).toBe('The anti-bot check failed. Refresh the page and try again.');
    }
    expect(calls).toEqual([]);
  });

  it('accepts a token of exactly the maximum length when the verifier passes it', async () => {
    const { calls, guard } = guardWith(() => Promise.resolve({ ok: true }));
    const token = 'x'.repeat(TURNSTILE_MAX_TOKEN_LENGTH);
    expect(await guard.canActivate(context(guarded, { 'x-turnstile-token': token }))).toBe(true);
    expect(calls).toEqual([{ token, ip: '198.51.100.7' }]);
  });

  it("asks the verifier with the trimmed token and the request's address", async () => {
    const { calls, guard } = guardWith(() => Promise.resolve({ ok: true }));
    await guard.canActivate(context(guarded, { 'x-turnstile-token': '  tok  ' }));
    expect(calls).toEqual([{ token: 'tok', ip: '198.51.100.7' }]);
  });

  it('answers every verifier refusal the same way, whatever the reason', async () => {
    for (const reason of ['rejected', 'hostname', 'timeout', 'network', 'bad_response'] as const) {
      const outcome: TurnstileResult = { ok: false, reason };
      const { guard } = guardWith(() => Promise.resolve(outcome));
      const error = await refusal(guard.canActivate(context(guarded, { 'x-turnstile-token': 'tok' })));
      expect(error.code).toBe('TURNSTILE_FAILED');
      expect(error.detail).toBe('The anti-bot check failed. Refresh the page and try again.');
    }
  });

  it('counts the refusals by reason and never puts the token in the metric', async () => {
    const metrics = new MetricsService();
    const guard = new TurnstileGuard({ verify: () => Promise.resolve({ ok: false, reason: 'rejected' }) }, metrics);
    await refusal(guard.canActivate(context(guarded, { 'x-turnstile-token': 'secret-token-value' })));
    await refusal(guard.canActivate(context(guarded, {})));
    const text = await metrics.registry.metrics();
    expect(text).toContain('turnstile_failures_total{reason="rejected"} 1');
    expect(text).toContain('turnstile_failures_total{reason="missing"} 1');
    expect(text).not.toContain('secret-token-value');
  });
});
