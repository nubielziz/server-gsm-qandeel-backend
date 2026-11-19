// Feature 31 (bulk publish, decision 040, plan docs/briefs/31-bulk-publish.md section 5.1): routes beyond the map (decision 035).
// Slice B1: the retail price rules that price the shop from the supplier's cost (spec B229). Slice B4a: the draft of a publish run, to
// create and to read (spec B228). Slice B4b: to edit, apply, cancel and switch it (spec B228). Slice B5: the price changes the follow
// pass made or proposes (spec B230). Written in English only (decision 039): no Arabic sentence, the permission as auth text.
import { R } from '../lib/map-additions.mjs';

const RULES = ['retail_price_rules', 'audit_logs'];
const RUN_READ = ['listing_publish_runs', 'listing_publish_items', 'staff_users'];

const publish = (method, path, en, permission, successStatus, tables) =>
  R('admin', 'storefront', method, path, undefined, permission, 31, tables, {
    en,
    module: 'storefront',
    spec: 'B228',
    successStatus,
  });

const rule = (method, path, en, permission, successStatus, tables = RULES) =>
  R('admin', 'catalog', method, path, undefined, permission, 31, tables, {
    en,
    module: 'catalog',
    spec: 'B229',
    successStatus,
  });

const priceChange = (method, path, en, permission, tables) =>
  R('admin', 'catalog', method, path, undefined, permission, 31, tables, {
    en,
    module: 'catalog',
    spec: 'B230',
    successStatus: 200,
  });

export const rows = [
  rule(
    'GET',
    '/admin/retail-price-rules',
    'The retail price rules that price the shop from the cost, with the services that follow each.',
    'pricing:read',
    200,
    ['retail_price_rules', 'retail_price_follows'],
  ),
  rule(
    'POST',
    '/admin/retail-price-rules',
    'Create a retail price rule (general, per service type or per category).',
    'pricing:create',
    201,
  ),
  rule(
    'PATCH',
    '/admin/retail-price-rules/:id',
    'Change the figures of a retail price rule, or switch it off and on.',
    'pricing:update',
    200,
  ),
  rule(
    'DELETE',
    '/admin/retail-price-rules/:id',
    'Delete a retail price rule (the rule keeps its row for the history).',
    'pricing:delete',
    204,
  ),
  rule(
    'POST',
    '/admin/retail-price-rules/preview',
    'What a change of the retail price rules would do to the prices that follow them; nothing is stored.',
    'pricing:read',
    200,
    ['retail_price_rules', 'retail_price_follows', 'services'],
  ),
  priceChange(
    'GET',
    '/admin/retail-price-changes',
    'The retail prices the follow pass moved, the moves that wait for staff, and the prices that stopped following a rule.',
    'pricing:read',
    ['retail_price_changes', 'services'],
  ),
  priceChange(
    'POST',
    '/admin/retail-price-changes/resolve',
    'Answer waiting price proposals: approve the figure shown, or keep the current price as a typed one.',
    'pricing:update',
    ['retail_price_changes', 'retail_price_follows', 'service_group_prices', 'audit_logs'],
  ),
  publish(
    'POST',
    '/admin/publish-runs',
    'Prepare a draft of services to put on the shop in bulk (a preview that changes nothing), or check an earlier one again.',
    'storefront:create',
    202,
    ['listing_publish_runs', 'outbox_events', 'audit_logs'],
  ),
  publish('GET', '/admin/publish-runs', 'List the bulk publish runs, newest first.', 'storefront:read', 200, RUN_READ),
  publish(
    'GET',
    '/admin/publish-runs/:id',
    'Show one bulk publish run with its counts and its progress.',
    'storefront:read',
    200,
    RUN_READ,
  ),
  publish(
    'GET',
    '/admin/publish-runs/:id/items',
    'List the rows of a bulk publish run: what was detected, what will be published, the price and the result.',
    'storefront:read',
    200,
    ['listing_publish_items', 'services', 'service_listings'],
  ),
  publish(
    'PATCH',
    '/admin/publish-runs/:id/items/:itemId',
    'Edit one row of a publish draft (title, address, facts, price, tick, or back to what was detected); a price key also needs storefront:update.',
    'storefront:create',
    200,
    ['listing_publish_items'],
  ),
  publish(
    'POST',
    '/admin/publish-runs/:id/items/bulk',
    'Change the tick or the brand, carrier or country of many rows of a publish draft, picked by id or by a filter.',
    'storefront:create',
    200,
    ['listing_publish_items'],
  ),
  publish(
    'POST',
    '/admin/publish-runs/:id/apply',
    'Publish the ticked rows of a draft, or continue a run that stopped.',
    'storefront:publish',
    202,
    ['listing_publish_runs', 'listing_publish_items', 'outbox_events', 'audit_logs'],
  ),
  publish(
    'POST',
    '/admin/publish-runs/:id/cancel',
    'Discard a preview, or stop a run that is publishing (which also needs storefront:publish).',
    'storefront:create',
    200,
    ['listing_publish_runs', 'audit_logs'],
  ),
  publish(
    'POST',
    '/admin/publish-runs/:id/listed',
    'Take everything a finished run published off the shop, or put it back.',
    'storefront:publish',
    202,
    ['listing_publish_runs', 'outbox_events', 'audit_logs'],
  ),
];
