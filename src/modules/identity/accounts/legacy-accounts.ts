// LegacyAccounts: reads the old merchant and customer numbers that rows written before the one account type still carry (decision 064).
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type LegacyType, findMappedAccountId, listLegacyRows } from './legacy-accounts.repository';

/**
 * The type words a stored (type, id) pair can carry: `account` (the id is the account id), `client` (an old merchant number),
 * `merchant` (the word an audit row used for a merchant; the same space as `client`) and `customer` (an old customer number).
 */
export type LegacyLookupType = 'account' | 'client' | 'merchant' | 'customer';

/** One old number of an account. */
export interface LegacyPair {
  readonly type: LegacyType;
  readonly id: number;
}

/**
 * Names the old number space a type word reads from.
 *
 * Why: `merchant` is an audit word for the same people as `client`; every other word that is not `account` or `customer` is not a
 * number space of the map (a staff member, an order, a word this code has never heard of).
 *
 * @param type a stored type word
 * @returns `self` for `account`, the number space for `client`, `merchant` and `customer`, `undefined` for any other word
 */
export function legacySpaceOf(type: string): 'self' | LegacyType | undefined {
  switch (type) {
    case 'account':
      return 'self';
    case 'client':
    case 'merchant':
      return 'client';
    case 'customer':
      return 'customer';
    default:
      return undefined;
  }
}

/**
 * A SQL expression that gives the account id a stored (type, id) pair stands for.
 *
 * Why: rows that are never rewritten (the audit trail, order events, ledger transactions) keep the words they were written with:
 * `client` and `merchant` for a merchant, `customer` for a shopper. A customer number is not an account id (old number 7 is not
 * account 7), so a reader that joins on the raw id would show another person. This expression looks the pair up in the map; a pair the
 * map does not know gives NULL, shown as "unknown account" and never as another account. The map is read through an alias, so the
 * fragment is safe inside any query.
 *
 * @param typeColumn a SQL expression for the type word (text)
 * @param idColumn a SQL expression for the id (bigint)
 * @returns a scalar SQL expression: the account id, or NULL for staff, system and unknown pairs
 * @see decision 064
 */
export function legacyAccountIdSql(typeColumn: SQL, idColumn: SQL): SQL {
  return sql`(case
    when ${typeColumn} = 'account' then ${idColumn}
    when ${typeColumn} in ('client', 'merchant')
      then (select m.account_id from account_legacy_ids m where m.legacy_type = 'client' and m.legacy_id = ${idColumn})
    when ${typeColumn} = 'customer'
      then (select m.account_id from account_legacy_ids m where m.legacy_type = 'customer' and m.legacy_id = ${idColumn})
    else null end)`;
}

/**
 * A SQL predicate that is true for every stored (type, id) pair that stands for one account.
 *
 * Why: the history of an account (its audit trail, the events of its orders, the ledger entries it caused) was written with the
 * words of its time: the account itself as `account`, an old merchant as `client` or `merchant`, an old customer as `customer`. A
 * filter on the account id alone would lose the old rows, and a filter on the raw id would match someone else's old number. The
 * predicate matches the account's own pairs and every old number the map points at it.
 *
 * @param typeColumn a SQL expression for the type word (text)
 * @param idColumn a SQL expression for the id (bigint)
 * @param accountId the account whose history to match
 * @returns a SQL predicate
 * @see decision 064
 */
export function accountHistorySql(typeColumn: SQL, idColumn: SQL, accountId: number): SQL {
  return sql`((${typeColumn} = 'account' and ${idColumn} = ${accountId})
    or (${typeColumn} in ('client', 'merchant') and ${idColumn} in
      (select m.legacy_id from account_legacy_ids m where m.legacy_type = 'client' and m.account_id = ${accountId}))
    or (${typeColumn} = 'customer' and ${idColumn} in
      (select m.legacy_id from account_legacy_ids m where m.legacy_type = 'customer' and m.account_id = ${accountId})))`;
}

/**
 * Resolves the old numbers of the merchant and customer days to accounts.
 *
 * Why: merchants kept their ids when the accounts were merged, and every customer got a new account id, so an old customer number
 * must never be read as an account id. Rows that were not rewritten, bookmarks, support requests and old links still name the old
 * numbers; this class turns them into accounts, or into nothing (decision 064). The map is append-only and has one row per merchant
 * and per customer that existed when the accounts were merged; accounts made later have none.
 *
 * Side effects: none (reads only).
 *
 * @see decision 064
 */
@Injectable()
export class LegacyAccounts {
  /**
   * Finds the account a stored (type, id) pair stands for.
   *
   * Why: `account` is the id itself (no read); `client` and `merchant` read the merchant numbers and `customer` the customer numbers of
   * the map, so customer 7 never gives account 7. A pair the map does not know, a word that is not an account word and an id that is not
   * a positive whole number give `undefined`: shown as an unknown account, never as another one.
   *
   * @param db the database or a transaction
   * @param type the stored type word
   * @param id the stored id
   * @returns the account id, or `undefined` for an unknown pair
   */
  async resolve(db: DbExecutor, type: LegacyLookupType, id: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(id) || id < 1) return undefined;
    // Read as plain text: a caller may hand over a word read from a stored row.
    const space = legacySpaceOf(type);
    if (space === undefined) return undefined;
    if (space === 'self') return id;
    return findMappedAccountId(db, space, id);
  }

  /**
   * Lists the old numbers that point at an account.
   *
   * @param db the database or a transaction
   * @param accountId the account id
   * @returns the old merchant and customer numbers (merchant numbers first); empty for an account made after the merge
   */
  async legacyIdsOf(db: DbExecutor, accountId: number): Promise<LegacyPair[]> {
    const rows = await listLegacyRows(db, accountId);
    return rows.map((row) => ({ type: row.legacyType, id: row.legacyId }));
  }

  /**
   * Builds the SQL expression that gives the account id of a stored (type, id) pair.
   *
   * @param typeColumn a SQL expression for the type word
   * @param idColumn a SQL expression for the id
   * @returns the expression ({@link legacyAccountIdSql})
   */
  legacyAccountIdSql(typeColumn: SQL, idColumn: SQL): SQL {
    return legacyAccountIdSql(typeColumn, idColumn);
  }

  /**
   * Builds the SQL predicate that matches every stored pair of one account.
   *
   * @param typeColumn a SQL expression for the type word
   * @param idColumn a SQL expression for the id
   * @param accountId the account whose history to match
   * @returns the predicate ({@link accountHistorySql})
   */
  accountHistorySql(typeColumn: SQL, idColumn: SQL, accountId: number): SQL {
    return accountHistorySql(typeColumn, idColumn, accountId);
  }
}
