# 040: Retail price rules and publishing to the shop in bulk

Status: accepted, 2026-11-19 (feature 31, planned by Fable 5.2 with three scout studies and two adversarial reviews, resumed
after a postponement and corrected against the merged code by the lead, built in twelve slices by Opus 5.5 and Sonnet 5.5,
every money and concurrency slice reviewed line by line by Opus, then a conformance review and an adversarial attack on the
whole branch; plan `docs/briefs/31-bulk-publish.md`). Spec entries B228-B231, console mismatches M265 and M10c.

**Context.** The owner's catalog held 1157 supplier services, 25 own services and one listing on the shop. Quick add made
services with no retail price and no listing; a listing was created one at a time in the console. The retail price was a
fixed figure nobody tied to the supplier's cost, and nothing recorded whether a person had typed it.

**Decision.**
- **The shop's price can come from a rule.** A retail price rule says: effective cost, plus a percent, plus a fixed amount,
  rounded up to a style (whole cents, the next 5 or 10 cents, ends in .99 from a threshold), never under the storefront
  floor. Rules are a general one, one per service type and one per category; the most specific active rule prices a
  service. They are their own store (`retail_price_rules`), not rows of the B2B `pricing_rules`, which adjust the base price
  for merchants and never read the cost. A deleted rule keeps its row (`deleted_at`): the history keeps its name, and a
  delete never waits on a transaction that prices by it.
- **A price is either typed or following.** `retail_price_follows` holds a row for a service whose retail price a rule wrote.
  The retail row has two writers and no third: `RetailPrices.set` (the listing route, the publisher, the follow pass, the
  approval of a proposal), which takes the origin and the quote read under the service lock and **refuses a price under the
  floor itself**, and the group price page's replace, which keeps its own floor check and turns following off when it
  changes the row (it leaves a following price alone when staff did not change the figure the form loaded). **A rule never
  overwrites a typed price unless a person asks for that exact price to be replaced.**
- **A following price moves by itself, inside limits.** When the effective cost, the floor or the rule changes, the follow
  pass recomputes the price and writes it when it differs. A cost that moved by more than the rule's limit (default 25 %,
  up or down) or fell to zero becomes a proposal; so does a service that moved to another rule while the rules themselves
  did not change (a supplier sync can change a service's type and category). Staff approve a proposal **at the figure they
  saw** (`seen`); a figure that moved since is shown again. While a proposal waits the stored price stays and every sale is
  charged at least the floor.
- **The same limit guards a publish.** A row a rule prices is refused (`cost_moved`) when its cost moved by more than the
  rule's limit between the preview and the publication.
- **Publishing in bulk is a run over a stored draft.** The preview is a draft kept on the server (a run and its rows: a
  clean English title and slug, brand, carrier and country detected from the supplier's name with fixed lexicons, the price
  by rule); it changes nothing a visitor or a merchant can see. Applying is a background job that publishes one service per
  transaction and records each row's result; an attempt counter keeps two workers off one run, and a stopped run resumes
  from its rows. A finished run can be taken off the shop, and put back, as a whole. Quick add can hand what it made to such
  a run when it ends.
- **Staff are told.** Every automatic change and proposal is a row of `retail_price_changes` and an audit row; at most once
  an hour a message with the counts goes to the ops recipients.
- **Category names.** Quick add names a new category after the supplier's group, cleaned of entities, emoji, invisible
  characters and Arabic script runs; the existing categories were cleaned once (migration 0046, a job that skips a name in
  use audits each rename, and leaves a name written only in Arabic script or one another category has; approved by the owner on 2026-11-19).

**Why automatic and not only proposals.** The owner asked that the shop price follows the rule. A rise of the cost that is
not followed sells at the floor, the smallest margin the system allows; the limit exists for supplier mistakes.

**Consequences.** `RetailPrices.set` takes `{ origin, quote }`. A following price can change without a staff action: the audit
log shows the actor `system` with the reason, the rule and both costs. The public catalog, the checkout and the search read
the retail row as before; the checkout, tracking, account orders and receipts show the published title. Five tables
(`retail_price_rules`, `retail_price_follows`, `retail_price_changes`, `listing_publish_runs`, `listing_publish_items`) and
migrations 0041-0046.
