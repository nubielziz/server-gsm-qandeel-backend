// The Dhru Fusion reference of the public OpenAPI document (decision 017): the one operation `POST /api/index.php` gets a request body
// that is a `oneOf` by `action` and one request and one response example per action, written from the action contracts (decision 026).
import { toJsonSchema } from '../../../common/contract';
import type { AnyDhruAction } from '../../../common/dhru';
import { DHRU_API_VERSION } from '../../../common/errors';
import type { OpenApiDocument, OpenApiOperation, PlainObject } from './openapi-types';

/** The path of the Dhru transport route. */
export const DHRU_PATH = '/api/index.php';

/** The request id the examples of a bulk action use. */
const EXAMPLE_REQUEST_ID = 'req-1';

/** The credentials the examples show. */
const EXAMPLE_CREDENTIALS = { username: 'zain-mobile-hub', apiaccesskey: 'gsm_…' } as const;

const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** Base64 of a JSON value: how `parameters` travels. */
const base64Json = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

function isObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The decoded parameters of an example: a bulk call keys its items by the caller's request id. */
function exampleParameters(action: AnyDhruAction): unknown {
  const example = action.examples.request;
  if (example === undefined) return undefined;
  return action.bulk ? { [EXAMPLE_REQUEST_ID]: example } : example;
}

/** The body an example answer has: one SUCCESS entry, or one per request id for a bulk action. */
function exampleAnswer(action: AnyDhruAction): unknown {
  const entry = action.examples.response;
  if (entry === undefined) return undefined;
  return action.bulk
    ? { [EXAMPLE_REQUEST_ID]: { SUCCESS: [entry] }, apiversion: DHRU_API_VERSION }
    : { SUCCESS: [entry], apiversion: DHRU_API_VERSION };
}

/** The request schema of one action: the form fields with `action` fixed and the decoded parameters described. */
function requestSchemaOf(action: AnyDhruAction): PlainObject {
  const decoded = action.params ? toJsonSchema(action.params, 'input') : undefined;
  const parametersDescription =
    decoded === undefined
      ? 'This action takes no parameters.'
      : `Base64 of a JSON object${action.bulk ? ' keyed by your request id, one entry per order' : ''}; its shape is in \`x-gsm-decoded\`.`;
  return {
    type: 'object',
    title: action.action,
    description: [action.summary + '.', action.description].filter(Boolean).join(' '),
    required: ['username', 'apiaccesskey', 'action', ...(decoded === undefined ? [] : ['parameters'])],
    properties: {
      username: { type: 'string', description: 'The merchant username (`clients.username`).' },
      apiaccesskey: { type: 'string', description: 'A merchant API key with the `dhru` scope.' },
      action: { type: 'string', const: action.action },
      requestformat: { type: 'string', description: 'Ignored: every answer is JSON.' },
      parameters: {
        type: 'string',
        description: parametersDescription,
        ...(decoded === undefined
          ? {}
          : { 'x-gsm-decoded': action.bulk ? { type: 'object', additionalProperties: decoded } : decoded }),
      },
    },
    additionalProperties: true,
    'x-gsm-success-entry': toJsonSchema(action.success, 'output'),
    'x-gsm-errors': [...action.errors],
  };
}

/**
 * Describes the eight Dhru actions in the Dhru operation of a raw OpenAPI document, in place.
 *
 * Why: decision 017: merchants read the Dhru reference as one operation whose form body is a `oneOf` by `action`, with one request and
 * one response example per action. Every refusal of the surface is an `ERROR` list in an HTTP 200 body (decision 026), so the operation
 * documents the success response only, and says so.
 *
 * @param raw the document `SwaggerModule.createDocument` produced; changed in place
 * @param actions the Dhru action contracts
 */
export function describeDhruActions(raw: OpenApiDocument, actions: readonly AnyDhruAction[]): void {
  const operation = raw.paths[DHRU_PATH]?.post;
  if (!isObject(operation) || actions.length === 0) return;
  const op = operation as OpenApiOperation;
  const requestBody = op.requestBody;
  const media = isObject(requestBody) && isObject(requestBody.content) ? requestBody.content[FORM_MEDIA_TYPE] : undefined;
  if (isObject(media)) {
    media.schema = { oneOf: actions.map(requestSchemaOf), discriminator: { propertyName: 'action' } };
    const examples: Record<string, { summary: string; value: unknown }> = {};
    for (const action of actions) {
      const parameters = exampleParameters(action);
      examples[action.action] = {
        summary: action.summary,
        value: {
          ...EXAMPLE_CREDENTIALS,
          action: action.action,
          requestformat: 'JSON',
          ...(parameters === undefined ? {} : { parameters: base64Json(parameters) }),
        },
      };
    }
    media.examples = examples;
  }
  const responses = op.responses;
  const ok = isObject(responses) ? responses['200'] : undefined;
  const json = isObject(ok) && isObject(ok.content) ? ok.content['application/json'] : undefined;
  if (isObject(ok)) {
    ok.description =
      'Always HTTP 200 with the headers `X-Powered-By: DHRU-FUSION` and `dhru-fusion-api-version: 6.1`. A success is `{ "SUCCESS": [ ... ], "apiversion": "6.1" }`; ' +
      'a refusal (a wrong credential, an unknown action, a rejected order) is `{ "ERROR": [ { "MESSAGE": "..." } ], "apiversion": "6.1" }`. ' +
      'A bulk action answers one `SUCCESS` or `ERROR` list per request id.';
  }
  if (isObject(json)) {
    delete json.example;
    const answers: Record<string, { summary: string; value: unknown }> = {};
    for (const action of actions) {
      const value = exampleAnswer(action);
      if (value !== undefined) answers[action.action] = { summary: action.summary, value };
    }
    answers.error = {
      summary: 'A refusal',
      value: { ERROR: [{ MESSAGE: 'Not enough credits' }], apiversion: DHRU_API_VERSION },
    };
    json.examples = answers;
  }
}
