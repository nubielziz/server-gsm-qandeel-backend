// Integration tests of the application role's grants step (decision 055) against the test database. They create roles with random names in
// the test cluster (cluster-wide, so parallel runs never meet) and drop them in afterAll; a crashed run can leave one named gsm_t_<hex>, harmless.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { APPEND_ONLY_TABLES, GRANTS_LOCK_KEY, GrantsRefusedError, applyApplicationGrants } from '@src/infra/db';
import { TEST_DATABASE_URL, migrateTestDb } from '../../support/db';
import { eventually } from '../../support/infra';
import { rejectionOf } from '../../support/rejection';

/** What a connection made as another role said. */
const sqlState = (error: unknown): string | undefined => (error as { code?: string }).code;

const roles: string[] = [];
const pools: Pool[] = [];
let owner: Pool;

/** A role name and password that belong to this run alone. */
function newRole(): { role: string; password: string } {
  const role = `gsm_t_${randomBytes(4).toString('hex')}`;
  roles.push(role);
  return { role, password: randomBytes(12).toString('hex') };
}

/** The test database's URL with another user and password. */
function urlFor(role: string, password: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** A pool that connects as a role; it is ended in afterAll. */
function poolAs(role: string, password: string): Pool {
  const pool = new Pool({ connectionString: urlFor(role, password), max: 1 });
  pool.on('error', () => undefined);
  pools.push(pool);
  return pool;
}

beforeAll(async () => {
  await migrateTestDb();
  owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  owner.on('error', () => undefined);
});

afterAll(async () => {
  for (const pool of pools) await pool.end();
  for (const role of roles) {
    await owner.query(`drop owned by "${role}"`).catch(() => undefined);
    await owner.query(`drop role if exists "${role}"`);
  }
  await owner.end();
});

describe('applyApplicationGrants', () => {
  const app = newRole();
  const appUrl = urlFor(app.role, app.password);

  it('creates the role, then updates it on the next run', async () => {
    const first = await applyApplicationGrants(TEST_DATABASE_URL, appUrl);
    expect(first).toMatchObject({ kind: 'granted', role: app.role, created: true });
    expect(first.kind === 'granted' && first.tables).toBeGreaterThan(50);
    expect(await applyApplicationGrants(TEST_DATABASE_URL, appUrl)).toMatchObject({
      kind: 'granted',
      role: app.role,
      created: false,
    });
    const { rows } = await owner.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      'select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin from pg_roles where rolname = $1',
      [app.role],
    );
    expect(rows).toEqual([
      {
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: true,
      },
    ]);
  });

  it('gives the role what the application does, and not what it must never do', async () => {
    await applyApplicationGrants(TEST_DATABASE_URL, appUrl);
    const as = poolAs(app.role, app.password);

    // What the code needs: reads and writes of the ordinary tables, inserts into the append-only ones, sequences, the migration list.
    expect((await as.query('select count(*)::int as n from staff_users')).rows).toHaveLength(1);
    const client = await as.connect();
    try {
      await client.query('begin');
      await client.query(
        "insert into audit_logs (actor_type, action, entity_type, entity_id) values ('system', 'grants test', 'test', 1)",
      );
      await client.query("insert into settings (key, value) values ('gsmGrantsProbe', 'true'::jsonb)");
      await client.query("update settings set value = 'false'::jsonb where key = 'gsmGrantsProbe'");
      await client.query("delete from settings where key = 'gsmGrantsProbe'");
      await client.query('rollback');
    } finally {
      client.release();
    }
    expect((await as.query("select nextval('inventory_batch_ref_seq')")).rows).toHaveLength(1);
    expect((await as.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0]).toMatchObject({
      n: expect.any(Number),
    });
    expect((await as.query('select rolsuper from pg_roles where rolname = current_user')).rows).toEqual([
      { rolsuper: false },
    ]);

    // What it must never do: change or empty the append-only tables, switch their triggers off, change the schema, skip triggers.
    const refused = [
      "update audit_logs set action = 'x'",
      'delete from audit_logs',
      "update order_events set type = 'x'",
      'delete from order_events',
      'update ledger_entries set amount = amount',
      'delete from ledger_transactions',
      // Decision 064: the three history tables of the one account type only receive new rows.
      'update account_legacy_ids set merged = merged',
      'delete from account_legacy_ids',
      'update account_rank_changes set moved_amount = moved_amount',
      'delete from account_rank_changes',
      'update wallet_action_keys set action = action',
      'delete from wallet_action_keys',
      'truncate account_rank_changes',
      'truncate ledger_entries',
      'truncate audit_logs',
      'truncate staff_users',
      'alter table ledger_entries disable trigger ledger_entries_append_only',
      'alter table ledger_entries disable trigger all',
      'set session_replication_role = replica',
      'create table gsm_t_x (id int)',
      'drop table settings',
      'alter table settings add column gsm_t_x int',
      'create role gsm_t_other',
    ];
    for (const statement of refused) {
      const error = await rejectionOf(as.query(statement));
      expect(sqlState(error), statement).toBe('42501');
    }
    // The tables are as they were: nothing above reached them.
    const appendOnly = new Set<string>([
      ...APPEND_ONLY_TABLES,
      'account_legacy_ids',
      'account_rank_changes',
      'wallet_action_keys',
    ]);
    for (const table of ['account_legacy_ids', 'account_rank_changes', 'wallet_action_keys']) {
      expect(APPEND_ONLY_TABLES as readonly string[], `${table} is in APPEND_ONLY_TABLES`).toContain(table);
    }
    for (const table of appendOnly) {
      const { rows } = await owner.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants where grantee = $1 and table_name = $2`,
        [app.role, table],
      );
      expect(rows.map((row) => row.privilege_type).sort(), table).toEqual(['INSERT', 'SELECT']);
    }
  });

  it('creates the role with a SCRAM-SHA-256 verifier, never the password, and the role signs in with the password', async () => {
    const fresh = newRole();
    const freshUrl = urlFor(fresh.role, fresh.password);
    await applyApplicationGrants(TEST_DATABASE_URL, freshUrl);
    const stored = async (): Promise<string> =>
      (await owner.query<{ rolpassword: string }>('select rolpassword from pg_authid where rolname = $1', [fresh.role]))
        .rows[0]?.rolpassword ?? '';
    const first = await stored();
    expect(first).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(first).not.toContain(fresh.password);

    // The verifier works with the password: a real sign-in over the wire, as the application does.
    const as = poolAs(fresh.role, fresh.password);
    expect((await as.query('select current_user as name')).rows).toEqual([{ name: fresh.role }]);
    // A different password does not.
    const wrong = new Pool({ connectionString: urlFor(fresh.role, `${fresh.password}x`), max: 1 });
    wrong.on('error', () => undefined);
    pools.push(wrong);
    expect(sqlState(await rejectionOf(wrong.query('select 1')))).toBe('28P01');

    // A later run alters the role in the same way (a new salt) and the same password still signs in.
    await applyApplicationGrants(TEST_DATABASE_URL, freshUrl);
    const second = await stored();
    expect(second).not.toBe(first);
    expect(second).not.toContain(fresh.password);
    const again = new Pool({ connectionString: freshUrl, max: 1 });
    again.on('error', () => undefined);
    pools.push(again);
    expect((await again.query('select 1 as ok')).rows).toEqual([{ ok: 1 }]);
  });

  it('sends the verifier to the server and the password nowhere', async () => {
    const quiet = newRole();
    // Everything a connection of this process sends as a query (text and values) during the run.
    const sent: string[] = [];
    const prototype = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const original = prototype.query;
    prototype.query = function (this: unknown, ...args: unknown[]) {
      sent.push(JSON.stringify(args));
      return original.apply(this, args);
    };
    try {
      await applyApplicationGrants(TEST_DATABASE_URL, urlFor(quiet.role, quiet.password));
    } finally {
      prototype.query = original;
    }
    expect(sent.length).toBeGreaterThan(10);
    expect(sent.some((text) => text.includes('SCRAM-SHA-256$4096:'))).toBe(true);
    expect(sent.filter((text) => text.includes(quiet.password))).toEqual([]);
  });

  it('makes a run that meets another wait for it', async () => {
    const waiting = newRole();
    const waitingUrl = urlFor(waiting.role, waiting.password);
    const holder = await owner.connect();
    let released = false;
    try {
      // Another run holds the step's lock.
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock($1)', [GRANTS_LOCK_KEY]);
      const run = applyApplicationGrants(TEST_DATABASE_URL, waitingUrl);
      // The run queues on that very key (a key is an int8 split over classid and objid in pg_locks).
      await eventually(async () => {
        const { rows } = await owner.query<{ waiting: number }>(
          `select count(*)::int as waiting from pg_locks
            where locktype = 'advisory' and not granted and ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
          [GRANTS_LOCK_KEY],
        );
        return (rows[0]?.waiting ?? 0) >= 1 ? true : undefined;
      });
      // While it waits it has changed nothing and has not finished.
      expect((await owner.query('select 1 from pg_roles where rolname = $1', [waiting.role])).rows).toHaveLength(0);
      expect(await Promise.race([run.then(() => 'finished'), Promise.resolve('waiting')])).toBe('waiting');
      await holder.query('commit');
      released = true;
      expect(await run).toMatchObject({ kind: 'granted', role: waiting.role, created: true });
    } finally {
      if (!released) await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
  });

  it('lets two runs at once both finish: one creates the role, the other updates it', async () => {
    const pair = newRole();
    const pairUrl = urlFor(pair.role, pair.password);
    const outcomes = await Promise.all([
      applyApplicationGrants(TEST_DATABASE_URL, pairUrl),
      applyApplicationGrants(TEST_DATABASE_URL, pairUrl),
    ]);
    const created = outcomes.map((outcome) => outcome.kind === 'granted' && outcome.created);
    expect(created.filter(Boolean)).toHaveLength(1);
    const as = poolAs(pair.role, pair.password);
    expect((await as.query('select current_user as name')).rows).toEqual([{ name: pair.role }]);
  });

  it('refuses an application role that is a superuser, and leaves it as it was', async () => {
    const power = newRole();
    await owner.query(`create role "${power.role}" login superuser password '${power.password}'`);
    const error = await rejectionOf(applyApplicationGrants(TEST_DATABASE_URL, urlFor(power.role, power.password)));
    expect(error).toBeInstanceOf(GrantsRefusedError);
    expect((error as Error).message).toContain('is a superuser or owns tables');
    expect((await owner.query('select rolsuper from pg_roles where rolname = $1', [power.role])).rows).toEqual([
      { rolsuper: true },
    ]);
  });

  it('refuses an application role that owns a table', async () => {
    const holder = newRole();
    const table = `gsm_t_owned_${randomBytes(3).toString('hex')}`;
    await owner.query(`create role "${holder.role}" login password '${holder.password}'`);
    await owner.query(`create table "${table}" (id int)`);
    try {
      await owner.query(`alter table "${table}" owner to "${holder.role}"`);
      const error = await rejectionOf(applyApplicationGrants(TEST_DATABASE_URL, urlFor(holder.role, holder.password)));
      expect(error).toBeInstanceOf(GrantsRefusedError);
    } finally {
      await owner.query(`drop table if exists "${table}"`);
    }
  });

  it('does nothing when the application connects as the owner', async () => {
    expect(await applyApplicationGrants(TEST_DATABASE_URL, TEST_DATABASE_URL)).toEqual({
      kind: 'same_role',
      role: new URL(TEST_DATABASE_URL).username,
    });
  });

  it('stops with an error and no role when the owner cannot connect', async () => {
    const broken = newRole();
    const unreachable = new URL(TEST_DATABASE_URL);
    unreachable.port = '1';
    const error = await rejectionOf(
      applyApplicationGrants(unreachable.toString(), urlFor(broken.role, broken.password)),
    );
    expect(error).toBeInstanceOf(Error);
    expect((await owner.query('select 1 from pg_roles where rolname = $1', [broken.role])).rows).toHaveLength(0);
  });
});
