// HTTP controller of the ledger screens (map domain E, stage 3): journals, the trial balance and the reconciliation.
import { Controller, Param, Query } from '@nestjs/common';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import {
  getLedgerTransaction,
  getTrialBalance,
  listLedgerTransactions,
  reconcileLedger,
} from '../contracts/ledger.contracts';
import { LedgerReadService } from '../application/ledger-read.service';
import { ReconcileService } from '../application/reconcile.service';

/**
 * The ledger routes of the console.
 *
 * Why: the Finance page lists journals with their lines, opens one in a drawer, shows the trial balance and lets finance run
 * the reconciliation (RULES finance). All reads come straight from the ledger tables and are never cached.
 *
 * @route GET /admin/ledger/transactions
 * @route GET /admin/ledger/transactions/:id
 * @route GET /admin/ledger/accounts
 * @route POST /admin/ledger/reconcile
 */
@Controller()
export class LedgerController {
  constructor(
    private readonly ledger: LedgerReadService,
    private readonly reconciliation: ReconcileService,
  ) {}

  /**
   * Lists journals.
   *
   * @param query the parsed list request
   * @returns the page of journals and their total
   * @route GET /admin/ledger/transactions
   */
  @Route(listLedgerTransactions)
  list(@Query() query: QueryOf<typeof listLedgerTransactions>): Promise<ResultOf<typeof listLedgerTransactions>> {
    return this.ledger.list(query);
  }

  /**
   * Reads one journal.
   *
   * @param params the journal id
   * @returns the journal with its lines
   * @route GET /admin/ledger/transactions/:id
   */
  @Route(getLedgerTransaction)
  show(@Param() params: ParamsOf<typeof getLedgerTransaction>): Promise<ResultOf<typeof getLedgerTransaction>> {
    return this.ledger.get(params.id);
  }

  /**
   * The trial balance.
   *
   * @returns one row per account kind and the debit and credit totals
   * @route GET /admin/ledger/accounts
   */
  @Route(getTrialBalance)
  accounts(): Promise<ResultOf<typeof getTrialBalance>> {
    return this.ledger.trialBalance();
  }

  /**
   * Runs the reconciliation.
   *
   * @param staff the signed-in staff member
   * @returns the report
   * @route POST /admin/ledger/reconcile
   */
  @Route(reconcileLedger)
  reconcile(@CurrentStaff() staff: StaffPrincipal): Promise<ResultOf<typeof reconcileLedger>> {
    return this.reconciliation.run(staff.staffId);
  }
}
