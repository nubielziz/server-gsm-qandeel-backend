// Feature 38 (payments integrity, decision 048): the route beyond the map (decision 035). Staff close a storefront payment that is held for
// staff (paid back by hand, or no money was received). Written in English only (decision 039): no Arabic sentence, the permission as auth
// text.
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R(
    'admin',
    'refunds',
    'POST',
    '/admin/held-payments/:id/close',
    undefined,
    'refunds:approve',
    38,
    ['payments', 'refunds', 'audit_logs'],
    {
      en: 'Close a storefront payment held for staff: paid back by hand, or no money was received.',
      module: 'money',
      spec: 'B-TBD held-payment-close',
    },
  ),
];
