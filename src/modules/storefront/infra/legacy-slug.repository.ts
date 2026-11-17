// Drizzle query on `legacy_slugs` (the storefront module's own table, feature 30): the old addresses in other languages that
// migration 0035 remembered. Read only: nothing writes the table after that migration (the demo seed adds two rows).
import { and, eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type LegacySlug, type LegacySlugKind, legacySlugs } from '../db/schema';

/**
 * Finds an old address.
 *
 * Why: decision 039: the English page that receives an old address of a service, page or help article asks where to send the
 * reader (`GET /store/v1/legacy-slugs/:kind/:slug`).
 *
 * @param db the database or a transaction
 * @param kind `service`, `page` or `help`
 * @param slug the old slug; for `help` the article id the old address started with
 * @returns the row, or `undefined` when the address was never retired
 */
export async function findLegacySlug(
  db: DbExecutor,
  kind: LegacySlugKind,
  slug: string,
): Promise<LegacySlug | undefined> {
  const [row] = await db
    .select()
    .from(legacySlugs)
    .where(and(eq(legacySlugs.kind, kind), eq(legacySlugs.slug, slug)))
    .limit(1);
  return row;
}
