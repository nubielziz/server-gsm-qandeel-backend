// Read side of the ledger screens (map domain E, stage 3): journals with their lines, one journal and the trial balance.
// Maps stored rows to the console's wire shapes (reference types, signs, owner names).
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { LEDGER_ACCOUNT_KINDS } from '../db/schema';
import { BASE_CURRENCY, toDebitPositive } from '../domain/accounts';
import { escapeLike, parseLedgerSearch } from '../domain/ledger-search';
import { toWireRefType } from '../domain/ref-types';
import { LedgerTransactionSchema, type TrialBalanceSchema } from '../contracts/ledger.contracts';
import {
  type JournalRow,
  type LedgerListSearch,
  type LedgerSortField,
  findJournal,
  listJournals,
  trialBalanceRows,
} from '../infra/ledger-read.repository';
import { findOwnersByName, loadActorNames, loadOwnerNames, ownerKey } from '../infra/foreign-directory.repository';

/** A journal on the wire (`LedgerTransaction` of the console). */
export type WireJournal = z.output<typeof LedgerTransactionSchema>;

/** The trial balance on the wire. */
export type WireTrialBalance = z.output<typeof TrialBalanceSchema>;

/**
 * Reads journals and the trial balance.
 *
 * Why: the console's Finance page shows the ledger, a journal drawer and the trial balance (RULES finance). Reads only, never
 * cached: ledger rows are decision state (decision 022).
 */
@Injectable()
export class LedgerReadService {
  constructor(private readonly db: DbService) {}

  /**
   * Lists journals.
   *
   * @param query the parsed list request: filters, sort, range and search
   * @returns the page of journals and the number matching the filters
   */
  async list(query: ParsedListQuery<LedgerSortField>): Promise<{ rows: WireJournal[]; total: number }> {
    const { rows, total } = await listJournals(this.db.db, query, await this.searchOf(query));
    return { rows: await this.toWire(rows), total };
  }

  /**
   * Reads one journal.
   *
   * @param id the journal id
   * @returns the journal with its lines
   * @throws {AppError} `NOT_FOUND` when there is no journal with this id
   */
  async get(id: number): Promise<WireJournal> {
    const row = await findJournal(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No journal entry with this id.' });
    return (await this.toWire([row]))[0]!;
  }

  /**
   * The trial balance: every account kind with its balance.
   *
   * Why: `GET /admin/ledger/accounts`: debit positive, so `totalDebit` and `totalCredit` are equal when the books balance.
   *
   * @returns one row per kind that has accounts, in the order of the map's account list
   */
  async trialBalance(): Promise<WireTrialBalance> {
    const stored = await trialBalanceRows(this.db.db, BASE_CURRENCY);
    const order = new Map<string, number>(LEDGER_ACCOUNT_KINDS.map((kind, index) => [kind, index]));
    const rows = stored
      .map((row) => ({ kind: row.kind, balance: Money.of(row.balance), accounts: row.accounts }))
      .sort((a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0));
    let totalDebit = Money.zero();
    let totalCredit = Money.zero();
    for (const row of rows) {
      if (row.balance.isPositive()) totalDebit = totalDebit.add(row.balance);
      else totalCredit = totalCredit.add(row.balance.abs());
    }
    return {
      currency: BASE_CURRENCY,
      rows: rows.map((row) => ({ kind: row.kind, balance: row.balance.toWire(), accounts: row.accounts })),
      totalDebit: totalDebit.toWire(),
      totalCredit: totalCredit.toWire(),
    };
  }

  private async searchOf(query: ParsedListQuery<LedgerSortField>): Promise<LedgerListSearch | undefined> {
    if (!query.search) return undefined;
    const parsed = parseLedgerSearch(query.search.text);
    if (parsed.kind === 'id') return { id: parsed.id };
    const pattern = `%${escapeLike(parsed.text)}%`;
    return { text: { pattern, owners: await findOwnersByName(this.db.db, pattern) } };
  }

  private async toWire(rows: readonly JournalRow[]): Promise<WireJournal[]> {
    const owners = new Map<string, { ownerType: 'client' | 'supplier' | 'customer'; ownerId: number }>();
    const actors = new Map<string, { type: 'staff' | 'client' | 'customer'; id: number }>();
    for (const row of rows) {
      for (const entry of row.entries) {
        const { ownerType, ownerId } = entry.account;
        if (ownerType !== null && ownerId !== null) owners.set(ownerKey(ownerType, ownerId), { ownerType, ownerId });
      }
      if (row.createdByType !== 'system' && row.createdById !== null) {
        actors.set(ownerKey(row.createdByType, row.createdById), { type: row.createdByType, id: row.createdById });
      }
    }
    const [ownerNames, actorNames] = await Promise.all([
      loadOwnerNames(this.db.db, [...owners.values()]),
      loadActorNames(this.db.db, [...actors.values()]),
    ]);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      memo: row.memo,
      refType: toWireRefType(row.refType),
      refId: row.refId,
      createdAt: row.createdAt.toISOString(),
      createdBy: {
        type: row.createdByType,
        id: row.createdById,
        name:
          row.createdByType === 'system' || row.createdById === null
            ? null
            : (actorNames.get(ownerKey(row.createdByType, row.createdById)) ?? null),
      },
      entries: row.entries.map((entry) => ({
        id: entry.id,
        amount: entry.amount,
        // Same sign as `amount`: a credit-normal account reads negative (ANSWERS finance Q2).
        balanceAfter: toDebitPositive(entry.account.kind, Money.of(entry.balanceAfter)).toWire(),
        account: {
          kind: entry.account.kind,
          id: entry.account.id,
          ownerType: entry.account.ownerType,
          ownerId: entry.account.ownerId,
          ownerName:
            entry.account.ownerType !== null && entry.account.ownerId !== null
              ? (ownerNames.get(ownerKey(entry.account.ownerType, entry.account.ownerId)) ?? null)
              : null,
        },
      })),
    }));
  }
}
