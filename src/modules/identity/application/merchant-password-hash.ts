// Re-hashing a merchant's proven password at the configured argon2 cost (decision 007): shared by the portal's login and the smart
// sign-in of feature 24A (`MerchantPasswordSignIn`), so the rule lives once.
import type { Logger } from '@nestjs/common';
import type { PasswordHasher } from '../../../infra/crypto';
import type { DbExecutor } from '../../../infra/db';
import type { Client } from '../db/schema';
import { replaceClientPasswordHash } from '../infra/merchant-auth.repository';

/**
 * Re-hashes a correct password that was hashed at a lower cost than the configured one.
 *
 * Why: decision 007: each stored hash carries its own parameters, and a sign-in is the only moment the clear password is known, so a
 * stronger cost reaches old hashes there. An upgrade never fails the sign-in: a write error is logged and the old hash stays.
 *
 * Side effects: may update `clients.password_hash`.
 *
 * @param db where to write
 * @param hasher the password hasher
 * @param logger where a failed upgrade is reported (without the password)
 * @param client the merchant whose password was just proven
 * @param password the proven password
 */
export async function upgradeClientPasswordHash(
  db: DbExecutor,
  hasher: PasswordHasher,
  logger: Logger,
  client: Client,
  password: string,
): Promise<void> {
  if (!client.passwordHash || !hasher.needsRehash(client.passwordHash)) return;
  try {
    await replaceClientPasswordHash(db, client.id, await hasher.hash(password));
  } catch (error) {
    logger.warn(`Could not upgrade the password hash of merchant ${client.id}: ${String(error)}`);
  }
}
