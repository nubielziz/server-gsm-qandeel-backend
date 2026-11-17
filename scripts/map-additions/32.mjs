// Feature 32 (ready-made payment methods with logos, decision 041, plan docs/briefs/32-payment-method-presets.md section 5): the routes
// beyond the map (decision 035). The catalog of ready-made methods (kept in code), and the upload and removal of the logo of a method.
// Spec B232. Written in English only (decision 039): no Arabic sentence, the permission as auth text.
import { R } from '../lib/map-additions.mjs';

export const rows = [
  R('admin', 'billing', 'GET', '/admin/payment-gateway-presets', undefined, 'payments:gateways', 32, [], {
    en: 'List the catalog of ready-made payment methods (bank transfer, crypto transfer, Vodafone Cash, Fawry, InstaPay, Binance Pay and the two coming soon).',
    module: 'money',
    spec: 'B232',
    successStatus: 200,
  }),
  R(
    'admin',
    'billing',
    'POST',
    '/admin/payment-gateways/:id/logo',
    undefined,
    'payments:gateways',
    32,
    ['payment_gateways', 'files', 'audit_logs'],
    { en: 'Upload the logo of a payment method.', module: 'money', spec: 'B232', successStatus: 200 },
  ),
  R(
    'admin',
    'billing',
    'DELETE',
    '/admin/payment-gateways/:id/logo',
    undefined,
    'payments:gateways',
    32,
    ['payment_gateways', 'audit_logs'],
    { en: 'Remove the uploaded logo of a payment method.', module: 'money', spec: 'B232', successStatus: 204 },
  ),
];
