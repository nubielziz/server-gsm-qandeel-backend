// Unit tests of the Dhru reference in the public OpenAPI document: the `oneOf` by action and the examples written from the action contracts.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { AnyDhruAction } from '../../../common/dhru';
import { DHRU_PATH, describeDhruActions } from './dhru-reference';
import type { OpenApiDocument } from './openapi-types';

/** A contract built by hand: `defineDhruAction` would register it in the process-wide registry the application tests share. */
function action(overrides: Partial<AnyDhruAction> & Pick<AnyDhruAction, 'action'>): AnyDhruAction {
  return {
    key: `DHRU ${overrides.action}`,
    summary: `Summary of ${overrides.action}`,
    description: undefined,
    bulk: false,
    params: undefined,
    success: z.object({ MESSAGE: z.string() }),
    errors: ['UNAUTHORIZED'],
    examples: { request: undefined, response: undefined },
    ...overrides,
  };
}

const info = action({
  action: 'accountinfo',
  examples: { request: undefined, response: { MESSAGE: 'Your Accout Info' } },
});
const get = action({
  action: 'getimeiorder',
  params: z.object({ ID: z.number() }),
  success: z.object({ STATUS: z.number(), CODE: z.string() }),
  examples: { request: { ID: 7 }, response: { STATUS: 4, CODE: 'ok' } },
});
const getBulk = action({
  action: 'getimeiorderbulk',
  bulk: true,
  params: z.object({ ID: z.number() }),
  success: z.object({ STATUS: z.number(), CODE: z.string() }),
  examples: { request: { ID: 7 }, response: { STATUS: 1, CODE: '' } },
});

/** What @nestjs/swagger writes for the Dhru route. */
function raw(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'raw', version: '0' },
    paths: {
      [DHRU_PATH]: {
        post: {
          operationId: 'postApiIndexPhp',
          'x-gsm-surface': 'dhru',
          requestBody: {
            required: true,
            content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' }, examples: { example: { value: {} } } } },
          },
          responses: {
            '200': {
              description: 'Success.',
              content: { 'application/json': { schema: { type: 'object' }, example: { SUCCESS: [] } } },
            },
          },
        },
      },
    },
  };
}

/** Reads the Dhru operation of a document as loose JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the document is plain JSON: the default keeps the assertions short
const operationOf = (doc: OpenApiDocument): any => (doc.paths[DHRU_PATH] as any).post;

describe('describeDhruActions', () => {
  it('makes the request body a oneOf by action, with the action fixed in each branch', () => {
    const doc = raw();
    describeDhruActions(doc, [info, get, getBulk]);
    const schema = operationOf(doc).requestBody.content['application/x-www-form-urlencoded'].schema;
    expect(schema.discriminator).toEqual({ propertyName: 'action' });
    expect(schema.oneOf.map((branch: { title: string }) => branch.title)).toEqual(['accountinfo', 'getimeiorder', 'getimeiorderbulk']);
    expect(schema.oneOf[1].properties.action).toEqual({ type: 'string', const: 'getimeiorder' });
    // An action with parameters requires them; one without does not.
    expect(schema.oneOf[0].required).toEqual(['username', 'apiaccesskey', 'action']);
    expect(schema.oneOf[1].required).toEqual(['username', 'apiaccesskey', 'action', 'parameters']);
    expect(schema.oneOf[1].properties.parameters['x-gsm-decoded'].properties.ID.type).toBe('number');
    // A bulk action's parameters are keyed by the caller's request id.
    expect(schema.oneOf[2].properties.parameters['x-gsm-decoded'].additionalProperties.properties.ID.type).toBe('number');
  });

  it('gives each action a request example whose parameters are base64 JSON, and a bulk one keyed by request id', () => {
    const doc = raw();
    describeDhruActions(doc, [info, get, getBulk]);
    const examples = operationOf(doc).requestBody.content['application/x-www-form-urlencoded'].examples;
    expect(Object.keys(examples)).toEqual(['accountinfo', 'getimeiorder', 'getimeiorderbulk']);
    expect(examples.accountinfo.value.parameters).toBeUndefined();
    const decode = (text: string): unknown => JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
    expect(decode(examples.getimeiorder.value.parameters)).toEqual({ ID: 7 });
    expect(decode(examples.getimeiorderbulk.value.parameters)).toEqual({ 'req-1': { ID: 7 } });
    expect(examples.getimeiorder.value).toMatchObject({ action: 'getimeiorder', requestformat: 'JSON' });
  });

  it('gives each action a response example in the envelope, and adds a refusal example', () => {
    const doc = raw();
    describeDhruActions(doc, [info, get, getBulk]);
    const json = operationOf(doc).responses['200'].content['application/json'];
    expect(json.example).toBeUndefined();
    expect(json.examples.getimeiorder.value).toEqual({ SUCCESS: [{ STATUS: 4, CODE: 'ok' }], apiversion: '6.1' });
    expect(json.examples.getimeiorderbulk.value).toEqual({ 'req-1': { SUCCESS: [{ STATUS: 1, CODE: '' }] }, apiversion: '6.1' });
    expect(json.examples.error.value).toEqual({ ERROR: [{ MESSAGE: 'Not enough credits' }], apiversion: '6.1' });
    expect(operationOf(doc).responses['200'].description).toContain('Always HTTP 200');
  });

  it('leaves a document without the Dhru route, and a call without actions, as they are', () => {
    const none: OpenApiDocument = { openapi: '3.1.0', info: { title: 'x', version: '0' }, paths: {} };
    describeDhruActions(none, [info]);
    expect(none.paths).toEqual({});
    const untouched = raw();
    describeDhruActions(untouched, []);
    expect(operationOf(untouched).requestBody.content['application/x-www-form-urlencoded'].schema).toEqual({ type: 'object' });
  });
});
