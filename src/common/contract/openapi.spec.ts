// Unit tests of the operation the OpenAPI document gets from a contract (decision 008, 017): the media type of a body, the rate-limit headers
// of a REST v1 answer and the Dhru surface that never answers problem+json.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineRoute, type RouteKey } from './define-route';
import { buildOperation } from './openapi';
import { zUploadedFile } from './zod';

let counter = 0;
const v1Key = (method = 'GET'): RouteKey => `${method} /v1/spec-openapi-${(counter += 1)}` as RouteKey;
const Dto = z.object({ id: z.number() });

describe('buildOperation: REST v1', () => {
  const route = defineRoute({
    key: v1Key(),
    summary: 'A v1 route',
    tags: ['spec'],
    surface: 'v1',
    access: 'api-key',
    permission: 'orders:read',
    success: { status: 200, schema: Dto },
    errors: ['UNAUTHORIZED', 'RATE_LIMITED', 'NOT_FOUND'],
  });

  it('documents the three RateLimit headers on every response, success and refusals alike', () => {
    const { responses } = buildOperation(route);
    expect(Object.keys(responses)).toEqual(['200', '401', '404', '429']);
    for (const [status, response] of Object.entries(responses)) {
      expect(Object.keys(response.headers ?? {}), status).toEqual(
        expect.arrayContaining(['x-request-id', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']),
      );
    }
    expect(responses['429']!.headers).toHaveProperty('retry-after');
  });

  it('documents problem+json for the refusals, as on every other surface', () => {
    const { responses } = buildOperation(route);
    expect(Object.keys(responses['404']!.content ?? {})).toEqual(['application/problem+json']);
  });
});

describe('buildOperation: other surfaces', () => {
  it('leaves the RateLimit headers off a route that is not an API-key route', () => {
    const route = defineRoute({
      key: 'GET /spec-openapi-system',
      summary: 'A system route',
      tags: ['spec'],
      surface: 'system',
      access: 'public',
      success: { status: 200, schema: Dto },
      errors: ['NOT_FOUND'],
    });
    const { responses } = buildOperation(route);
    expect(responses['200']!.headers).not.toHaveProperty('ratelimit-limit');
    expect(responses['404']!.headers).not.toHaveProperty('ratelimit-limit');
  });
});

describe('buildOperation: the body media type', () => {
  const upload = (bodyType?: 'json' | 'form' | 'multipart') =>
    defineRoute({
      key: v1Key('POST'),
      summary: 'A v1 upload',
      tags: ['spec'],
      surface: 'v1',
      access: 'api-key',
      permission: 'orders:write',
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
        key: v1Key(),
        summary: 'No body',
        tags: ['spec'],
        surface: 'v1',
        access: 'api-key',
        permission: 'orders:read',
        bodyType: 'form',
        success: { status: 200, schema: Dto },
        errors: ['UNAUTHORIZED'],
      } as never),
    ).toThrow('bodyType needs a body schema');
  });
});
