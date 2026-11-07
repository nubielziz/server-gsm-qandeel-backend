// Route contracts of the ledger screens (map domain E, stage 3): journals with their lines, the trial balance and the
// reconciliation. Shapes match the console (docs/contract/endpoints/money.md, resolutions money-1, money-6, money-15).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { LEDGER_ACCOUNT_KINDS } from '../db/schema';
import { WIRE_REF_TYPES } from '../domain/ref-types';

const LedgerEntrySchema = z.object({
  id: zId,
  amount: zMoney.describe('Signed, debit positive; the lines of one journal sum to zero.'),
  balanceAfter: zMoney.describe('The account balance after the line, in the same sign as `amount`.'),
  account: z.object({
    kind: z.enum(LEDGER_ACCOUNT_KINDS),
    id: zId,
    ownerType: z.enum(['client', 'customer', 'supplier']).nullable(),
    ownerId: zId.nullable(),
    ownerName: z.string().nullable(),
  }),
});

/** One journal with its lines. */
export const LedgerTransactionSchema = z.object({
  id: zId.describe('The journal id (the console shows JRN-<id>).'),
  kind: z.string(),
  memo: z.string(),
  refType: z.enum(WIRE_REF_TYPES).describe('A stored `client` (manual adjustments) is sent as `system`.'),
  refId: z.number().int().nonnegative().describe('`0` for a posting with no record behind it.'),
  createdAt: zIsoDateTime,
  createdBy: z.object({
    type: z.enum(['staff', 'client', 'customer', 'system']),
    id: zId.nullable(),
    name: z.string().nullable(),
  }),
  entries: z.array(LedgerEntrySchema),
});

/** The trial balance: one row per account kind. */
export const TrialBalanceSchema = z.object({
  currency: z.string(),
  rows: z.array(z.object({ kind: z.string(), balance: zMoney, accounts: z.number().int().nonnegative() })),
  totalDebit: zMoney,
  totalCredit: zMoney,
});

/** The report of a reconciliation. */
export const ReconcileReportSchema = z.object({
  ranAt: zIsoDateTime,
  accountsChecked: z.number().int().nonnegative(),
  entriesChecked: z.number().int().nonnegative(),
  differences: z.array(
    z.object({
      accountId: zId,
      kind: z.string(),
      ownerName: z.string().nullable(),
      stored: zMoney,
      expected: zMoney,
      difference: zMoney,
    }),
  ),
});

const journal = {
  id: 1394,
  kind: 'deposit',
  memo: 'Deposit PAY-1000 (Bank transfer)',
  refType: 'payment',
  refId: 1000,
  createdAt: '2026-10-28T09:30:00.000Z',
  createdBy: { type: 'staff', id: 3, name: 'Omar T.' },
  entries: [
    {
      id: 2787,
      amount: '360.0000',
      balanceAfter: '28819.0800',
      account: { kind: 'bank', id: 4, ownerType: null, ownerId: null, ownerName: null },
    },
    {
      id: 2788,
      amount: '-360.0000',
      balanceAfter: '-1209.7500',
      account: { kind: 'client_wallet', id: 31, ownerType: 'client', ownerId: 1, ownerName: 'Zain Mobile Hub' },
    },
  ],
};

/** `GET /admin/ledger/transactions`. */
export const listLedgerTransactions = defineRoute({
  key: 'GET /admin/ledger/transactions',
  summary: 'Ledger journals',
  description:
    'Journals with their lines. Filters: `refType` (the wire words; `system` also matches manual adjustments), `refId`, ' +
    '`kind`, `accountKind` (journals with a line on an account of that kind). `q`: a number matches the journal id or the ' +
    'record id; text matches memo, kind and the owner names of the lines. Never cached.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'ledger:read',
  query: listQuery({
    sorts: ['createdAt', 'id', 'kind'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      refType: { type: 'enum', values: WIRE_REF_TYPES },
      refId: { type: 'number', ops: ['eq'] },
      kind: { type: 'string', ops: ['eq'] },
      accountKind: { type: 'enum', values: LEDGER_ACCOUNT_KINDS, ops: ['eq'] },
    },
    search: ['id', 'refId', 'memo', 'kind', 'ownerName'],
  }),
  success: { status: 200, schema: LedgerTransactionSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [journal] },
});

/** `GET /admin/ledger/transactions/:id`. */
export const getLedgerTransaction = defineRoute({
  key: 'GET /admin/ledger/transactions/:id',
  summary: 'One ledger journal',
  description: 'The same shape as a list row. Opened by the Ledger drawer and by the statement "View journal".',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'ledger:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: LedgerTransactionSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: journal },
});

/** `GET /admin/ledger/accounts`. */
export const getTrialBalance = defineRoute({
  key: 'GET /admin/ledger/accounts',
  summary: 'Trial balance',
  description:
    'One row per account kind: the sum of its balances, debit positive (a wallet reads negative), and how many accounts it ' +
    'has. `totalDebit` is the sum of the positive rows and `totalCredit` the sum of the negative ones; they are equal when ' +
    'the books balance. Never cached.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'ledger:read',
  success: { status: 200, schema: TrialBalanceSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
  examples: {
    response: {
      currency: 'USD',
      rows: [
        { kind: 'bank', balance: '28819.0800', accounts: 1 },
        { kind: 'client_wallet', balance: '-7608.1700', accounts: 20 },
      ],
      totalDebit: '28819.0800',
      totalCredit: '7608.1700',
    },
  },
});

/** `POST /admin/ledger/reconcile`. */
export const reconcileLedger = defineRoute({
  key: 'POST /admin/ledger/reconcile',
  summary: 'Reconcile the ledger',
  description:
    'Compares every account balance with the sum of its entries, now, and reports the accounts that differ. It never ' +
    'corrects anything: a correction is a reversing entry through the wallet adjustment. The run is recorded in the job log ' +
    '(`ledger_reconcile`) and audited; a second run while one is going on answers `RECONCILE_RUNNING`. Amounts are debit ' +
    'positive.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'ledger:reconcile',
  success: { status: 200, schema: ReconcileReportSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'RECONCILE_RUNNING'],
  examples: {
    response: { ranAt: '2026-11-01T10:00:00.000Z', accountsChecked: 48, entriesChecked: 3923, differences: [] },
  },
});
