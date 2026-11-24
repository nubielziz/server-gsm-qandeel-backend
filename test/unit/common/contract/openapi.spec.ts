// Unit tests of the operation the OpenAPI document gets from a contract (decision 008, 017): the media type of a body and the Dhru
// surface that never answers problem+json.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineRoute, type RouteKey } from '@src/common/contract/define-route';
import { buildOperation } from '@src/common/contract/openapi';
import { zUploadedFile } from '@src/common/contract/zod';

let counter = 0;
const clientKey = (method = 'GET'): RouteKey => `${method} /client/spec-openapi-${(counter += 1)}` as RouteKey;
const Dto = z.object({ id: z.number() });

describe('buildOperation: the responses', () => {
  const route = defineRoute({
    key: clientKey(),
    summary: 'A portal route',
    tags: ['spec'],
    surface: 'client',
    access: 'merchant-session',
    success: { status: 200, schema: Dto },
    errors: ['UNAUTHORIZED', 'RATE_LIMITED', 'NOT_FOUND'],
  });

  it('documents the request id on every response, and Retry-After on the 429', () => {
    const { responses } = buildOperation(route);
    expect(Object.keys(responses)).toEqual(['200', '401', '404', '429']);
    for (const [status, response] of Object.entries(responses)) {
      expect(Object.keys(response.headers ?? {}), status).toContain('x-request-id');
    }
    expect(responses['429']!.headers).toHaveProperty('retry-after');
  });

  it('documents no per-key RateLimit header: the REST API v1 that sent them is retired', () => {
    const { responses } = buildOperation(route);
    for (const [status, response] of Object.entries(responses)) {
      expect(response.headers, status).not.toHaveProperty('ratelimit-limit');
      expect(response.headers, status).not.toHaveProperty('ratelimit-remaining');
      expect(response.headers, status).not.toHaveProperty('ratelimit-reset');
    }
  });

  it('documents problem+json for the refusals', () => {
    const { responses } = buildOperation(route);
    expect(Object.keys(responses['404']!.content ?? {})).toEqual(['application/problem+json']);
  });
});

describe('buildOperation: the body media type', () => {
  const upload = (bodyType?: 'json' | 'form' | 'multipart') =>
    defineRoute({
      key: clientKey('POST'),
      summary: 'A portal upload',
      tags: ['spec'],
      surface: 'client',
      access: 'merchant-session',
      body: z.object({ file: zUploadedFile }),
      ...(bodyType === undefined ? {} : { bodyType }),
      success: { status: 201, schema: Dto },
      errors: ['UNAUTHORIZED'],
    });

  it('is application/json unless the contract says otherwise', () => {
    expect(buildOperation(upload()).requestBody?.mediaType).toBe('application/json');
    expect(buildOperation(upload('form')).requestBody?.mediaType).toBe('application/x-www-form-urlencoded');
    expect(buildOperation(upload('multipart')).requestBody?.mediaType).toBe('multipart/form-data');
  });

  it('describes an uploaded file as a binary string', () => {
    const schema = buildOperation(upload('multipart')).requestBody?.schema as { properties: Record<string, unknown> };
    expect(schema.properties.file).toMatchObject({ type: 'string', format: 'binary' });
  });
});

describe('defineRoute: bodyType', () => {
  it('needs a body schema', () => {
    expect(() =>
      defineRoute({
        key: clientKey(),
        summary: 'No body',
        tags: ['spec'],
        surface: 'client',
        access: 'merchant-session',
        bodyType: 'form',
        success: { status: 200, schema: Dto },
        errors: ['UNAUTHORIZED'],
      } as never),
    ).toThrow('bodyType needs a body schema');
  });
});
