// The ledger reference types on the wire (resolution money-1): the console knows eight words, the database stores nine.
import type { LedgerRefType } from '../db/schema';

/**
 * The reference types the console understands.
 *
 * Why: resolution money-1: the wire set must stay a subset of the console's `LedgerRefType` (`order`, `payment`, `invoice`,
 * `refund`, `dispute`, `accrual`, `supplier`, `system`); a contract enum test checks it.
 */
export const WIRE_REF_TYPES = [
  'order',
  'payment',
  'invoice',
  'refund',
  'dispute',
  'accrual',
  'supplier',
  'system',
] as const;

/** One value of {@link WIRE_REF_TYPES}. */
export type WireRefType = (typeof WIRE_REF_TYPES)[number];

/**
 * Maps a stored reference type to the console's word.
 *
 * Why: manual adjustments keep `ref_type 'client'` in the database (B34, `ref_id` = the merchant) and go out as `system`
 * with the merchant id as `refId`; the console gives no link for `system` and still shows the merchant through the line's
 * owner name. Every other value goes out unchanged.
 *
 * @param stored the `ledger_transactions.ref_type`
 * @returns the wire word
 */
export function toWireRefType(stored: LedgerRefType): WireRefType {
  return stored === 'client' ? 'system' : stored;
}

/**
 * Lists the stored reference types a wire filter value matches.
 *
 * Why: resolution money-1: a wire filter `refType=system` matches stored `system` and `client`; every other value matches
 * itself.
 *
 * @param wire a value of the `refType` filter
 * @returns the stored values to compare `ref_type` with
 */
export function storedRefTypesOf(wire: WireRefType): LedgerRefType[] {
  return wire === 'system' ? ['system', 'client'] : [wire];
}
