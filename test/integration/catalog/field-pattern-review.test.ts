// The one-time review of stored field patterns (decision 051): what it clears, what it leaves, what a clearing writes, that a staff save is
// never undone, and that the event the migration writes reaches it through the real queues. Real Postgres and Redis (a private BullMQ
// prefix), real workers; the waits are polls for the effect.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import { QueueWorkersModule } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import {
  FIELD_PATTERNS_REVIEW_EVENT,
  FIELD_PATTERNS_REVIEW_JOB,
  FIELD_PATTERN_CLEARED_AUDIT_ACTION,
  FieldPatternReview,
  FieldPatternReviewModule,
} from '@src/modules/catalog';
import { OutboxRelayModule, OutboxRouteRegistry } from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventually } from '../../support/infra';
import { migrationSql, migrationStatements } from '../../support/migration-files';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

setDefaultTimeout(120_000);

const prefix = testBullPrefix();
let t: TestApp;
let db: Awaited<ReturnType<typeof testDb>>['db'];
let review: FieldPatternReview;
let staff: AdminApi;
let categoryId: number;

beforeAll(async () => {
  t = await createTestApp({
    imports: [QueueWorkersModule, OutboxRelayModule, FieldPatternReviewModule],
    env: { BULL_PREFIX: prefix },
  });
  ({ db } = await testDb());
  review = t.app.get(FieldPatternReview, { strict: false });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['catalog:*'], { name: 'Lina S.' });
  categoryId = await insertCategory(db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

/** Inserts a service with one field per entry of `fields` (key and pattern). */
async function serviceWith(fields: ReadonlyArray<readonly [string, string]>): Promise<number> {
  const serviceId = await insertService(db, categoryId);
  await db
    .insert(s.serviceFields)
    .values(fields.map(([key, regex], index) => ({ serviceId, key, label: key, regex, sort: index })));
  return serviceId;
}

const patternsOf = async (serviceId: number) =>
  (
    await db
      .select()
      .from(s.serviceFields)
      .where(eq(s.serviceFields.serviceId, serviceId))
      .orderBy(asc(s.serviceFields.sort))
  ).map((row) => [row.key, row.regex]);
const clearedAudits = () =>
  db.select().from(s.auditLogs).where(eq(s.auditLogs.action, FIELD_PATTERN_CLEARED_AUDIT_ACTION));

describe('FieldPatternReview.run', () => {
  it('clears every stored pattern outside the supported form, once, with an audit row each, and keeps the others', async () => {
    const first = await serviceWith([
      ['nested', '^(a+)+$'],
      ['imei', '^[0-9]{15}$'],
      ['none', ''],
    ]);
    const second = await serviceWith([
      ['broken', '([0-9'],
      ['short', '^.{1,50}$'],
    ]);

    expect(await review.run()).toEqual({ checked: 4, cleared: 2 });

    expect(await patternsOf(first)).toEqual([
      ['nested', ''],
      ['imei', '^[0-9]{15}$'],
      ['none', ''],
    ]);
    expect(await patternsOf(second)).toEqual([
      ['broken', ''],
      ['short', '^.{1,50}$'],
    ]);
    const audits = (await clearedAudits()).sort((a, b) => a.id - b.id);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      action: FIELD_PATTERN_CLEARED_AUDIT_ACTION,
      entityType: 'service',
      entityId: first,
      before: { field: 'nested', regex: '^(a+)+$' },
      after: { field: 'nested', regex: '' },
    });
    expect(audits[1]).toMatchObject({ entityId: second, before: { field: 'broken', regex: '([0-9' } });

    // A second pass finds nothing to clear and writes nothing.
    expect(await review.run()).toEqual({ checked: 2, cleared: 0 });
    expect(await clearedAudits()).toHaveLength(2);
  });

  it('leaves a field a staff save changed meanwhile', async () => {
    const serviceId = await serviceWith([['d', '^(a+)+$']]);
    const database = t.app.get(DbService, { strict: false });
    const runInTransaction = database.runInTransaction.bind(database);
    let raced = false;
    database.runInTransaction = (async (...args: Parameters<typeof runInTransaction>) => {
      if (!raced) {
        raced = true;
        // A staff save lands between the page read and the clearing.
        const saved = await staff.put(`/admin/services/${serviceId}/fields`, {
          fields: [
            {
              key: 'd',
              label: 'D',
              fieldType: 'text',
              required: false,
              options: [],
              regex: '^[0-9]+$',
              supplierKey: '',
            },
          ],
        });
        expect(saved.status).toBe(200);
      }
      return runInTransaction(...args);
    }) as typeof database.runInTransaction;
    try {
      // The save replaced the field's row: the pass reads the new row too (it is in the supported form) and clears nothing.
      expect(await review.run()).toEqual({ checked: 2, cleared: 0 });
    } finally {
      database.runInTransaction = runInTransaction;
    }
    expect(await patternsOf(serviceId)).toEqual([['d', '^[0-9]+$']]);
    expect(await clearedAudits()).toHaveLength(0);
  });

  it('leaves a field whose pattern was replaced after it was judged, even when the field row is the same', async () => {
    const serviceId = await serviceWith([['d', '^(a+)+$']]);
    const database = t.app.get(DbService, { strict: false });
    const runInTransaction = database.runInTransaction.bind(database);
    let raced = false;
    database.runInTransaction = (async (...args: Parameters<typeof runInTransaction>) => {
      if (!raced) {
        raced = true;
        await db.update(s.serviceFields).set({ regex: '^[a-z]+$' }).where(eq(s.serviceFields.serviceId, serviceId));
      }
      return runInTransaction(...args);
    }) as typeof database.runInTransaction;
    try {
      expect(await review.run()).toEqual({ checked: 1, cleared: 0 });
    } finally {
      database.runInTransaction = runInTransaction;
    }
    expect(await patternsOf(serviceId)).toEqual([['d', '^[a-z]+$']]);
    expect(await clearedAudits()).toHaveLength(0);
  });

  it('walks past one page of fields', async () => {
    const serviceId = await serviceWith(Array.from({ length: 600 }, (_, index) => [`k${index}`, '^(a+)+$'] as const));

    expect(await review.run()).toEqual({ checked: 600, cleared: 600 });

    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.serviceFields)
      .where(and(eq(s.serviceFields.serviceId, serviceId), sql`${s.serviceFields.regex} <> ''`));
    expect(left!.n).toBe(0);
    expect(await clearedAudits()).toHaveLength(600);
  });
});

describe('how the review is asked for', () => {
  it('is routed to its job, under the event the migration writes', () => {
    expect(t.app.get(OutboxRouteRegistry, { strict: false }).get(FIELD_PATTERNS_REVIEW_EVENT)).toEqual({
      type: 'catalog.field_patterns_review',
      queue: 'maintenance',
      jobName: FIELD_PATTERNS_REVIEW_JOB,
    });
    expect(migrationSql('_supplier_safety.sql')).toContain(`'${FIELD_PATTERNS_REVIEW_EVENT}'`);
  });

  it("runs the review from the migration's event through the real queues", async () => {
    const serviceId = await serviceWith([
      ['nested', '^(a+)+$'],
      ['imei', '^[0-9]{15}$'],
    ]);
    const statement = migrationStatements('_supplier_safety.sql').find((text) =>
      text.startsWith('INSERT INTO "outbox_events"'),
    )!;
    expect(statement).toBeDefined();

    await db.execute(sql.raw(statement));

    const [event] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, FIELD_PATTERNS_REVIEW_EVENT));
    expect(event).toMatchObject({ aggregateType: 'service_fields' });
    const patterns = await eventually(async () => {
      const found = await patternsOf(serviceId);
      return found.find(([key]) => key === 'nested')?.[1] === '' ? found : undefined;
    }, 30_000);
    expect(patterns).toEqual([
      ['nested', ''],
      ['imei', '^[0-9]{15}$'],
    ]);
    expect(await clearedAudits()).toHaveLength(1);
  });
});
