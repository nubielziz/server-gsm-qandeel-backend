// Unit tests of the contract comparator (decision 009): one group per rule of docs/contract/TESTS.md § 2, with small
// hand-made shapes and schemas, plus a pass over every shape of docs/contract/frontend-endpoints.json.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Difference, RULES, compareShape } from './compare';
import { compareRequest, compareResponse, compareStatus } from './compare-http';
import type { FrontendShape } from './normalize';
import { shapeToSchema } from './shape-to-schema';

// --- builders for frontend shapes and backend schemas -------------------------------------------------------------------
const str: FrontendShape = { type: 'string' };
const num: FrontendShape = { type: 'number' };
const bool: FrontendShape = { type: 'boolean' };
const alias = (type: 'string' | 'number', name: string): FrontendShape => ({ type, alias: name });
const obj = (props: Record<string, FrontendShape>, record?: FrontendShape): FrontendShape => ({
  object: props,
  ...(record ? { record } : {}),
});
const opt = (shape: FrontendShape): FrontendShape => ({ ...shape, optional: true });
const nul = (shape: FrontendShape): FrontendShape => ({ ...shape, nullable: true });
const en = (...values: (string | number)[]): FrontendShape => ({ enum: values });
const arr = (items: FrontendShape): FrontendShape => ({ array: items });

const s = { type: 'string' };
const n = { type: 'number' };
const integer = { type: 'integer' };
const b = { type: 'boolean' };
const o = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const money = { type: 'string', pattern: '^-?\\d+\\.\\d{4}$', 'x-gsm-alias': 'Money' };
const idSchema = { type: 'integer', exclusiveMinimum: 0, 'x-gsm-alias': 'Id' };
const isoSchema = { type: 'string', format: 'date-time', 'x-gsm-alias': 'IsoDateTime' };
const dateOnly = { type: 'string', format: 'date', 'x-gsm-alias': 'DateOnly' };
const stringEnum = (...values: string[]) => ({ type: 'string', enum: values });
const nullableOf = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });

// --- helpers -------------------------------------------------------------------------------------------------------------
const brief = (diffs: Difference[]): string[] => diffs.map((d) => `${d.severity}:${d.rule}@${d.path}`);
const response = (frontend: FrontendShape, backend: unknown) =>
  compareShape(frontend, backend, { direction: 'response' });
const request = (frontend: FrontendShape, backend: unknown) =>
  compareShape(frontend, backend, { direction: 'request' });
const wire = (frontend: FrontendShape, backend: unknown) =>
  compareShape(frontend, backend, { direction: 'request', wire: true });

describe('the rule list', () => {
  it('has unique names', () => {
    expect(new Set(RULES).size).toBe(RULES.length);
  });
});

describe('agreement', () => {
  it('reports nothing when the shape and the schema say the same', () => {
    const frontend = obj({ id: alias('number', 'Id'), name: str, tags: arr(str), note: opt(nul(str)) });
    const backend = o(
      { id: idSchema, name: s, tags: { type: 'array', items: s }, note: { type: ['string', 'null'] } },
      ['id', 'name', 'tags'],
    );
    expect(response(frontend, backend)).toEqual([]);
  });
});

describe('required fields', () => {
  it('fails when the frontend reads a field as required but the backend may omit it', () => {
    expect(brief(response(obj({ a: str }), o({ a: s }, [])))).toEqual(['error:required@a']);
  });

  it('accepts an optional backend field that has a default (the backend always sends it)', () => {
    expect(response(obj({ a: str }), o({ a: { type: 'string', default: 'x' } }, []))).toEqual([]);
  });

  it('accepts a backend field that is required when the frontend marks it optional', () => {
    expect(response(obj({ a: opt(str) }), o({ a: s }))).toEqual([]);
  });

  it('treats `| undefined` like an optional property', () => {
    expect(response(obj({ a: { ...str, undefinable: true } }), o({ a: s }, []))).toEqual([]);
  });

  it('fails when the frontend reads a field the backend never declares', () => {
    const diffs = response(obj({ a: str, b: num }), o({ a: s }));
    expect(brief(diffs)).toEqual(['error:missing-field@b']);
    expect(diffs[0]?.message).toContain('"b"');
  });

  it('only notes an optional frontend field that the backend never sends', () => {
    expect(brief(response(obj({ a: str, b: opt(num) }), o({ a: s })))).toEqual(['info:missing-field@b']);
  });

  it('request: fails when the backend requires a field the frontend may omit or never sends', () => {
    const backend = o({ a: s, b: s, c: s });
    expect(brief(request(obj({ a: str, b: opt(str) }), backend))).toEqual([
      'error:required@b',
      'error:missing-field@c',
    ]);
  });

  it('request: a backend default makes the field optional for the sender', () => {
    expect(request(obj({}), o({ a: { type: 'string', default: 'x' } }, []))).toEqual([]);
  });

  it('request: fails for a field the frontend sends that the backend does not declare', () => {
    expect(brief(request(obj({ a: str, extra: str }), o({ a: s })))).toEqual(['error:missing-field@extra']);
  });
});

describe('extra backend fields', () => {
  it('are reported but never fail', () => {
    const diffs = response(obj({ a: str }), o({ a: s, secret: s, nested: o({ x: s }) }));
    expect(brief(diffs)).toEqual(['info:extra-field@secret', 'info:extra-field@nested']);
    expect(diffs.every((d) => d.severity === 'info')).toBe(true);
  });
});

describe('types', () => {
  it('reports different primitive kinds with both sides named', () => {
    const diffs = response(obj({ a: num, b: bool, c: str }), o({ a: s, b: n, c: o({}) }));
    expect(brief(diffs)).toEqual(['error:type@a', 'error:type@b', 'error:type@c']);
    expect(diffs[0]?.message).toBe('backend sends a string where the frontend expects a number');
  });

  it('request: names the frontend as the sender', () => {
    expect(request(obj({ a: str }), o({ a: n }))[0]?.message).toBe(
      'frontend sends a string where the backend expects a number',
    );
  });

  it('treats an integer as a number in both directions', () => {
    expect(response(num, integer)).toEqual([]);
    expect(request(num, integer)).toEqual([]);
  });

  it('reports a schema that accepts anything where the frontend has a type', () => {
    expect(brief(response(obj({ a: str }), o({ a: {} })))).toEqual(['error:unconstrained@a']);
  });

  it('accepts free-form JSON on either side for json shapes', () => {
    const json: FrontendShape = { type: 'json', alias: 'JsonObject' };
    expect(response(obj({ data: json }), o({ data: { type: 'object', additionalProperties: true } }))).toEqual([]);
    expect(brief(response(obj({ data: json }), o({ data: {} })))).toEqual(['error:unconstrained@data']);
    expect(brief(response(obj({ data: json }), o({ data: s })))).toEqual(['error:type@data']);
    expect(
      brief(
        response(
          obj({ data: str }),
          o({ data: { 'x-gsm-alias': 'JsonObject', type: 'object', additionalProperties: true } }),
        ),
      ),
    ).toEqual(['error:type@data']);
  });

  it('understands unions on both sides', () => {
    const frontend = obj({ v: { anyOf: [str, num] } });
    expect(response(frontend, o({ v: { type: ['string', 'number'] } }))).toEqual([]);
    expect(response(frontend, o({ v: { anyOf: [s, n] } }))).toEqual([]);
    expect(brief(response(frontend, o({ v: b })))).toEqual(['error:type@v']);
  });

  it('follows $ref and stops on recursion', () => {
    const tree = {
      type: 'object',
      properties: { n: n, kids: { type: 'array', items: { $ref: '#' } } },
      required: ['n'],
    };
    const frontend = obj({ n: num, kids: opt(arr({ ref: 'Tree' })) });
    expect(response(frontend, tree)).toEqual([]);
    const withDefs = {
      $defs: { id: idSchema },
      type: 'object',
      properties: { id: { $ref: '#/$defs/id' } },
      required: ['id'],
    };
    expect(response(obj({ id: alias('number', 'Id') }), withDefs)).toEqual([]);
  });

  it('merges allOf objects', () => {
    const backend = { allOf: [o({ a: s }), o({ b: n })] };
    expect(response(obj({ a: str, b: num }), backend)).toEqual([]);
  });
});

describe('aliases', () => {
  it('Money needs the money marker or the money pattern', () => {
    const frontend = obj({ total: alias('string', 'Money') });
    expect(response(frontend, o({ total: money }))).toEqual([]);
    expect(response(frontend, o({ total: { type: 'string', pattern: '^-?\\d+\\.\\d{4}$' } }))).toEqual([]);
    const diffs = response(frontend, o({ total: s }));
    expect(brief(diffs)).toEqual(['error:alias@total']);
    expect(diffs[0]?.message).toContain('frontend expects Money');
  });

  it('IsoDateTime needs the marker or format date-time', () => {
    const frontend = obj({ at: alias('string', 'IsoDateTime') });
    expect(response(frontend, o({ at: isoSchema }))).toEqual([]);
    expect(response(frontend, o({ at: { type: 'string', format: 'date-time' } }))).toEqual([]);
    expect(brief(response(frontend, o({ at: s })))).toEqual(['error:alias@at']);
    expect(brief(response(frontend, o({ at: money })))).toEqual(['error:alias@at']);
  });

  it('Id needs the marker or an integer', () => {
    const frontend = obj({ id: alias('number', 'Id') });
    expect(response(frontend, o({ id: idSchema }))).toEqual([]);
    expect(response(frontend, o({ id: integer }))).toEqual([]);
    expect(brief(response(frontend, o({ id: n })))).toEqual(['error:alias@id']);
  });

  it('a Decimal consumer accepts Money, a Money consumer does not accept a Decimal', () => {
    const decimal = { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$', 'x-gsm-alias': 'Decimal' };
    expect(response(obj({ rate: alias('string', 'Decimal') }), o({ rate: money }))).toEqual([]);
    expect(brief(response(obj({ rate: alias('string', 'Money') }), o({ rate: decimal })))).toEqual([
      'error:alias@rate',
    ]);
  });

  it('a plain frontend string or number accepts any backend alias', () => {
    expect(response(obj({ a: str, b: num, c: str }), o({ a: money, b: idSchema, c: isoSchema }))).toEqual([]);
  });

  it('request: a backend alias needs the frontend to say the same', () => {
    expect(brief(request(obj({ amount: str }), o({ amount: money })))).toEqual(['error:alias@amount']);
    expect(request(obj({ amount: alias('string', 'Money') }), o({ amount: money }))).toEqual([]);
    expect(request(obj({ amount: alias('string', 'Money') }), o({ amount: s }))).toEqual([]);
  });

  it('DateOnly: the console has no date-only type, so a plain string fits (request and wire)', () => {
    const backend = o({ from: dateOnly, to: dateOnly });
    const frontend = obj({ from: str, to: str });
    expect(request(frontend, backend)).toEqual([]);
    expect(wire(frontend, backend)).toEqual([]);
    // The bare `format: date` is read as DateOnly too.
    expect(wire(obj({ from: str }), o({ from: { type: 'string', format: 'date' } }))).toEqual([]);
  });

  it('DateOnly: a string with another alias, or a number, still differs', () => {
    const iso = obj({ from: alias('string', 'IsoDateTime') });
    expect(brief(request(iso, o({ from: dateOnly })))).toEqual(['error:alias@from']);
    expect(brief(wire(iso, o({ from: dateOnly })))).toEqual(['error:alias@from']);
    expect(brief(wire(obj({ from: num }), o({ from: dateOnly })))).toEqual(['error:alias@from']);
  });
});

describe('enums', () => {
  it('accepts a backend value set inside the frontend set', () => {
    expect(response(obj({ status: en('a', 'b', 'c') }), o({ status: stringEnum('a', 'b') }))).toEqual([]);
  });

  it('names a backend value the frontend does not know', () => {
    const diffs = response(obj({ status: en('a', 'b') }), o({ status: stringEnum('a', 'needs_attention') }));
    expect(brief(diffs)).toEqual(['error:enum@status']);
    expect(diffs[0]?.message).toBe('backend value "needs_attention" unknown to the frontend');
  });

  it('fails when the backend sends a free string where the frontend knows a few values', () => {
    expect(brief(response(obj({ status: en('a', 'b') }), o({ status: s })))).toEqual(['error:enum@status']);
  });

  it('accepts an enum where the frontend has a plain string', () => {
    expect(response(obj({ status: str }), o({ status: stringEnum('a') }))).toEqual([]);
  });

  it('understands const, a union of consts and nullable enums', () => {
    expect(response(obj({ k: en('x') }), o({ k: { type: 'string', const: 'x' } }))).toEqual([]);
    expect(response(obj({ k: en('x', 'y') }), o({ k: { anyOf: [{ const: 'x' }, { const: 'y' }] } }))).toEqual([]);
    expect(response(obj({ k: nul(en('x')) }), o({ k: nullableOf(stringEnum('x')) }))).toEqual([]);
  });

  it('compares number enums', () => {
    expect(response(obj({ days: en(1, 7, 14) }), o({ days: { type: 'integer', enum: [1, 7] } }))).toEqual([]);
    expect(brief(response(obj({ days: en(1, 7) }), o({ days: { type: 'integer', enum: [1, 30] } })))).toEqual([
      'error:enum@days',
    ]);
  });

  it('request: the frontend values must be accepted by the backend', () => {
    expect(request(obj({ scope: en('all', 'b2c') }), o({ scope: stringEnum('all', 'b2c', 'b2b') }))).toEqual([]);
    const diffs = request(obj({ scope: en('all', 'x') }), o({ scope: stringEnum('all', 'b2c') }));
    expect(brief(diffs)).toEqual(['error:enum@scope']);
    expect(diffs[0]?.message).toBe('frontend value "x" not accepted by the backend');
  });
});

describe('nullability', () => {
  it('fails when the backend may send null and the frontend type is not nullable', () => {
    expect(brief(response(obj({ a: str }), o({ a: nullableOf(s) })))).toEqual(['error:nullable@a']);
    expect(brief(response(obj({ a: str }), o({ a: { type: ['string', 'null'] } })))).toEqual(['error:nullable@a']);
  });

  it('accepts a nullable frontend field when the backend never sends null', () => {
    expect(response(obj({ a: nul(str) }), o({ a: s }))).toEqual([]);
  });

  it('accepts a nullable field on both sides, also for objects', () => {
    const user = o({ id: idSchema });
    const frontend = obj({ by: nul(obj({ id: alias('number', 'Id') })) });
    expect(response(frontend, o({ by: nullableOf(user) }))).toEqual([]);
  });

  it('request: fails when the frontend may send null and the backend does not accept it', () => {
    expect(brief(request(obj({ a: nul(str) }), o({ a: s })))).toEqual(['error:nullable@a']);
    expect(request(obj({ a: str }), o({ a: nullableOf(s) }))).toEqual([]);
  });
});

describe('arrays', () => {
  it('compares the items and writes [] in the path', () => {
    const frontend = obj({ rows: arr(obj({ id: num, status: en('a') })) });
    const backend = o({ rows: { type: 'array', items: o({ id: integer, status: stringEnum('a', 'b') }) } });
    expect(brief(response(frontend, backend))).toEqual(['error:enum@rows[].status']);
  });

  it('reports an array on one side only', () => {
    expect(brief(response(obj({ a: arr(str) }), o({ a: s })))).toEqual(['error:array@a']);
    expect(brief(response(obj({ a: str }), o({ a: { type: 'array', items: s } })))).toEqual(['error:array@a']);
  });

  it('compares tuples by length and position', () => {
    const frontend = obj({ pair: { tuple: [str, num] } });
    const backend = (items: unknown[]) => o({ pair: { type: 'array', prefixItems: items, items: false } });
    expect(response(frontend, backend([s, n]))).toEqual([]);
    expect(brief(response(frontend, backend([s, s])))).toEqual(['error:type@pair[1]']);
    expect(brief(response(frontend, backend([s])))).toEqual(['error:array@pair']);
  });
});

describe('records', () => {
  it('compares the values and writes .* in the path', () => {
    const frontend = obj({ checks: obj({}, en('ok', 'down')) });
    const backend = (values: string[]) =>
      o({ checks: { type: 'object', propertyNames: s, additionalProperties: stringEnum(...values) } });
    expect(response(frontend, backend(['ok', 'down']))).toEqual([]);
    expect(brief(response(frontend, backend(['ok', 'degraded'])))).toEqual(['error:enum@checks.*']);
  });

  it('accepts fixed backend fields where the frontend has a map, and checks each against the value type', () => {
    const frontend = obj({ byStatus: obj({}, num) });
    expect(response(frontend, o({ byStatus: o({ open: n, closed: n }) }))).toEqual([]);
    expect(brief(response(frontend, o({ byStatus: o({ open: n, closed: s }) })))).toEqual([
      'error:type@byStatus.closed',
    ]);
  });

  it('fails when the backend sends a free-form map where the frontend expects fixed fields', () => {
    const backend = o({ stats: { type: 'object', additionalProperties: n } });
    expect(brief(response(obj({ stats: obj({ open: num }) }), backend))).toEqual(['error:record@stats']);
  });

  it('request: the frontend map values must fit the backend record', () => {
    const backend = o({ settings: { type: 'object', additionalProperties: s } });
    expect(request(obj({ settings: obj({}, str) }), backend)).toEqual([]);
    expect(brief(request(obj({ settings: obj({}, num) }), backend))).toEqual(['error:type@settings.*']);
  });
});

describe('wire mode (path and query)', () => {
  it('lets scalar kinds stand for each other because everything is text', () => {
    expect(wire(obj({ limit: num }), { type: 'object', properties: { limit: s } })).toEqual([]);
    expect(wire(obj({ flag: bool }), { type: 'object', properties: { flag: s } })).toEqual([]);
  });

  it('compares enum values as text', () => {
    const backend = { type: 'object', properties: { days: stringEnum('1', '7', '14') } };
    expect(wire(obj({ days: en(1, 7) }), backend)).toEqual([]);
    expect(brief(wire(obj({ days: en(1, 30) }), backend))).toEqual(['error:enum@days']);
  });

  it('still checks aliases: a numeric Id may travel as text', () => {
    const idText = { type: 'string', pattern: '^[1-9]\\d{0,15}$', 'x-gsm-alias': 'Id' };
    expect(
      wire(obj({ clientId: alias('number', 'Id') }), { type: 'object', properties: { clientId: idText } }),
    ).toEqual([]);
    expect(brief(wire(obj({ clientId: num }), { type: 'object', properties: { clientId: idText } }))).toEqual([
      'error:alias@clientId',
    ]);
  });
});

describe('success status', () => {
  it('passes when the declared status is the documented one', () => {
    expect(compareStatus(201, 201)).toEqual([]);
  });

  it('fails when they differ', () => {
    const diffs = compareStatus(204, 200);
    expect(brief(diffs)).toEqual(['error:status@status']);
    expect(diffs[0]?.message).toBe('the frontend contract documents 204, the route declares 200');
  });
});

describe('ListResult<T> and x-total-count', () => {
  const row = obj({ id: alias('number', 'Id'), status: en('a', 'b') });
  const listResult: { returns: FrontendShape; returnsText: string } = {
    returns: obj({ data: arr(row), total: num }),
    returnsText: 'ListResult<Thing>',
  };
  const rowSchema = o({ id: idSchema, status: stringEnum('a', 'b') });

  it('accepts a list route whose row schema fits', () => {
    expect(compareResponse(listResult, { status: 200, schema: rowSchema, list: true }, 200)).toEqual([]);
  });

  it('reports row differences under data[]', () => {
    const wrong = o({ id: idSchema, status: stringEnum('a', 'z') });
    const diffs = compareResponse(listResult, { status: 200, schema: wrong, list: true }, 200);
    expect(brief(diffs)).toEqual(['error:enum@data[].status']);
  });

  it('fails when the route is not a list route (no x-total-count)', () => {
    const diffs = compareResponse(
      listResult,
      { status: 200, schema: { type: 'array', items: rowSchema }, list: false },
      200,
    );
    expect(brief(diffs)).toEqual(['error:list-result@data[]']);
  });

  it('accepts a plain frontend array against a list route', () => {
    const plain = { returns: arr(row), returnsText: 'Thing[]' };
    expect(compareResponse(plain, { status: 200, schema: rowSchema, list: true }, 200)).toEqual([]);
    expect(
      compareResponse(plain, { status: 200, schema: { type: 'array', items: rowSchema }, list: false }, 200),
    ).toEqual([]);
  });

  it('reports a route that answers an object where the frontend reads an array', () => {
    const plain = { returns: arr(row), returnsText: 'Thing[]' };
    expect(brief(compareResponse(plain, { status: 200, schema: rowSchema, list: false }, 200))).toEqual([
      'error:array@',
    ]);
  });
});

describe('responses without a JSON body', () => {
  it('a void answer needs the documented 204 and no body', () => {
    const none = { returns: { type: 'undefined' }, returnsText: 'void' };
    expect(compareResponse(none, { status: 204, list: false }, 204)).toEqual([]);
    expect(brief(compareResponse(none, { status: 200, schema: o({}), list: false }, 204))).toEqual([
      'error:status@status',
    ]);
  });

  it('a string answer is a file or text: it needs a media type or a string schema', () => {
    const text = { returns: str, returnsText: 'string' };
    expect(compareResponse(text, { status: 200, contentType: 'text/csv', list: false }, 200)).toEqual([]);
    expect(brief(compareResponse(text, { status: 200, schema: o({ a: s }), list: false }, 200))).toEqual([
      'error:type@',
    ]);
    expect(
      brief(
        compareResponse(
          { returns: obj({ a: str }), returnsText: 'Thing' },
          { status: 200, contentType: 'text/csv', list: false },
          200,
        ),
      ),
    ).toEqual(['error:type@']);
  });
});

describe('requests', () => {
  const param = (name: string, shape: FrontendShape, typeText = 'x', optional = false) => ({
    name,
    optional,
    typeText,
    shape,
  });
  const idText = { type: 'string', pattern: '^[1-9]\\d{0,15}$', 'x-gsm-alias': 'Id' };

  it('maps body, query and path parameters by role and ignores init', () => {
    const backend = {
      pathParams: ['id'],
      params: { type: 'object', properties: { id: idText }, required: ['id'] },
      query: { type: 'object', properties: { days: stringEnum('1', '7') } },
      queryIsList: false,
      body: o({ name: s }),
    };
    const frontend = [
      param('id', alias('number', 'Id')),
      param('body', obj({ name: str })),
      param('query', obj({ days: opt(en(1, 7)) }), 'Params'),
      param('init', obj({ signal: opt({ type: 'AbortSignal' }) }), 'ApiInit | undefined', true),
    ];
    expect(compareRequest(frontend, backend)).toEqual([]);
  });

  it('prefixes every path with body, query or params', () => {
    const backend = {
      pathParams: ['id'],
      params: { type: 'object', properties: { id: idText }, required: ['id'] },
      query: { type: 'object', properties: { days: stringEnum('1') } },
      queryIsList: false,
      body: o({ name: s, roleId: idSchema }),
    };
    const frontend = [
      param('id', num),
      param('body', obj({ name: num, roleId: alias('number', 'Id') })),
      param('query', obj({ days: en(1, 2) })),
    ];
    expect(brief(compareRequest(frontend, backend)).sort()).toEqual([
      'error:alias@params.id',
      'error:enum@query.days',
      'error:type@body.name',
    ]);
  });

  it('does not compare the list dialect field by field', () => {
    const backend = { pathParams: [], queryIsList: true };
    expect(compareRequest([param('query', obj({ start: opt(num) }), 'ListQuery', true)], backend)).toEqual([]);
  });

  it('fails when the frontend sends a body the route does not declare, or omits one it requires', () => {
    expect(brief(compareRequest([param('body', obj({ a: str }))], { pathParams: [], queryIsList: false }))).toEqual([
      'error:missing-field@body',
    ]);
    expect(brief(compareRequest([], { pathParams: [], queryIsList: false, body: o({ a: s }) }))).toEqual([
      'error:required@body',
    ]);
    expect(compareRequest([], { pathParams: [], queryIsList: false, body: o({ a: s }, []) })).toEqual([]);
  });
});

describe('the frontend contract vocabulary', () => {
  interface Endpoint {
    key: string;
    params: { name: string; shape: FrontendShape }[];
    returns: FrontendShape | null;
  }
  const document = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../docs/contract/frontend-endpoints.json'), 'utf8'),
  ) as {
    endpoints: Endpoint[];
  };

  it('reads every response shape and finds no difference with the schema written from it', () => {
    expect(document.endpoints.length).toBe(269);
    for (const endpoint of document.endpoints) {
      // A `void` answer has no body to compare; compareResponse checks its 204 instead.
      if (!endpoint.returns || endpoint.returns.type === 'undefined') continue;
      const diffs = compareShape(endpoint.returns, shapeToSchema(endpoint.returns), { direction: 'response' });
      expect(
        diffs.filter((d) => d.severity === 'error').map((d) => `${endpoint.key} ${d.rule}@${d.path}: ${d.message}`),
      ).toEqual([]);
    }
  });

  it('reads every request body shape the same way', () => {
    for (const endpoint of document.endpoints) {
      const body = endpoint.params.find((p) => p.name === 'body');
      if (!body) continue;
      const diffs = compareShape(body.shape, shapeToSchema(body.shape), { direction: 'request' });
      expect(
        diffs.filter((d) => d.severity === 'error').map((d) => `${endpoint.key} ${d.rule}@${d.path}: ${d.message}`),
      ).toEqual([]);
    }
  });
});
