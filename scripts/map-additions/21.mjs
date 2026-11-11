// Feature 21 (customer wallet): the 16 routes beyond the map (decision 035; plan docs/briefs/21-customer-wallet.md § 7.2).
import { R } from '../lib/map-additions.mjs';

const SPEC = 'B-TBD customer-wallet-routes';
const store = (m, p, f, t, en, module = 'money', g = 'account', a = 'جلسة الزبون') =>
  R('store', g, m, p, f, a, 21, t, { en, module, spec: SPEC });
const admin = (g, m, p, f, a, t, en) =>
  R('admin', g, m, p, f, a, 21, t, { en, module: 'money', spec: SPEC, successStatus: 200 });

export const rows = [
  store(
    'GET',
    '/store/v1/me/wallet',
    'رصيد الزبون: المتاح والحدود وحالة التجميد',
    ['ledger_accounts', 'invoices'],
    'The signed-in customer store balance: available amount, limits and hold state.',
  ),
  store(
    'GET',
    '/store/v1/me/wallet/statement',
    'كشف حساب رصيد الزبون مع فلترة بالتاريخ',
    ['ledger_entries', 'ledger_transactions'],
    'The signed-in customer balance statement, filtered by date.',
  ),
  store(
    'GET',
    '/store/v1/me/wallet/top-up-methods',
    'طرق شحن الرصيد المتاحة للزبون',
    ['payment_gateways'],
    'The payment methods the signed-in customer can top up the balance with.',
  ),
  store(
    'POST',
    '/store/v1/me/wallet/top-ups',
    'طلب شحن رصيد: المبلغ وطريقة الدفع مع Idempotency-Key',
    ['invoices'],
    'Start a balance top-up: amount and payment method, with an Idempotency-Key.',
  ),
  store(
    'GET',
    '/store/v1/me/wallet/top-ups',
    'عمليات شحن الزبون وحالاتها',
    ['invoices', 'payments'],
    'The signed-in customer top-ups and their states.',
  ),
  store(
    'GET',
    '/store/v1/me/wallet/top-ups/:id',
    'عملية شحن واحدة مع تعليمات الدفع',
    ['invoices', 'payments'],
    'One top-up with its payment instructions.',
  ),
  store(
    'POST',
    '/store/v1/me/wallet/top-ups/:id/receipt',
    'إرفاق إيصال التحويل بانتظار مراجعة الموظف',
    ['payments', 'invoices', 'files'],
    'Attach the transfer receipt to a manual top-up; it then waits for staff review.',
  ),
  store(
    'POST',
    '/store/v1/me/wallet/top-ups/:id/cancel',
    'إلغاء عملية شحن يدوية لم يُرفق لها إيصال',
    ['invoices'],
    'Cancel a manual top-up that has no receipt yet.',
  ),
  store(
    'POST',
    '/store/v1/files',
    'رفع ملف من حساب الزبون (إيصال تحويل)',
    ['files'],
    'Upload a file from the customer account (a transfer receipt).',
    'platform',
  ),
  store(
    'POST',
    '/store/v1/checkout-sessions/:token/balance-payment',
    'الدفع من رصيد الزبون: يُنشأ الطلب ويُخصم الرصيد في معاملة واحدة',
    ['checkout_sessions', 'payments', 'orders', 'ledger_entries'],
    'Pay a checkout from the signed-in customer balance: the order is placed and the balance debited in one transaction.',
    'customers',
    'checkout',
    'رمز الجلسة + Idempotency-Key',
  ),
  admin(
    'customers',
    'GET',
    '/admin/customers/:id/wallet',
    'رصيد الزبون: الرصيد والتجميد والشحنات المعلّقة',
    'wallet:read',
    ['ledger_accounts'],
    'A customer store balance: balance, hold state and pending top-ups.',
  ),
  admin(
    'customers',
    'GET',
    '/admin/customers/:id/wallet/statement',
    'كشف حساب رصيد الزبون',
    'wallet:read',
    ['ledger_entries', 'ledger_transactions'],
    'A customer balance statement.',
  ),
  admin(
    'customers',
    'POST',
    '/admin/customers/:id/wallet/adjust',
    'إضافة أو خصم يدوي على رصيد الزبون مع سبب',
    'wallet:adjust',
    ['ledger_transactions', 'ledger_entries', 'audit_logs'],
    'Add to or deduct from a customer balance by hand, with a reason.',
  ),
  admin(
    'customers',
    'POST',
    '/admin/customers/:id/wallet/freeze',
    'تجميد رصيد الزبون مع السبب',
    'wallet:adjust',
    ['ledger_accounts', 'audit_logs'],
    'Put a customer balance on hold, with a reason.',
  ),
  admin(
    'customers',
    'POST',
    '/admin/customers/:id/wallet/unfreeze',
    'فك تجميد رصيد الزبون',
    'wallet:adjust',
    ['ledger_accounts', 'audit_logs'],
    'Lift the hold on a customer balance.',
  ),
  admin(
    'billing',
    'GET',
    '/admin/customer-wallets',
    'قائمة أرصدة الزبائن: السالب والمجمّد',
    'wallet:read',
    ['ledger_accounts', 'customers'],
    'Customer balances, with negative and held ones.',
  ),
];
