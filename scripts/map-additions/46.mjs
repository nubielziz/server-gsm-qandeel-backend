// Feature 46 (the Catalog page's reads, decision 060): a route beyond the map (decision 035). The catalog's service panel reads the
// supplier chain of one service, also of a service no supplier links yet. Written in English only (decision 039): no Arabic
// sentence, the permission as auth text.
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R(
    'admin',
    'suppliers',
    'GET',
    '/admin/services/:id/supplier-links',
    undefined,
    'catalog:read',
    46,
    ['service_supplier_links', 'supplier_services', 'suppliers', 'services'],
    {
      en: 'The supplier chain of a service, in priority order.',
      module: 'suppliers',
      spec: 'B-TBD service-supplier-chain',
      successStatus: 200,
    },
  ),
];
