// The Dhru fixtures (decision 026, brief 7a): one request/response record per action in `fixtures/`, written from the decision, checked against
// the real application byte for byte on keys (spelling, order, the exact key set) and on types. Values that vary (ids, money, texts) are type
// tokens (`$idtext`, `$money`, ...); every other value must be equal. A fixture never gets looser to make a test pass: change the decision first.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { DbService, schema as s } from '../../src/infra/db';
import { OrderTransitions } from '../../src/modules/orders';
import { MaintenanceService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  type MachineCredentials,
  body,
  clearApiKeyCaches,
  credentialsFor,
  dhruClient,
} from '../support/machine-orders';
import { IMEIS, type OrdersWorld, ordersWorld } from '../support/orders';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures');

/** What a fixture file holds. */
interface Fixture {
  readonly action: string;
  readonly description: string;
  readonly request: { readonly action: string; readonly parameters?: unknown };
  /** `wrong-key`: send a key that does not exist; `poor`: a merchant whose wallet cannot cover an order. */
  readonly credentials?: 'wrong-key' | 'poor';
  /** Extra setup: `priceRaised` lists the services, then raises the price of the automatic service by more than the tolerance. */
  readonly given?: readonly string[];
  /** Compare the entry of this service in the list instead of the whole answer. */
  readonly pick?: { readonly service: 'server' };
  readonly response: unknown;
}

const TOKENS: Readonly<Record<string, (value: unknown) => boolean>> = {
  $string: (value) => typeof value === 'string',
  $integer: (value) => Number.isInteger(value),
  $money: (value) => typeof value === 'string' && /^-?\d+\.\d{4}$/.test(value),
  $idtext: (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value),
  $digits: (value) => typeof value === 'string' && /^\d+$/.test(value),
  $flag: (value) => value === '0' || value === '1',
  $list: (value) => Array.isArray(value),
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Compares an answer with a fixture template and lists every difference.
 *
 * @param actual what the application sent
 * @param template the fixture: objects must have exactly the template's keys in the template's order (a `*` key stands for any
 *   number of keys whose values all match it), arrays the template's length, `$tokens` any value of that type, anything else an equal value
 * @param path where we are, for the messages
 * @returns the differences, empty when the answer matches
 */
export function shapeProblems(actual: unknown, template: unknown, path = '$'): string[] {
  if (typeof template === 'string' && template.startsWith('$') && template in TOKENS) {
    return TOKENS[template]!(actual) ? [] : [`${path}: ${JSON.stringify(actual)} is not ${template}`];
  }
  if (Array.isArray(template)) {
    if (!Array.isArray(actual)) return [`${path}: expected a list, got ${JSON.stringify(actual)}`];
    if (actual.length !== template.length)
      return [`${path}: expected ${template.length} item(s), got ${actual.length}`];
    return template.flatMap((item, index) => shapeProblems(actual[index], item, `${path}[${index}]`));
  }
  if (isObject(template)) {
    if (!isObject(actual)) return [`${path}: expected an object, got ${JSON.stringify(actual)}`];
    const wildcard = template['*'];
    if (wildcard !== undefined) {
      const keys = Object.keys(actual);
      return [
        ...(keys.length === 0 ? [`${path}: expected at least one key`] : []),
        ...keys.flatMap((key) => shapeProblems(actual[key], wildcard, `${path}.${key}`)),
      ];
    }
    const want = Object.keys(template);
    const have = Object.keys(actual);
    if (want.join('\u0000') !== have.join('\u0000'))
      return [`${path}: keys are [${have.join(', ')}], expected [${want.join(', ')}]`];
    return want.flatMap((key) => shapeProblems(actual[key], template[key], `${path}.${key}`));
  }
  return actual === template && typeof actual === typeof template
    ? []
    : [`${path}: ${JSON.stringify(actual)} is not ${JSON.stringify(template)}`];
}

describe('the fixture matcher itself', () => {
  it('rejects a misspelled key, an extra key, a wrong type, a wrong order and a wrong length', () => {
    const template = { SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: '$idtext' }], apiversion: '6.1' };
    expect(
      shapeProblems({ SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: '12' }], apiversion: '6.1' }, template),
    ).toEqual([]);
    expect(
      shapeProblems({ SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 12 }], apiversion: '6.1' }, template),
    ).toHaveLength(1);
    expect(
      shapeProblems({ SUCCESS: [{ MESSAGE: 'Order received', ReferenceId: '12' }], apiversion: '6.1' }, template),
    ).toHaveLength(1);
    expect(
      shapeProblems(
        { SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: '12', extra: 1 }], apiversion: '6.1' },
        template,
      ),
    ).toHaveLength(1);
    expect(
      shapeProblems({ apiversion: '6.1', SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: '12' }] }, template),
    ).toHaveLength(1);
    expect(shapeProblems({ SUCCESS: [], apiversion: '6.1' }, template)).toHaveLength(1);
    expect(
      shapeProblems({ SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: '12' }], apiversion: 6.1 }, template),
    ).toHaveLength(1);
    expect(shapeProblems({}, { '*': '$string' })).toHaveLength(1);
    expect(shapeProblems({ a: 'x', b: 1 }, { '*': '$string' })).toHaveLength(1);
    expect(shapeProblems('1.0000', '$money')).toEqual([]);
    expect(shapeProblems('1.00', '$money')).toHaveLength(1);
  });
});

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let creds: MachineCredentials;
let dhru: ReturnType<typeof dhruClient>;
let fileServiceId: number;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await t.app.get(MaintenanceService).invalidate();
  const { db } = await testDb();
  world = await ordersWorld(db);
  const category = await insertCategory(db, { name: 'Files', type: 'file' });
  fileServiceId = await insertService(db, category, {
    type: 'file',
    name: 'Firmware flash',
    code: 'FILE-3',
    basePrice: '3.0000',
  });
  creds = await credentialsFor(t, db, world.merchant.id);
  dhru = dhruClient(t, creds);
});

/** Moves an order the way staff or the supplier jobs do. */
async function move(
  orderId: number,
  action: { kind: 'accept' } | { kind: 'reply' } | { kind: 'reject' },
  text = 'done',
) {
  const db = t.app.get(DbService, { strict: false });
  await db.runInTransaction(({ tx }) =>
    t.app.get(OrderTransitions).apply(tx, {
      orderId,
      action,
      actor: { type: 'staff', id: 1 },
      ...(action.kind === 'reply' ? { code: text } : action.kind === 'reject' ? { reason: text } : {}),
    }),
  );
}

/** Places an order over Dhru and returns its id. */
async function placed(action: string, parameters: Record<string, unknown>): Promise<number> {
  const answer = await dhru.call(action, parameters);
  expect(answer.SUCCESS, JSON.stringify(answer)).toBeDefined();
  return Number(answer.SUCCESS[0].REFERENCEID);
}

/** Builds the values a fixture's `{{name}}` placeholders stand for, only the ones the fixture uses. */
async function valuesFor(text: string): Promise<Record<string, string>> {
  const { db } = await testDb();
  const values: Record<string, string> = {
    auto: String(world.auto.serviceId),
    manual: String(world.manual.serviceId),
    server: String(world.server.serviceId),
    file: String(fileServiceId),
  };
  const wants = (name: string) => text.includes(`{{${name}}}`);
  if (wants('order'))
    values.order = String(await placed('placeimeiorder', { ID: world.auto.serviceId, IMEI: IMEIS[0] }));
  if (wants('completed')) {
    const id = await placed('placeimeiorder', { ID: world.auto.serviceId, IMEI: IMEIS[1] });
    await move(id, { kind: 'reply' }, 'Unlocked: code 8842 1113');
    values.completed = String(id);
  }
  if (wants('rejected')) {
    const id = await placed('placeimeiorder', { ID: world.auto.serviceId, IMEI: IMEIS[2] });
    await move(id, { kind: 'reject' }, 'Carrier refused the IMEI');
    values.rejected = String(id);
  }
  if (wants('processing')) {
    const id = await placed('placeimeiorder', { ID: world.manual.serviceId, IMEI: IMEIS[3] });
    await move(id, { kind: 'accept' });
    values.processing = String(id);
  }
  if (wants('fileOrder')) {
    const id = await placed('placefileorder', { ID: fileServiceId, FILENAME: 'in.bin', FILEDATA: 'AAECAw==' });
    const [input] = await db.select({ file: s.orders.inputFileId }).from(s.orders).where(eq(s.orders.id, id));
    const [source] = await db.select().from(s.files).where(eq(s.files.id, input!.file!));
    const [result] = await db
      .insert(s.files)
      .values({
        bucket: source!.bucket,
        key: 'files/test/result',
        filename: 'out.zip',
        mime: 'application/zip',
        size: 3,
        sha256: 'aa',
        ownerType: 'staff',
        ownerId: 1,
      })
      .returning({ id: s.files.id });
    await db.update(s.orders).set({ resultFileId: result!.id }).where(eq(s.orders.id, id));
    await move(id, { kind: 'reply' }, 'Done');
    values.fileOrder = String(id);
  }
  return values;
}

/** Replaces `{{name}}` in every string of a JSON value. */
function fill(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === 'string')
    return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? `{{${name}}}`);
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (isObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner, values)]));
  return value;
}

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({ name, fixture: JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture }));

describe('the fixtures', () => {
  it('cover the eight actions of the map and the standard errors', () => {
    const actions = new Set(fixtures.map(({ fixture }) => fixture.action));
    for (const action of [
      'accountinfo',
      'imeiservicelist',
      'placeimeiorder',
      'placeimeiorderbulk',
      'getimeiorder',
      'getimeiorderbulk',
      'placefileorder',
      'getfileorder',
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
    expect(fixtures.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['error.authentication-failed.json', 'error.invalid-action.json']),
    );
  });

  for (const { name, fixture } of fixtures) {
    it(`${name}: ${fixture.description}`, async () => {
      const { db } = await testDb();
      const values = await valuesFor(JSON.stringify(fixture.request));
      if (fixture.given?.includes('priceRaised')) {
        await dhru.call('imeiservicelist');
        await db.update(s.services).set({ basePrice: '25.0000' }).where(eq(s.services.id, world.auto.serviceId));
      }
      let client = dhru;
      if (fixture.credentials === 'poor') {
        const { insertWalletMerchant, fundWallet } = await import('../support/money');
        const merchant = await insertWalletMerchant(db, { name: 'Poor Co' });
        await fundWallet(db, merchant.id, '10');
        client = dhruClient(t, await credentialsFor(t, db, merchant.id));
      }
      const request = fill(fixture.request, values) as Fixture['request'];
      const res = await client.raw(
        request.action,
        request.parameters,
        fixture.credentials === 'wrong-key' ? { apiaccesskey: 'gsm_wrongwrongwrongwrongwrong' } : {},
      );
      // Every answer on the surface: HTTP 200, JSON, the two Dhru headers.
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['x-powered-by']).toBe('DHRU-FUSION');
      expect(res.headers['dhru-fusion-api-version']).toBe('6.1');
      let answer: unknown = body(res);
      if (fixture.pick) {
        const list = (answer as { SUCCESS: Array<{ LIST: Record<string, { SERVICES: Record<string, unknown> }> }> })
          .SUCCESS[0]!.LIST;
        answer = Object.values(list)
          .map((group) => group.SERVICES[String(world.server.serviceId)])
          .find((entry) => entry !== undefined);
      }
      expect(shapeProblems(answer, fixture.response), JSON.stringify(answer)).toEqual([]);
      // The envelope starts with its list, like the standard: the serialized text, not only the parsed keys.
      if (!fixture.pick && isObject(fixture.response)) {
        const first = Object.keys(fixture.response)[0]!;
        if (first !== '*') expect(res.body.startsWith(`{${JSON.stringify(first)}:`)).toBe(true);
      }
    });
  }
});
