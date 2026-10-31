// Sample route contracts and one controller used by the integration tests. They exercise every behaviour of the
// contract layer and the error filter through real HTTP (Fastify inject). Keys live under /t/ to stay unique.
import { Body, Controller, ForbiddenException, Logger, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type BodyOf,
  ContractHeaders,
  type HeadersOf,
  type ParamsOf,
  type QueryOf,
  type ResultOf,
  Route,
  defineRoute,
  listQuery,
  zId,
  zIdParam,
  zIsoDateTime,
  zJsonObject,
  zMoney,
} from '../../src/common/contract';
import { AppError } from '../../src/common/errors';
import { getRequestId } from '../../src/common/request-id';

export const ItemDto = z.object({ id: zId, name: z.string(), price: zMoney, createdAt: zIsoDateTime });
const item = (id: number) => ({ id, name: `Item ${id}`, price: '12.4900', createdAt: '2026-03-01T09:30:00.000Z' });

export const showItem = defineRoute({
  key: 'GET /t/items/:id',
  summary: 'Show an item',
  description: 'Returns one item. Sample route for the contract tests.',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: ItemDto },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: item(1) },
});

export const createItem = defineRoute({
  key: 'POST /t/items',
  summary: 'Create an item',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  body: z.object({
    name: z.string().min(1),
    price: zMoney,
    lines: z.array(z.object({ imei: z.string().length(15) })).optional(),
  }),
  success: { status: 201, schema: ItemDto },
  errors: ['VALIDATION_FAILED', 'EMAIL_TAKEN'],
  examples: { request: { name: 'Phone', price: '99.0000' }, response: item(2) },
});

export const deleteItem = defineRoute({
  key: 'DELETE /t/items/:id',
  summary: 'Delete an item',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['NOT_FOUND'],
});

export const listItems = defineRoute({
  key: 'GET /t/items',
  summary: 'List items',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  query: listQuery({
    sorts: ['name', 'createdAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: ['active', 'suspended'] },
      createdAt: { type: 'datetime' },
      'role.id': { type: 'id' },
      name: { type: 'string' },
    },
    search: ['name'],
    extra: { open: z.stringbool().optional() },
  }),
  success: { status: 200, schema: z.object({ id: zId, name: z.string() }) },
  errors: ['VALIDATION_FAILED'],
  examples: { response: [{ id: 1, name: 'Item 1' }] },
});

export const echoHeaders = defineRoute({
  key: 'POST /t/headers',
  summary: 'Echo a header',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  headers: z.object({ 'idempotency-key': z.string().min(8) }),
  success: { status: 200, schema: z.object({ key: z.string() }) },
  errors: ['VALIDATION_FAILED'],
});

export const csvReport = defineRoute({
  key: 'GET /t/report',
  summary: 'Download a CSV report',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  success: { status: 200, contentType: 'text/csv' },
  errors: [],
});

export const brokenItem = defineRoute({
  key: 'GET /t/broken',
  summary: 'Returns a body that violates its contract',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  success: { status: 200, schema: ItemDto },
  errors: [],
});

export const brokenList = defineRoute({
  key: 'GET /t/broken-list',
  summary: 'A list handler that forgets the total',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  query: listQuery({ sorts: ['name'], defaultSort: { field: 'name', order: 'asc' } }),
  success: { status: 200, schema: ItemDto },
  errors: [],
});

const plain = (key: `GET /t/${string}`, summary: string) =>
  defineRoute({
    key,
    summary,
    tags: ['test'],
    surface: 'system',
    access: 'public',
    success: { status: 200, schema: z.object({ ok: z.boolean() }) },
    errors: [],
  });
export const boom = plain('GET /t/boom', 'Throws an unexpected error');
export const appError = plain('GET /t/app-error', 'Throws an AppError with field errors');
export const rateLimited = plain('GET /t/rate-limited', 'Throws RATE_LIMITED');
export const httpException = plain('GET /t/http-exception', 'Throws a Nest ForbiddenException');
export const dbDown = plain('GET /t/db-down', 'Throws DATABASE_UNAVAILABLE');

export const whoAmI = defineRoute({
  key: 'GET /t/request-id',
  summary: 'Returns the request id the handler sees',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  success: { status: 200, schema: z.object({ requestId: z.string().nullable() }) },
  errors: [],
});

export const whoAmIAfterBody = defineRoute({
  key: 'POST /t/request-id',
  summary: 'Returns the request id the handler sees after a JSON body was parsed',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  body: zJsonObject,
  success: { status: 200, schema: z.object({ requestId: z.string().nullable(), keys: z.number() }) },
  errors: ['VALIDATION_FAILED'],
});

export const clientIp = defineRoute({
  key: 'GET /t/ip',
  summary: 'Returns the client ip',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  success: { status: 200, schema: z.object({ ip: z.string() }) },
  errors: [],
});

export const anyBody = defineRoute({
  key: 'POST /t/any-body',
  summary: 'Accepts any JSON object',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  body: zJsonObject,
  success: { status: 200, schema: z.object({ keys: z.number() }) },
  errors: ['VALIDATION_FAILED'],
});

export const dhruLike = defineRoute({
  key: 'POST /api/index.php',
  summary: 'A route on the Dhru surface',
  tags: ['test'],
  surface: 'dhru',
  access: 'dhru-credentials',
  body: z.object({ action: z.string() }),
  success: { status: 200, schema: z.object({ SUCCESS: z.array(z.unknown()) }) },
  errors: ['FORBIDDEN'],
});

export const staffOnly = defineRoute({
  key: 'GET /admin/t/secure',
  summary: 'A staff route (the guard dispatcher enforces its permission)',
  tags: ['test'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'staff:read',
  success: { status: 200, schema: z.object({ ok: z.boolean() }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
});

/** Handlers for the sample contracts. */
@Controller()
export class TestController {
  private readonly log = new Logger('TestController');

  @Route(showItem)
  show(@Param() params: ParamsOf<typeof showItem>): ResultOf<typeof showItem> {
    if (params.id === 404) throw new AppError('NOT_FOUND', { detail: 'Item 404 does not exist.' });
    // passwordHash is not in the contract: the response schema must strip it.
    return { ...item(params.id), passwordHash: 'must-not-leak' } as ResultOf<typeof showItem>;
  }

  @Route(createItem)
  create(@Body() body: BodyOf<typeof createItem>): ResultOf<typeof createItem> {
    if (body.name === 'taken')
      throw new AppError('EMAIL_TAKEN', {
        detail: 'Name is taken.',
        errors: [{ field: 'name', code: 'taken', message: 'Already used' }],
      });
    return { ...item(7), name: body.name, price: body.price };
  }

  @Route(deleteItem)
  remove(@Param() params: ParamsOf<typeof deleteItem>): void {
    if (params.id === 404) throw new AppError('NOT_FOUND');
  }

  @Route(listItems)
  list(@Query() query: QueryOf<typeof listItems>): ResultOf<typeof listItems> {
    return { rows: [{ id: 1, name: JSON.stringify(query) }], total: 123 };
  }

  @Route(echoHeaders)
  headers(@ContractHeaders() headers: HeadersOf<typeof echoHeaders>): ResultOf<typeof echoHeaders> {
    return { key: headers['idempotency-key'] };
  }

  @Route(csvReport)
  report(): string {
    return 'id,name\n1,Item 1\n';
  }

  @Route(brokenItem)
  broken(): unknown {
    return { id: 'not-a-number', name: 5 };
  }

  @Route(brokenList)
  brokenList(): unknown {
    return [item(1)];
  }

  @Route(boom)
  boom(): never {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
  }

  @Route(appError)
  appError(): never {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Two fields are not valid.',
      errors: [
        { field: 'email', code: 'invalid_format', message: 'Not an email' },
        { field: 'items.0.imei', code: 'too_small', message: 'Too short' },
      ],
    });
  }

  @Route(rateLimited)
  rateLimited(): never {
    throw new AppError('RATE_LIMITED', { retryAfterSeconds: 30 });
  }

  @Route(httpException)
  httpException(): never {
    throw new ForbiddenException('You need the staff:read permission.');
  }

  @Route(dbDown)
  dbDown(): never {
    throw new AppError('DATABASE_UNAVAILABLE', { detail: 'The database is not accepting connections.' });
  }

  @Route(whoAmI)
  whoAmI(): ResultOf<typeof whoAmI> {
    // Logged with the Nest logger and no explicit id: the mixin must add requestId.
    this.log.warn('whoAmI handler ran');
    return { requestId: getRequestId() ?? null };
  }

  @Route(whoAmIAfterBody)
  whoAmIAfterBody(@Body() body: BodyOf<typeof whoAmIAfterBody>): ResultOf<typeof whoAmIAfterBody> {
    // Body parsing is asynchronous: the async context must survive it.
    this.log.warn('whoAmIAfterBody handler ran');
    return { requestId: getRequestId() ?? null, keys: Object.keys(body).length };
  }

  @Route(clientIp)
  clientIp(@Req() request: FastifyRequest): ResultOf<typeof clientIp> {
    return { ip: request.ip };
  }

  @Route(anyBody)
  anyBody(@Body() body: BodyOf<typeof anyBody>): ResultOf<typeof anyBody> {
    return { keys: Object.keys(body).length };
  }

  @Route(dhruLike)
  dhru(): never {
    throw new AppError('FORBIDDEN', { detail: 'Authentication Failed' });
  }

  @Route(staffOnly)
  staffOnly(): ResultOf<typeof staffOnly> {
    return { ok: true };
  }
}
