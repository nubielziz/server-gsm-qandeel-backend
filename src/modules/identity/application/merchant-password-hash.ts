// Re-hashing a merchant's proven password at the configured argon2 cost (decision 007): shared by the portal's login and the smart
// sign-in of feature 24A (both through `MerchantSignInService.startSession`), so the rule lives once.
import type { Logger } from '@nestjs/common';
import type { PasswordHasher } from '../../../infra/crypto';
import type { Client } from '../db/schema';

/**
 * Makes a new hash of a correct password that was hashed at a lower cost than the configured one.
 *
 * Why: decision 007: each stored hash carries its own parameters, and a sign-in is the only moment the clear password is known, so a
 * stronger cost reaches old hashes there. The hash is made before the session's transaction (argon2 takes tens of milliseconds); that
 * transaction writes it only while the stored hash is still the one the password was verified against (`replaceClientPasswordHash`).
 * An upgrade never fails the sign-in: a hashing error is logged and the old hash stays.
 *
 * @param hasher the password hasher
 * @param logger where a failed upgrade is reported (without the password)
 * @param client the merchant whose password was just proven
 * @param password the proven password
 * @returns the new hash, or `undefined` when no upgrade is due or the hashing failed
 */
export async function upgradedClientPasswordHash(
  hasher: PasswordHasher,
  logger: Logger,
  client: Client,
  password: string,
): Promise<string | undefined> {
  if (!client.passwordHash || !hasher.needsRehash(client.passwordHash)) return undefined;
  try {
    return await hasher.hash(password);
  } catch (error) {
    logger.warn(`Could not upgrade the password hash of merchant ${client.id}: ${String(error)}`);
    return undefined;
  }
}
