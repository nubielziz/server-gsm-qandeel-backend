// OpenAPI 3.1 metadata of a route contract (decision 008, 017): the operation, its parameters, body, responses and
// security, built as plain data and applied with @nestjs/swagger decorators. The platform module's docs collect them
// into the documents (src/modules/platform/docs).
import {
  ApiBody,
  ApiExtension,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ERROR_CATALOG, problemSlug, type ErrorCode } from '../errors/catalog';
import { type AccessKind, type AnyRouteContract, isSessionAccess } from './define-route';
import { toJsonSchema, type JsonSchema } from './json-schema';
import { isListQuerySchema, listQueryParameters } from './list-query';

/**
 * Security scheme name used in `security` for each access kind; the schemes themselves are defined in
 * `src/modules/platform/docs/security-schemes.ts`.
 *
 * Why: the docs name how each access kind authenticates (decisions 017, 018).
 */
export const SECURITY_SCHEME: Readonly<Record<AccessKind, string | undefined>> = {
  public: undefined,
  'staff-session': 'staffSession',
  'staff-permission': 'staffSession',
  'merchant-session': 'merchantSession',
  'customer-session': 'customerSession',
  'api-key': 'apiKey',
  'dhru-credentials': 'dhruCredentials',
  'gateway-signature': 'gatewaySignature',
  'url-secret': 'urlSecret',
  'checkout-token': 'capabilityToken',
  'tracking-token': 'capabilityToken',
  'link-token': 'capabilityToken',
  'ticket-token': 'capabilityToken',
  'internal-or-token': 'metricsAccess',
};

/**
 * A documented parameter.
 *
 * Why: OpenAPI parameters are built as plain data first, so the document can be unit-tested without Nest (decision
 * 008).
 */
export interface OperationParameter {
  readonly in: 'path' | 'query' | 'header';
  readonly name: string;
  readonly required: boolean;
  readonly description: string | undefined;
  readonly schema: JsonSchema;
  /** Repeating the key is allowed (query only). */
  readonly repeatable: boolean;
}

/**
 * A documented response.
 *
 * Why: OpenAPI responses are built as plain data first, so the document can be unit-tested without Nest (decision 008).
 */
export interface OperationResponse {
  readonly description: string;
  readonly content?: Record<
    string,
    { schema: JsonSchema; example?: unknown; examples?: Record<string, { summary: string; value: unknown }> }
  >;
  readonly headers?: Record<string, { description: string; schema: JsonSchema }>;
}

/**
 * Everything the decorators need, as plain data (unit-testable without Nest).
 *
 * Why: documentation is generated from the contract that validates requests, so it cannot drift; plain data keeps it
 * testable without Nest (decision 008).
 */
export interface OperationParts {
  readonly operationId: string;
  readonly parameters: readonly OperationParameter[];
  readonly requestBody: { readonly schema: JsonSchema; readonly example: unknown } | undefined;
  readonly responses: Readonly<Record<string, OperationResponse>>;
  readonly security: string | undefined;
}

const REQUEST_ID_HEADER = {
  'x-request-id': {
    description: 'Id of this request; quote it when you report a problem.',
    schema: { type: 'string' },
  },
};

/** The shape of every error body (decision 028). */
const PROBLEM_PROPERTIES: Record<string, JsonSchema> = {
  type: { type: 'string', format: 'uri', description: 'Link that identifies the problem type.' },
  title: { type: 'string', description: 'Fixed English title of the code.' },
  status: { type: 'integer' },
  code: { type: 'string' },
  detail: { type: 'string', description: 'What went wrong this time.' },
  errors: {
    type: 'array',
    description: 'Field problems; `field` is a dotted path equal to the request key.',
    items: {
      type: 'object',
      required: ['field', 'code', 'message'],
      properties: { field: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } },
    },
  },
  requestId: { type: 'string' },
};

/**
 * Builds a stable `operationId` from a route key.
 *
 * Why: OpenAPI needs a unique operationId; one derived from the manifest key survives handler renames.
 *
 * @param key e.g. `POST /admin/staff/:id/suspend`
 * @returns e.g. `postAdminStaffByIdSuspend`
 */
export function operationIdOf(key: string): string {
  const [method = '', path = '/'] = key.split(' ');
  const words = path
    .split('/')
    .filter(Boolean)
    .flatMap((segment) =>
      segment.startsWith(':') ? ['By', ...segment.slice(1).split(/[^A-Za-z0-9]+/)] : segment.split(/[^A-Za-z0-9]+/),
    )
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return method.toLowerCase() + words.join('');
}

function objectProperties(schema: z.ZodType, location: 'path' | 'header'): OperationParameter[] {
  const json = toJsonSchema(schema, 'input') as { properties?: Record<string, JsonSchema>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    in: location,
    name,
    required: location === 'path' || (json.required ?? []).includes(name),
    description: typeof property.description === 'string' ? property.description : undefined,
    schema: property,
    repeatable: false,
  }));
}

function queryParameters(contract: AnyRouteContract): OperationParameter[] {
  const query = contract.query;
  if (!query) return [];
  if (isListQuerySchema(query)) {
    return listQueryParameters(query).map((parameter) => ({
      in: 'query',
      name: parameter.name,
      required: false,
      description: parameter.description,
      schema: parameter.schema,
      repeatable: parameter.repeatable,
    }));
  }
  const json = toJsonSchema(query, 'input') as { properties?: Record<string, JsonSchema>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    in: 'query',
    name,
    required: (json.required ?? []).includes(name),
    description: typeof property.description === 'string' ? property.description : undefined,
    schema: property,
    repeatable: false,
  }));
}

function problemResponse(status: number, codes: readonly ErrorCode[]): OperationResponse {
  const examples: Record<string, { summary: string; value: unknown }> = {};
  for (const code of codes) {
    examples[code] = {
      summary: ERROR_CATALOG[code].title,
      value: {
        type: `https://errors.gsm.example/${problemSlug(code)}`,
        title: ERROR_CATALOG[code].title,
        status,
        code,
        detail: ERROR_CATALOG[code].title,
        requestId: '0197f2b4-6a3c-7e10-9d44-5c1c2b7a9e01',
      },
    };
  }
  const headers: Record<string, { description: string; schema: JsonSchema }> = { ...REQUEST_ID_HEADER };
  if (status === 429)
    headers['retry-after'] = {
      description: 'Seconds to wait before the next request.',
      schema: { type: 'integer', minimum: 0 },
    };
  return {
    description: codes.map((code) => `${code}: ${ERROR_CATALOG[code].title}`).join('\n'),
    content: {
      'application/problem+json': {
        schema: {
          type: 'object',
          required: ['type', 'title', 'status', 'code', 'detail', 'requestId'],
          properties: {
            ...PROBLEM_PROPERTIES,
            status: { type: 'integer', const: status },
            code: { type: 'string', enum: [...codes] },
          },
        },
        examples,
      },
    },
    headers,
  };
}

/** The schema documented for an answer that has a media type but no zod schema (a file, text or a free-form document). */
function schemaWithoutBody(type: string): JsonSchema {
  // A JSON answer without a schema is a free-form document (GET /openapi.json), not text.
  if (type.includes('json')) return { type: 'object' };
  if (type.startsWith('text/')) return { type: 'string' };
  return { type: 'string', format: 'binary' };
}

function successResponses(contract: AnyRouteContract): Record<string, OperationResponse> {
  const { status, schema, contentType, list, alsoStatuses } = contract.success;
  const out: Record<string, OperationResponse> = {};
  if (status === 204) {
    out['204'] = { description: 'Done. No body.', headers: { ...REQUEST_ID_HEADER } };
    return out;
  }
  if (status === 302) {
    out['302'] = {
      description: 'Redirect to a short-lived download link. No body.',
      headers: {
        ...REQUEST_ID_HEADER,
        location: {
          description: 'The presigned download URL; it expires after 5 minutes.',
          schema: { type: 'string' },
        },
        'cache-control': { description: 'Always `no-store`.', schema: { type: 'string' } },
      },
    };
    return out;
  }
  if (!schema) {
    const type = contentType ?? 'application/octet-stream';
    out[String(status)] = {
      description: 'Success.',
      content: { [type]: { schema: schemaWithoutBody(type) } },
      headers: { ...REQUEST_ID_HEADER },
    };
    return out;
  }
  const item = toJsonSchema(schema, 'output');
  const body: JsonSchema = list ? { type: 'array', items: item } : item;
  const example = contract.examples.response;
  const media = { schema: body, ...(example !== undefined ? { example } : {}) };
  const headers: Record<string, { description: string; schema: JsonSchema }> = { ...REQUEST_ID_HEADER };
  if (list) {
    headers['x-total-count'] = {
      description: 'Rows that match the filters, before the range is applied.',
      schema: { type: 'integer', minimum: 0 },
    };
  }
  out[String(status)] = { description: 'Success.', content: { 'application/json': media }, headers };
  for (const other of alsoStatuses) {
    out[String(other)] = {
      description: 'Same body, other status (see the route description).',
      content: { 'application/json': { schema: body } },
      headers: { ...REQUEST_ID_HEADER },
    };
  }
  return out;
}

/**
 * Describes the OpenAPI operation of a contract as plain data.
 *
 * Why: documentation is generated from the same contract that validates requests, so it cannot drift (decision 008).
 * Error responses are grouped by status and list their codes with an example each, as problem+json.
 *
 * @param contract a route contract
 * @returns parameters, request body, responses and the security scheme name
 */
export function buildOperation(contract: AnyRouteContract): OperationParts {
  const parameters: OperationParameter[] = [
    ...(contract.params ? objectProperties(contract.params, 'path') : []),
    ...queryParameters(contract),
    ...(contract.headers ? objectProperties(contract.headers, 'header') : []),
  ];
  const responses: Record<string, OperationResponse> = successResponses(contract);
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of contract.errors) {
    const status = ERROR_CATALOG[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const [status, codes] of [...byStatus].sort((a, b) => a[0] - b[0]))
    responses[String(status)] = problemResponse(status, codes);
  return {
    operationId: operationIdOf(contract.key),
    parameters,
    requestBody: contract.body
      ? { schema: toJsonSchema(contract.body, 'input'), example: contract.examples.request }
      : undefined,
    responses,
    security: SECURITY_SCHEME[contract.access],
  };
}

/** A route a signed-in staff member calls to change data: the audit log must record it unless the contract opts out. */
function isStaffWrite(contract: AnyRouteContract): boolean {
  return (contract.access === 'staff-session' || contract.access === 'staff-permission') && contract.method !== 'GET';
}

/**
 * Creates the @nestjs/swagger decorators for a contract.
 *
 * Why: documentation is generated from the contract that validates requests (decision 008), so it cannot drift.
 *
 * @param contract a route contract
 * @returns decorators to apply to the handler method
 */
export function openApiDecorators(contract: AnyRouteContract): MethodDecorator[] {
  const parts = buildOperation(contract);
  // Schemas are plain JSON Schema 2020-12 objects; @nestjs/swagger types them as its own SchemaObject.
  const asSchema = (schema: JsonSchema) => schema as never;
  const decorators: Array<MethodDecorator | ClassDecorator> = [
    ApiOperation({
      summary: contract.summary,
      ...(contract.description ? { description: contract.description } : {}),
      operationId: parts.operationId,
    }),
    ApiTags(...contract.tags),
    ApiExtension('x-gsm-key', contract.key),
    ApiExtension('x-gsm-access', contract.access),
    // Lets the documents be filtered by surface (the public one keeps v1 and the Dhru reference, decision 017).
    ApiExtension('x-gsm-surface', contract.surface),
  ];
  if (contract.permission) decorators.push(ApiExtension('x-gsm-permission', contract.permission));
  // Session routes say which sign-in steps they accept; staff writes say whether an audit row is part of the contract.
  if (isSessionAccess(contract.access))
    decorators.push(ApiExtension('x-gsm-session-stages', [...contract.sessionStages]));
  // A merchant route says whether a merchant still waiting for approval may call it (B153).
  if (contract.access === 'merchant-session')
    decorators.push(ApiExtension('x-gsm-pending-merchant', contract.pendingMerchant));
  if (isStaffWrite(contract)) decorators.push(ApiExtension('x-gsm-audit', contract.audit));
  if (parts.security) decorators.push(ApiSecurity(parts.security));
  for (const parameter of parts.parameters) {
    const common = {
      name: parameter.name,
      required: parameter.required,
      ...(parameter.description ? { description: parameter.description } : {}),
      schema: asSchema(parameter.schema),
    };
    if (parameter.in === 'path') decorators.push(ApiParam(common));
    else if (parameter.in === 'header') decorators.push(ApiHeader(common));
    else
      decorators.push(
        ApiQuery(
          parameter.repeatable
            ? { ...common, schema: asSchema({ type: 'array', items: parameter.schema }), style: 'form', explode: true }
            : common,
        ),
      );
  }
  if (parts.requestBody) {
    decorators.push(
      ApiBody({
        required: true,
        schema: asSchema(parts.requestBody.schema),
        ...(parts.requestBody.example !== undefined
          ? { examples: { example: { value: parts.requestBody.example } } }
          : {}),
      }),
    );
  }
  for (const [status, response] of Object.entries(parts.responses)) {
    decorators.push(
      ApiResponse({
        status: Number(status),
        description: response.description,
        ...(response.content ? { content: response.content } : {}),
        ...(response.headers ? { headers: response.headers } : {}),
      }),
    );
  }
  return decorators as MethodDecorator[];
}
