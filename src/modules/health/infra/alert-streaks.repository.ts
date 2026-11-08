// Drizzle queries on `alert_streaks` (health module, feature 12b): the stretches of evaluations in which a rule's reading of the moment held, read
// and rewritten by the alert evaluator once per rule and run.
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { alertStreaks } from '../db/schema';
import type { Streak } from '../domain/alert-evaluation';

/** A stretch with the subject it belongs to. */
export interface SubjectStreak extends Streak {
  readonly subjectKey: string;
}

/**
 * The stretches of a rule.
 *
 * @param db the database
 * @param ruleId the rule
 * @returns the stretch of each subject that has one, by subject key
 */
export async function streaksOfRule(db: DbExecutor, ruleId: number): Promise<Map<string, Streak>> {
  const rows = await db.select().from(alertStreaks).where(eq(alertStreaks.ruleId, ruleId));
  return new Map(
    rows.map((row) => [
      row.subjectKey,
      { kind: row.kind, condition: row.condition, since: row.since, seenAt: row.seenAt },
    ]),
  );
}

/**
 * Makes the stored stretches of a rule exactly the given ones.
 *
 * Why: after an evaluation the subjects that fired, resolved, recovered, lost their reading or vanished have no stretch any more; the others carry on with
 * the new `seenAt`. One call per rule and run, so the rows never describe more than the last evaluation saw.
 *
 * @param db the database
 * @param ruleId the rule
 * @param keep the stretches to store (inserted, or updated when the subject already has one)
 * @param now the clock's time, written as the row's `updated_at`
 */
export async function replaceStreaks(
  db: DbExecutor,
  ruleId: number,
  keep: readonly SubjectStreak[],
  now: Date,
): Promise<void> {
  await db.delete(alertStreaks).where(
    and(
      eq(alertStreaks.ruleId, ruleId),
      keep.length === 0
        ? undefined
        : notInArray(
            alertStreaks.subjectKey,
            keep.map((streak) => streak.subjectKey),
          ),
    ),
  );
  if (keep.length === 0) return;
  await db
    .insert(alertStreaks)
    .values(
      keep.map((streak) => ({
        ruleId,
        subjectKey: streak.subjectKey,
        kind: streak.kind,
        condition: streak.condition,
        since: streak.since,
        seenAt: streak.seenAt,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [alertStreaks.ruleId, alertStreaks.subjectKey],
      set: {
        kind: sql`excluded.kind`,
        condition: sql`excluded.condition`,
        since: sql`excluded.since`,
        seenAt: sql`excluded.seen_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/**
 * Deletes every stretch of a rule.
 *
 * Why: a rule that is switched off, deleted or edited so that it judges differently starts its windows again; the rule service calls this in the
 * transaction of the change, which holds the rule's lock (the evaluator writes its stretches under a share lock on the same row, so it cannot write
 * one back for the old rule after the change).
 *
 * @param db the transaction that holds the rule's lock
 * @param ruleId the rule
 */
export async function deleteStreaksOfRule(db: DbExecutor, ruleId: number): Promise<void> {
  await db.delete(alertStreaks).where(eq(alertStreaks.ruleId, ruleId));
}
