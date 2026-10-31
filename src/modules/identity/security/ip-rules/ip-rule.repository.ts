// Queries of the IP rule cache and of the hit-counter flush (identity module, table ip_rules). Drizzle only; no business rules.
import { asc, gt, isNull, or, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../../infra/db';
import type { ActiveIpRule } from './ip-rule-matcher';

/**
 * Loads the IP rules that have not expired.
 *
 * Why: the cache holds only live rules (scenario ip-rules step 4); a rule whose `expires_at` has passed is not loaded, and
 * one that expires while cached is skipped by the matcher.
 *
 * @param db the database or a transaction
 * @returns the live rules, oldest first
 */
export async function loadLiveIpRules(db: DbExecutor): Promise<ActiveIpRule[]> {
  const rows = await db
    .select({
      id: s.ipRules.id,
      kind: s.ipRules.kind,
      scope: s.ipRules.scope,
      cidr: s.ipRules.cidr,
      expiresAt: s.ipRules.expiresAt,
    })
    .from(s.ipRules)
    .where(or(isNull(s.ipRules.expiresAt), gt(s.ipRules.expiresAt, sql`now()`)))
    .orderBy(asc(s.ipRules.id));
  return rows.map((row) => ({ ...row, expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString() }));
}

/**
 * Hits of one rule waiting to be written: how many requests it decided and when the last one was.
 *
 * Why: the console shows `hitCount` and `lastHitAt` for every IP rule; this is one row of the flush.
 */
export interface RuleHits {
  readonly ruleId: number;
  readonly count: number;
  /** Epoch milliseconds of the latest hit. */
  readonly lastHitAtMs: number;
}

/** `hit_count` is a 32-bit integer: a rule hammered for weeks stops at the largest value instead of failing the flush. */
const MAX_HIT_COUNT = 2_147_483_647;

/**
 * Adds counted hits to the rules.
 *
 * Why: the hook counts hits in Redis and the worker writes them here once a minute (`hit_count`, `last_hit_at` are shown in
 * the console's IP lists). Rules deleted meanwhile are skipped by the join. The count saturates instead of overflowing, and
 * `last_hit_at` only moves forward.
 *
 * Side effects: updates `ip_rules.hit_count` and `last_hit_at` (not `updated_at`: a hit is not an edit).
 *
 * @param db the database or a transaction
 * @param hits one entry per rule
 * @returns how many rules were updated
 */
export async function addIpRuleHits(db: DbExecutor, hits: readonly RuleHits[]): Promise<number> {
  if (hits.length === 0) return 0;
  const values = sql.join(
    hits.map(
      (hit) =>
        sql`(${hit.ruleId}::bigint, ${hit.count}::bigint, to_timestamp(${hit.lastHitAtMs}::double precision / 1000))`,
    ),
    sql`, `,
  );
  const result = await db.execute(sql`
    update ${s.ipRules} as r
    set hit_count = least(r.hit_count::bigint + v.hits, ${MAX_HIT_COUNT}::bigint)::integer,
        last_hit_at = greatest(coalesce(r.last_hit_at, v.at), v.at)
    from (values ${values}) as v(id, hits, at)
    where r.id = v.id
  `);
  return result.rowCount ?? 0;
}
