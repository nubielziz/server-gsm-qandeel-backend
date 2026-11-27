// The order of the console's groups in one call (decision 078; spec B-TBD group-order): a route beyond the map (decision 035). The console's
// Group view reorders service categories by dragging and saves them all or none; `PATCH /admin/service-categories/:id` stays. Written in
// English only (decision 039): no Arabic sentence, the permission as auth text. The console calls it, so the row has `successStatus`.
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R(
    'admin',
    'catalog',
    'POST',
    '/admin/service-categories/order',
    undefined,
    'catalog:update',
    78,
    ['service_categories', 'audit_logs'],
    {
      en: 'Set the order of service categories (the console groups): the new positions of some categories, all or none.',
      module: 'catalog',
      spec: 'B-TBD group-order',
      successStatus: 200,
    },
  ),
];
