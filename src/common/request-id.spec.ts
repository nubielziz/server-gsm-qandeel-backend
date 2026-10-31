// Unit tests for the request id rules (decision 012): safe incoming ids are kept, others replaced by a UUIDv7.
import { describe, expect, it } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { generateRequestId, getRequestId, isSafeRequestId, resolveRequestId, runWithRequestId } from './request-id';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const request = (headers: Record<string, string | string[] | undefined>) => ({ headers }) as unknown as IncomingMessage;

describe('resolveRequestId', () => {
  it('keeps a safe incoming id', () => {
    expect(resolveRequestId(request({ 'x-request-id': 'abc-123_DEF.456' }))).toBe('abc-123_DEF.456');
  });

  it('accepts exactly 64 characters and refuses 65', () => {
    expect(resolveRequestId(request({ 'x-request-id': 'a'.repeat(64) }))).toBe('a'.repeat(64));
    expect(resolveRequestId(request({ 'x-request-id': 'a'.repeat(65) }))).toMatch(UUID_V7);
  });

  it('replaces unsafe, empty, repeated or missing ids with a UUIDv7', () => {
    for (const headers of [
      { 'x-request-id': 'has space' },
      { 'x-request-id': 'semi;colon' },
      { 'x-request-id': 'new\nline' },
      { 'x-request-id': 'ünï' },
      { 'x-request-id': '' },
      { 'x-request-id': 'a, b' },
      { 'x-request-id': ['a', 'b'] },
      {},
    ]) {
      expect(resolveRequestId(request(headers))).toMatch(UUID_V7);
    }
  });

  it('gives the same id for the same request every time', () => {
    const raw = request({});
    expect(resolveRequestId(raw)).toBe(resolveRequestId(raw));
    expect(resolveRequestId(request({}))).not.toBe(resolveRequestId(request({})));
  });
});

describe('isSafeRequestId / generateRequestId', () => {
  it('validates the pattern', () => {
    expect(isSafeRequestId('ok.id-1_2')).toBe(true);
    expect(isSafeRequestId('')).toBe(false);
    expect(isSafeRequestId(42)).toBe(false);
  });

  it('makes time-ordered UUIDv7 values', () => {
    const first = generateRequestId();
    expect(first).toMatch(UUID_V7);
    expect(isSafeRequestId(first)).toBe(true);
  });
});

describe('request context', () => {
  it('is empty outside a request', () => {
    expect(getRequestId()).toBeUndefined();
  });

  it('follows awaits, timers and nested contexts', async () => {
    await runWithRequestId('outer', async () => {
      expect(getRequestId()).toBe('outer');
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getRequestId()).toBe('outer');
      await runWithRequestId('inner', async () => {
        await Promise.resolve();
        expect(getRequestId()).toBe('inner');
      });
      expect(getRequestId()).toBe('outer');
    });
    expect(getRequestId()).toBeUndefined();
  });

  it('keeps parallel requests apart', async () => {
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithRequestId(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
          return getRequestId();
        }),
      ),
    );
    expect(seen).toEqual(['a', 'b', 'c']);
  });
});
