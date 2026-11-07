// recomputeEffectiveCost: the one catalog function that keeps `services.effective_cost` right (RESOLUTIONS catalog-1, B117).
// Feature 4a calls it on every service create and change; feature 6 calls it from the price sync, supplier import, link changes
// and supplier `credit_rate` changes.
import { sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/**
 * Recomputes the effective cost of some services from their cost and their first active supplier link.
 *
 * Why: user rule 9 (price protection): every price has a floor, and the floor starts from the effective cost,
 * `greatest(services.cost, credit x credit_rate of the first active supplier link by priority then id, 0 with no link)`
 * rounded half-up to four decimals. When the effective cost rises, `cost_was` keeps the first previous value
 * (`coalesce(cost_was, old effective cost)`), which is what the console shows as `costChangedFrom` until a base price is saved.
 * A service whose effective cost did not change is not touched. A change moves the price a merchant pays, so the caller moves the
 * catalog price version after its commit when the result is not empty (`CatalogPriceVersion.bumpAfterCommit`, decision 022).
 *
 * Side effects: updates `services.effective_cost`, and `cost_was` and `updated_at` of the services that change. The caller's
 * transaction should hold the service rows (or accept the row lock this update takes).
 *
 * @param db the caller's transaction
 * @param serviceIds the services to recompute; duplicates and an empty list are fine
 * @returns the ids of the services whose effective cost changed
 */
export async function recomputeEffectiveCost(db: DbExecutor, serviceIds: readonly number[]): Promise<number[]> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return [];
  const result = await db.execute<{ id: string }>(sql`
    with figures as (
      select service.id,
             service.effective_cost as old_effective,
             greatest(
               service.cost,
               coalesce((
                 select round(remote.credit * supplier.credit_rate, 4)
                 from ${s.serviceSupplierLinks} link
                 join ${s.supplierServices} remote on remote.id = link.supplier_service_id
                 join ${s.suppliers} supplier on supplier.id = remote.supplier_id
                 where link.service_id = service.id and link.is_active
                 order by link.priority, link.id
                 limit 1
               ), 0)
             )::numeric(18,4) as new_effective
      from ${s.services} service
      where service.id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    )
    update ${s.services} target
    set effective_cost = figures.new_effective,
        cost_was = case
          when figures.new_effective > figures.old_effective then coalesce(target.cost_was, figures.old_effective)
          else target.cost_was
        end,
        updated_at = now()
    from figures
    where target.id = figures.id and figures.new_effective <> figures.old_effective
    returning target.id`);
  return result.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}
