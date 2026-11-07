// Drizzle queries of the IP rule routes on `ip_rules` (identity module): the rule with its creator, the live-rule list, the
// duplicate check and the writes. The rule cache and the hit counters have their own files in `security/ip-rules/`.
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type IpRule, type IpRuleKind, type IpRuleScope, ipRules, staffUsers } from '../db/schema';

/** A rule with the staff member who created it. */
export interface IpRuleRow {
  readonly rule: IpRule;
  readonly createdBy: { readonly id: number; readonly name: string } | null;
}

const COLUMNS: ListColumns = {
  id: ipRules.id,
  kind: ipRules.kind,
  scope: ipRules.scope,
  source: ipRules.source,
  createdAt: ipRules.createdAt,
  hitCount: ipRules.hitCount,
  expiresAt: ipRules.expiresAt,
  cidr: sql`${ipRules.cidr}::text`,
  label: ipRules.label,
  reason: ipRules.reason,
};

function selectRows(db: DbExecutor) {
  return db
    .select({ rule: ipRules, creatorId: staffUsers.id, creatorName: staffUsers.name })
    .from(ipRules)
    .leftJoin(staffUsers, eq(staffUsers.id, ipRules.createdBy));
}

function toRow(row: { rule: IpRule; creatorId: number | null; creatorName: string | null }): IpRuleRow {
  return {
    rule: row.rule,
    createdBy: row.creatorId === null ? null : { id: row.creatorId, name: row.creatorName ?? '' },
  };
}

/** A rule counts as live until its `expires_at`. */
const live = (now: Date) => or(isNull(ipRules.expiresAt), gt(ipRules.expiresAt, now));

/**
 * Lists the live rules for `GET /admin/ip-rules`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @param now the current time: rules that expired before it are left out so `x-total-count` matches what is shown
 * @returns the page of rules and the exact total
 */
export async function listLiveIpRuleRows(
  db: DbExecutor,
  query: ParsedListQuery<'createdAt' | 'hitCount' | 'expiresAt' | 'id'>,
  now: Date,
): Promise<{ rows: IpRuleRow[]; total: number }> {
  const where = listWhere(query, COLUMNS, live(now));
  const [rows, [count]] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, ipRules.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(ipRules)
      .where(where),
  ]);
  return { rows: rows.map(toRow), total: count?.total ?? 0 };
}

/**
 * Finds one rule, expired or not.
 *
 * @param db the database or a transaction
 * @param id the rule id
 * @returns the rule with its creator, or `undefined`
 */
export async function findIpRuleRow(db: DbExecutor, id: number): Promise<IpRuleRow | undefined> {
  const [row] = await selectRows(db).where(eq(ipRules.id, id)).limit(1);
  return row ? toRow(row) : undefined;
}

/**
 * Finds a rule and locks it for the rest of the transaction.
 *
 * @param db the transaction
 * @param id the rule id
 * @returns the rule, or `undefined`
 */
export async function lockIpRule(db: DbExecutor, id: number): Promise<IpRule | undefined> {
  const [row] = await db.select().from(ipRules).where(eq(ipRules.id, id)).for('update').limit(1);
  return row;
}

/**
 * Finds a live rule that a new rule would duplicate: the same network and kind (and, for blocks, the same scope).
 *
 * @param db the database or a transaction
 * @param probe the stored cidr text, the kind and (for a block) the scope
 * @param now the current time
 * @returns the rule that is already there, or `undefined`
 */
export async function findLiveDuplicate(
  db: DbExecutor,
  probe: { readonly cidr: string; readonly kind: IpRuleKind; readonly scope: IpRuleScope },
  now: Date,
): Promise<IpRule | undefined> {
  const [row] = await db
    .select()
    .from(ipRules)
    .where(
      and(
        sql`${ipRules.cidr} = ${probe.cidr}::cidr`,
        eq(ipRules.kind, probe.kind),
        probe.kind === 'block' ? eq(ipRules.scope, probe.scope) : undefined,
        live(now),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Inserts a rule.
 *
 * @param db the database or a transaction
 * @param row the new rule
 * @returns the stored rule
 */
export async function insertIpRuleRow(
  db: DbExecutor,
  row: Pick<IpRule, 'kind' | 'scope' | 'cidr' | 'label' | 'reason' | 'expiresAt' | 'createdBy' | 'createdAt'>,
): Promise<IpRule> {
  const [created] = await db
    .insert(ipRules)
    .values({ ...row, source: 'manual' })
    .returning();
  return created!;
}

/**
 * Deletes a rule.
 *
 * @param db the database or a transaction
 * @param id the rule id
 */
export async function deleteIpRuleRow(db: DbExecutor, id: number): Promise<void> {
  await db.delete(ipRules).where(eq(ipRules.id, id));
}

/** The advisory lock key of every change to the rules or the restriction (a fixed number, see `lockOwnerChanges`). */
const IP_RULES_LOCK_KEY = 7_201_002;

/**
 * Serialises the changes that can lock the caller out for the rest of the transaction.
 *
 * Why: two staff members removing two different allow rules at once could each leave the other without access; the second
 * waits for the first and judges the rules again.
 *
 * Side effects: takes `pg_advisory_xact_lock`, released at commit or rollback.
 *
 * @param db the transaction
 */
export async function lockIpRuleChanges(db: DbExecutor): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(${IP_RULES_LOCK_KEY})`);
}
