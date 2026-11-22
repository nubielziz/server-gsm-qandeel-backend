// The shop's link tokens (checkout, order tracking, support ticket) at rest (decisions 010, 019, 054): a keyed hash to find the row and an
// AES-GCM copy to show the link again. One injectable holds the three kinds, their AADs and the four operations.
import { Injectable } from '@nestjs/common';
import { EncryptionService } from './encryption.service';
import { TokenService } from './token.service';

/** The columns that keep a link token's encrypted copy; each is also the copy's AAD (decision 019). */
export const CAPABILITY_TOKEN_COLUMNS = {
  checkout: 'checkout_sessions.token_enc',
  tracking: 'orders.public_token_enc',
  ticket: 'support_tickets.token_enc',
} as const;

/** The kinds of link token. */
export type CapabilityTokenKind = keyof typeof CAPABILITY_TOKEN_COLUMNS;

/** What is stored of a link token: its lookup hash and its encrypted copy. */
export interface SealedCapabilityToken {
  readonly hash: string;
  readonly enc: string;
}

/** The bytes of a new link token (128 bits, decision 010). */
const TOKEN_BYTES = 16;

/**
 * Makes, hashes, seals and reveals the shop's link tokens.
 *
 * Why: decisions 010, 019 and 054: a database copy alone opens no link. The row is found by `HMAC-SHA256(LOOKUP_HASH_KEY,
 * "capability:<kind>:<token>")`; the pages and mails that show the link again read the AES-GCM copy, whose AAD is its column. No
 * module computes either form by hand.
 */
@Injectable()
export class CapabilityTokenVault {
  constructor(
    private readonly tokens: TokenService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Makes a new 128-bit token with its stored forms.
   *
   * @param kind which link the token opens
   * @returns the token (shown once to its holder) and the hash and encrypted copy to store
   */
  issue(kind: CapabilityTokenKind): SealedCapabilityToken & { readonly token: string } {
    const token = this.tokens.random(TOKEN_BYTES);
    return { token, ...this.seal(kind, token) };
  }

  /**
   * The stored forms of a token.
   *
   * @param kind which link the token opens
   * @param token the token as issued
   * @returns its lookup hash and its encrypted copy (AAD: the kind's column)
   */
  seal(kind: CapabilityTokenKind, token: string): SealedCapabilityToken {
    return { hash: this.hashOf(kind, token), enc: this.encryption.encrypt(token, CAPABILITY_TOKEN_COLUMNS[kind]) };
  }

  /**
   * The lookup hash of a presented token.
   *
   * @param kind which link the token claims to open
   * @param token what the visitor presented
   * @returns 64 hex characters; kinds hash apart, so a token of one kind never finds a row of another
   */
  hashOf(kind: CapabilityTokenKind, token: string): string {
    return this.tokens.lookupHash(`capability:${kind}:${token}`);
  }

  /**
   * The token of a stored row: the decrypted copy, else the plain column of a row written before decision 054.
   *
   * @param kind which link the row keeps
   * @param stored the row's copy and plain columns
   * @returns the token, or `null` when the row holds neither
   * @throws {DecryptionError} when the copy cannot be read (a key removed from the keyring): never a silent wrong link
   */
  reveal(
    kind: CapabilityTokenKind,
    stored: { readonly enc: string | null; readonly plain: string | null },
  ): string | null {
    if (stored.enc !== null) return this.encryption.decrypt(stored.enc, CAPABILITY_TOKEN_COLUMNS[kind]);
    return stored.plain;
  }
}
