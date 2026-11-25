// recomputeEffectiveCost: the one catalog function that keeps `services.effective_cost` right (RESOLUTIONS catalog-1, B117).
// Feature 4a calls it on every service create and change; feature 6 calls it from the price sync, supplier import, link changes,
// supplier `credit_rate` changes and a change of a supplier's status. writeOwnCost: a staff change of a service's own cost (decision
// 069), with the same `cost_was` rule.
import { asc, inArray, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/**
 * Recomputes the effective cost of some services from their cost and the first supplier link an order could be sent through.
 *
 * Why: user rule 9 (price protection): every price has a floor, and the floor starts from the effective cost,
 * `greatest(services.cost, credit x credit_rate of the link)` rounded half-up to four decimals. The link is the first by priority
 * then id that the automatic dispatch could use (`pickLink` without its price test, the rule of `supplyStates`): the link is
 * switched on, its supplier is `active` and the supplier still lists the service. So the floor is the cost of the supplier an order
 * would really go to. With no such link it is the highest cost of the switched-on links (the careful value: whichever of them comes
 * back, no price was accepted under its cost), and 0 with none switched on. When the effective cost rises, `cost_was` keeps the
 * first previous value (`coalesce(cost_was, old effective cost)`), which is what the console shows as `costChangedFrom` until a
 * base price is saved.
 * A service whose effective cost did not change is not written. A change moves the price a merchant pays, so the caller moves the
 * catalog price version after its commit when the result is not empty (`CatalogPriceVersion.bumpAfterCommit`, decision 022).
 *
 * Concurrency (decision 069): the service rows are locked first, `FOR NO KEY UPDATE` in id order (the lock the update takes anyway,
 * so a foreign key check of a new order or code does not wait for it), and only then read. Under READ COMMITTED each statement reads
 * what was committed when it starts, so the figures are worked out from the cost, the effective cost and the links as they are once
 * no other writer holds the rows: a staff change of the own cost (which holds the row `FOR UPDATE`) racing a supplier sync either
 * finished before or waits for this commit. Without the lock the update would work from what its statement saw before it waited, and
 * write an effective cost under a cost committed meanwhile (the CHECK refuses it and the caller's transaction is lost) or skip an
 * update that a cost lowered meanwhile needs (a floor too low). The update reads the cost, the effective cost and `cost_was` from the
 * row it writes as well, so it never mixes two versions of a row.
 *
 * Side effects: locks the service rows (`FOR NO KEY UPDATE`, id order) for the rest of the caller's transaction; updates
 * `services.effective_cost`, and `cost_was` and `updated_at` of the services that change.
 *
 * @param db the caller's transaction
 * @param serviceIds the services to recompute; duplicates and an empty list are fine
 * @returns the ids of the services whose effective cost changed
 */
export async function recomputeEffectiveCost(db: DbExecutor, serviceIds: readonly number[]): Promise<number[]> {
  const ids = [...new Set(serviceIds)].sort((a, b) => a - b);
  if (ids.length === 0) return [];
  // Lock order: the service rows in id order, before anything is read (see "Concurrency" above).
  await db
    .select({ id: s.services.id })
    .from(s.services)
    .where(inArray(s.services.id, ids))
    .orderBy(asc(s.services.id))
    .for('no key update');
  const result = await db.execute<{ id: string }>(sql`
    with links as (
      select service.id,
             coalesce((
               select round(remote.credit * supplier.credit_rate, 4)
               from ${s.serviceSupplierLinks} link
               join ${s.supplierServices} remote on remote.id = link.supplier_service_id
               join ${s.suppliers} supplier on supplier.id = remote.supplier_id
               where link.service_id = service.id
                 and link.is_active
                 and supplier.status = 'active'
                 and remote.is_available
               order by link.priority, link.id
               limit 1
             ), (
               select max(round(remote.credit * supplier.credit_rate, 4))
               from ${s.serviceSupplierLinks} link
               join ${s.supplierServices} remote on remote.id = link.supplier_service_id
               join ${s.suppliers} supplier on supplier.id = remote.supplier_id
               where link.service_id = service.id and link.is_active
             ), 0)::numeric(18,4) as link_cost
      from ${s.services} service
      where service.id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    )
    update ${s.services} target
    set effective_cost = greatest(target.cost, links.link_cost),
        cost_was = case
          when greatest(target.cost, links.link_cost) > target.effective_cost then coalesce(target.cost_was, target.effective_cost)
          else target.cost_was
        end,
        updated_at = now()
    from links
    where target.id = links.id and greatest(target.cost, links.link_cost) <> target.effective_cost
    returning target.id`);
  return result.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

/**
 * Writes the own cost of a service that staff typed, keeping the effective cost and its "cost changed" mark right.
 *
 * Why: decision 069: staff set `services.cost` (`ownCost` on the wire) for a service with no supplier, such as gift-card codes they
 * own; the shop's price rules and the floor start from the effective cost, `greatest(cost, first usable link cost)`. A change must
 * have the consequences of a supplier cost change: when the effective cost rises, `cost_was` keeps the first previous value (the rule
 * of {@link recomputeEffectiveCost}). The CHECK `services_effective_cost_check` (effective cost not under the cost) holds after every
 * statement, so the cost and a raised effective cost are written together; {@link recomputeEffectiveCost} then works out the effective
 * cost from the links (it falls when the own cost fell under the old effective cost). The caller moves the catalog price version after
 * its commit (so the follow pass of decision 040 moves a following shop price, as after a supplier sync) and writes the audit row.
 * The same cost again writes nothing.
 *
 * Side effects: updates `services.cost`, and `effective_cost`, `cost_was` and `updated_at` of the service when they change. The
 * caller's transaction holds the service row `FOR UPDATE`.
 *
 * @param db the caller's transaction
 * @param serviceId the service
 * @param cost the new own cost (a 4-decimal text, 0 or more)
 * @returns true when the own cost changed
 */
export async function writeOwnCost(db: DbExecutor, serviceId: number, cost: string): Promise<boolean> {
  // Postgres reads every right-hand side from the row before the update: `effective_cost` below is the old effective cost.
  const written = await db.execute<{ id: string }>(sql`
    update ${s.services}
    set cost = ${cost}::numeric(18,4),
        effective_cost = greatest(effective_cost, ${cost}::numeric(18,4)),
        cost_was = case
          when ${cost}::numeric(18,4) > effective_cost then coalesce(cost_was, effective_cost)
          else cost_was
        end,
        updated_at = now()
    where id = ${serviceId} and cost <> ${cost}::numeric(18,4)
    returning id`);
  if (written.rows.length === 0) return false;
  await recomputeEffectiveCost(db, [serviceId]);
  return true;
}
