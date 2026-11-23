// Feature 47 (the console's Product / Services page, decision 063): routes beyond the map (decision 035). A price grid that reads the
// figures of a page of services in one call (spec B240), and a stored order of services that the merchant lists follow (spec B241); the
// import options of the same decision change no route (spec B242). Written in English only (decision 039): no Arabic sentence, the
// permission as auth text.
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R(
    'admin',
    'catalog',
    'GET',
    '/admin/services/price-grid',
    undefined,
    'catalog:read',
    47,
    [
      'services',
      'service_categories',
      'client_groups',
      'service_group_prices',
      'pricing_rules',
      'service_supplier_links',
      'supplier_services',
      'suppliers',
      'retail_price_follows',
    ],
    {
      en: 'The price grid: the cost, base, shop and per-group prices of a page of services with their margins.',
      module: 'catalog',
      spec: 'B240',
      successStatus: 200,
    },
  ),
  R('admin', 'catalog', 'POST', '/admin/services/order', undefined, 'catalog:update', 47, ['services', 'audit_logs'], {
    en: 'Set the order of services: the position merchants and API clients see them in, inside a category.',
    module: 'catalog',
    spec: 'B241',
    successStatus: 200,
  }),
];
