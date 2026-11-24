// The stored forms of the shop's link tokens in tests (decision 054): the app's vault computes the hash and the copy, and reveals a stored
// row's token.
import { type CapabilityTokenKind, CapabilityTokenVault, type SealedCapabilityToken } from '@src/infra/crypto';
import type { TestApp } from './app';

/**
 * The stored forms of a token, as the app would write them.
 *
 * @param t the running test app
 * @param kind which link the token opens
 * @param token the token as issued
 * @returns its lookup hash and encrypted copy
 */
export function sealedRow(t: TestApp, kind: CapabilityTokenKind, token: string): SealedCapabilityToken {
  return t.app.get(CapabilityTokenVault).seal(kind, token);
}

/**
 * The lookup hash of a token, to find its row.
 *
 * @param t the running test app
 * @param kind which link the token opens
 * @param token the token
 * @returns the hash the row's `*_hash` column holds
 */
export function tokenHashOf(t: TestApp, kind: CapabilityTokenKind, token: string): string {
  return t.app.get(CapabilityTokenVault).hashOf(kind, token);
}

/**
 * The token of a stored row.
 *
 * @param t the running test app
 * @param kind which link the row keeps
 * @param stored the row's encrypted copy and plain column
 * @returns the token, or `null` when the row holds neither
 */
export function revealedToken(
  t: TestApp,
  kind: CapabilityTokenKind,
  stored: { readonly enc: string | null; readonly plain: string | null },
): string | null {
  return t.app.get(CapabilityTokenVault).reveal(kind, stored);
}
