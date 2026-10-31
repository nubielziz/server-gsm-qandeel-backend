// Tests of the route-level comparison and the allowlist logic on realistic routes: the contracts a Phase 3 feature would
// write for the staff routes, compared with the real frontend functions from docs/contract/frontend-endpoints.json.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { toJsonSchema, zId, zIdParam, zIsoDateTime } from '../../../src/common/contract';
import { RULES } from './compare';
import { type Finding, compareRoute, describeFinding } from './compare-route';
import { type AllowlistEntry, reconcile, validateEntries } from './allowlist-check';
import { fixtureFindings, fixturePath } from './fixture-check';
import { type Fixture, loadFrontendEndpoints, loadMismatchIds, loadSuccessStatuses } from './inputs';
import { shapeToSchema } from './shape-to-schema';
import { createValidator } from './validate';
import type { RouteSnapshot } from './snapshot';

const endpoints = new Map(loadFrontendEndpoints().map((endpoint) => [endpoint.key, endpoint]));
const statuses = loadSuccessStatuses();

const Ref = z.object({ id: zId, name: z.string() });
const StaffRow = z.object({
  id: zId,
  createdAt: zIsoDateTime,
  name: z.string(),
  email: z.string(),
  twofaEnabled: z.boolean(),
  mustChangePassword: z.boolean(),
  passwordChangedAt: zIsoDateTime.nullable(),
  suspendedAt: zIsoDateTime.nullable(),
  lastLoginAt: zIsoDateTime.nullable(),
  role: Ref,
  status: z.enum(['invited', 'active', 'suspended']),
  lastLoginIp: z.string().nullable(),
  activeSessions: z.number().int(),
  createdBy: Ref.nullable(),
  suspendedReason: z.string().nullable(),
  suspendedBy: Ref.nullable(),
  resetSentAt: zIsoDateTime.nullable().optional(),
});
const CreateBody = z.object({
  name: z.string().min(1),
  email: z.string(),
  roleId: zId,
  onboarding: z.enum(['invite', 'temporary_password']),
});

/** What the dump of a real contract looks like, built from zod schemas. */
function snapshotOf(key: string, parts: Partial<RouteSnapshot> & Pick<RouteSnapshot, 'success'>): RouteSnapshot {
  const [method = '', path = ''] = key.split(' ');
  return {
    key,
    method,
    path,
    pathParams: [...path.matchAll(/:(\w+)/g)].map((match) => match[1] as string),
    surface: 'admin',
    access: 'staff-permission',
    permission: 'staff:read',
    errors: [],
    queryIsList: false,
    ...parts,
  };
}

const compare = (route: RouteSnapshot): Finding[] => {
  const endpoint = endpoints.get(route.key);
  if (!endpoint) throw new Error(`no frontend function for ${route.key}`);
  return compareRoute(endpoint, route, statuses.get(route.key) ?? 0);
};
const brief = (found: Finding[]) =>
  found.filter((f) => f.severity === 'error').map((f) => `${f.part}:${f.rule}@${f.path}`);

const list = snapshotOf('GET /admin/staff', {
  queryIsList: true,
  success: { status: 200, list: true, schema: toJsonSchema(StaffRow, 'output'), alsoStatuses: [] },
});
const show = snapshotOf('GET /admin/staff/:id', {
  params: toJsonSchema(z.object({ id: zIdParam }), 'input'),
  success: { status: 200, list: false, schema: toJsonSchema(StaffRow, 'output'), alsoStatuses: [] },
});
const create = snapshotOf('POST /admin/staff', {
  body: toJsonSchema(CreateBody, 'input'),
  success: {
    status: 201,
    list: false,
    schema: toJsonSchema(StaffRow.extend({ temporaryPassword: z.string().optional() }), 'output'),
    alsoStatuses: [],
  },
});

describe('contracts a feature would write for the staff routes', () => {
  it('list, show and create match the console', () => {
    expect(compare(list)).toEqual([]);
    expect(compare(show)).toEqual([]);
    expect(compare(create)).toEqual([]);
  });

  it('the list fails when it is not a list route, and names the row path of a wrong enum', () => {
    const notList = {
      ...list,
      queryIsList: false,
      success: { ...list.success, list: false, schema: { type: 'array', items: list.success.schema } },
    };
    expect(brief(compare(notList))).toEqual(['response:list-result@data[]']);
    const narrower = toJsonSchema(StaffRow.extend({ status: z.enum(['active', 'locked']) }), 'output');
    const wrong = { ...list, success: { ...list.success, schema: narrower } };
    expect(brief(compare(wrong))).toEqual(['response:enum@data[].status']);
  });

  it('a nullable field the console reads as required and a dropped field are caught', () => {
    const schema = toJsonSchema(
      StaffRow.omit({ activeSessions: true }).extend({ name: z.string().nullable() }),
      'output',
    );
    expect(brief(compare({ ...show, success: { ...show.success, schema } })).sort()).toEqual([
      'response:missing-field@activeSessions',
      'response:nullable@name',
    ]);
  });

  it('the create route fails when its body drifts from what the console sends', () => {
    const body = toJsonSchema(CreateBody.extend({ onboarding: z.enum(['invite']), phone: z.string() }), 'input');
    expect(brief(compare({ ...create, body }))).toEqual([
      'request:enum@body.onboarding',
      'request:missing-field@body.phone',
    ]);
  });

  it('the success status is the documented one', () => {
    const wrong = { ...create, success: { ...create.success, status: 200 as const } };
    expect(brief(compare(wrong))).toEqual(['status:status@status']);
  });

  it('a path id the backend types differently is reported with params.<name>', () => {
    const params = toJsonSchema(z.object({ id: z.string() }), 'input');
    expect(brief(compare({ ...show, params }))).toEqual([]);
    const strictId = {
      type: 'object',
      properties: { id: { type: 'string', 'x-gsm-alias': 'Money' } },
      required: ['id'],
    };
    expect(brief(compare({ ...show, params: strictId }))).toEqual(['request:alias@params.id']);
  });
});

describe('the allowlist', () => {
  const entry: AllowlistEntry = {
    route: 'GET /admin/staff',
    path: 'data[].status',
    rule: 'enum',
    mismatch: 'B4',
    reason: 'The backend keeps a status the console does not know yet.',
  };
  const narrower = toJsonSchema(StaffRow.extend({ status: z.enum(['active', 'locked']) }), 'output');
  const found = compare({ ...list, success: { ...list.success, schema: narrower } });

  it('accepts exactly the finding it names', () => {
    expect(reconcile(found, [entry])).toEqual({ unexpected: [], stale: [] });
    expect(reconcile(found, [{ ...entry, path: 'data[].role' }]).unexpected.map(describeFinding)).toEqual([
      'GET /admin/staff [response] data[].status: backend value "locked" unknown to the frontend (enum)',
    ]);
    expect(reconcile(found, [{ ...entry, part: 'request' }]).unexpected).toHaveLength(1);
  });

  it('reports an entry that no longer matches anything as stale', () => {
    const clean = compare(list);
    expect(reconcile(clean, [entry])).toEqual({ unexpected: [], stale: [entry] });
  });

  it('never needs an entry for an info', () => {
    const extra = compare({
      ...list,
      success: { ...list.success, schema: toJsonSchema(StaffRow.extend({ nickname: z.string() }), 'output') },
    });
    expect(extra.map((f) => f.severity)).toEqual(['info']);
    expect(reconcile(extra, [])).toEqual({ unexpected: [], stale: [] });
  });

  it('rejects entries with an unknown B-id, an unknown rule, no reason or a duplicate', () => {
    const ids = loadMismatchIds();
    expect(ids.has('B4')).toBe(true);
    expect(validateEntries([entry], ids, RULES)).toEqual([]);
    const problems = validateEntries(
      [
        { ...entry, mismatch: 'B9999', path: 'c' },
        { ...entry, rule: 'nope' as never, path: 'a' },
        { ...entry, reason: '', path: 'b' },
        entry,
        entry,
      ],
      ids,
      RULES,
    );
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toContain('"B9999" is not a B-id');
    expect(problems.join('\n')).toContain('unknown rule "nope"');
    expect(problems.join('\n')).toContain('give a reason');
    expect(problems.join('\n')).toContain('listed twice');
  });
});

describe('fixtures against the response schema', () => {
  const ajv = createValidator();
  const row = { id: 1, status: 'active' };
  const route = snapshotOf('GET /admin/things', {
    queryIsList: true,
    success: {
      status: 200,
      list: true,
      schema: toJsonSchema(z.object({ id: zId, status: z.enum(['active', 'suspended']) }), 'output'),
      alsoStatuses: [],
    },
  });
  const fixture = (overrides: Partial<Fixture> = {}): Fixture => ({
    file: 'GET_admin_things.json',
    status: 200,
    headers: { 'x-total-count': '1' },
    body: [row],
    ...overrides,
  });
  const lines = (found: Finding[]) => found.map((f) => `${f.part}:${f.rule}@${f.path}`);

  it('accepts a fixture that fits and ignores a route without one', () => {
    expect(fixtureFindings(route, fixture(), ajv)).toEqual([]);
    expect(fixtureFindings(route, undefined, ajv)).toEqual([]);
  });

  it('names the row and the field that do not fit, as data[].field', () => {
    const found = fixtureFindings(route, fixture({ body: [row, { id: 2, status: 'locked' }] }), ajv);
    expect(lines(found)).toEqual(['fixture:fixture@data[].status']);
    expect(lines(fixtureFindings(route, fixture({ body: [{ id: 'x', status: 'active' }] }), ajv))).toEqual([
      'fixture:fixture@data[].id',
    ]);
  });

  it('wants x-total-count on a list and a 2xx status', () => {
    expect(lines(fixtureFindings(route, fixture({ headers: {} }), ajv))).toEqual(['fixture:fixture@x-total-count']);
    expect(lines(fixtureFindings(route, fixture({ status: 404 }), ajv))).toEqual(['fixture:fixture@status']);
  });

  it('writes instance paths like the comparator does', () => {
    expect(fixturePath('/0/status', true)).toBe('data[].status');
    expect(fixturePath('/checks/postgres', false)).toBe('checks.postgres');
    expect(fixturePath('/rows/3/tags/0', false)).toBe('rows[].tags[]');
    expect(fixturePath('', false)).toBe('');
  });
});

describe('an ideal contract written from the console own types', () => {
  /** What a perfect backend would declare for a console function: the schemas of its own shapes. */
  function idealContract(endpoint: ReturnType<typeof loadFrontendEndpoints>[number]): RouteSnapshot {
    const expected = statuses.get(endpoint.key) ?? 200;
    const used = endpoint.params.filter((p) => !['init', 'signal', 'fallbackName'].includes(p.name));
    const body = used.find((p) => p.name === 'body');
    const query = used.find((p) => p.name === 'query' || p.name === 'params');
    const scalars = used.filter((p) => p !== body && p !== query);
    const pathParams = [...endpoint.key.matchAll(/:(\w+)/g)].map((match) => match[1] as string);
    const list = endpoint.returnsText.startsWith('ListResult<');
    const returns = endpoint.returns;
    const rows = list ? returns?.object?.data?.array : undefined;
    const isVoid = !returns || returns.type === 'undefined';
    const isText = returns?.type === 'string' && !returns.alias;
    return {
      key: endpoint.key,
      method: endpoint.key.split(' ')[0] as string,
      path: endpoint.key.split(' ')[1] as string,
      pathParams,
      surface: 'admin',
      access: 'staff-permission',
      permission: 'x:read',
      errors: [],
      success: {
        // A documented redirect cannot be a contract status; the real route needs a decision (see the README).
        status: expected === 302 ? 200 : expected,
        alsoStatuses: [],
        list,
        ...(isText ? { contentType: 'text/csv' } : {}),
        ...(isVoid || isText || !returns ? {} : { schema: toSchema(rows ?? returns) }),
      },
      params: {
        type: 'object',
        properties: Object.fromEntries(
          pathParams.map((name, index) => {
            const given = scalars[index]?.shape;
            return [name, given?.alias === 'Id' ? { type: 'string', 'x-gsm-alias': 'Id' } : { type: 'string' }];
          }),
        ),
        required: pathParams,
      },
      queryIsList: query?.typeText.startsWith('ListQuery') === true,
      ...(query && !query.typeText.startsWith('ListQuery') ? { query: toSchema(query.shape) } : {}),
      ...(body ? { body: toSchema(body.shape) } : {}),
    };
  }
  const toSchema = (shape: Parameters<typeof shapeToSchema>[0]) => shapeToSchema(shape);

  it('passes for every one of the console routes', () => {
    const wrong: string[] = [];
    for (const endpoint of endpoints.values()) {
      const contract = idealContract(endpoint);
      const expected = statuses.get(endpoint.key) ?? 200;
      const found = compareRoute(endpoint, contract, expected === 302 ? 200 : expected).filter(
        (f) => f.severity === 'error',
      );
      for (const finding of found) wrong.push(describeFinding(finding));
    }
    expect(wrong).toEqual([]);
  });
});
