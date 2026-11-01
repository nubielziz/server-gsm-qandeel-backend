// Development sign-in credentials for the seeded staff (README "Local sign-in"): the password `demo-password` and a fixed
// TOTP secret per member with 2FA on, so the console can sign in against the real API with any authenticator app.
// Development only: `bun run db:seed` calls it when NODE_ENV=development; no code path skips the TOTP step.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppConfig } from '../../src/config';
import { EncryptionService, PasswordHasher } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { STAFF_TOTP_AAD } from '../../src/modules/identity';
import type { SeedReport } from './helpers';

/** The password of every seeded staff member in development (the frontend mock uses the same one). */
export const DEV_PASSWORD = 'demo-password';

/**
 * The fixed base32 TOTP secret of each seeded staff member who has two-factor sign-in on, by staff id.
 *
 * Why: a developer adds the secret to an authenticator app once (or computes the code with a script) and signs in as any of
 * them. Nadia (id 5, invited, no 2FA yet) has none: her secret comes from the setup step of her first sign-in, like in
 * production. These values are public in this repository: they exist only in development databases.
 */
export const DEV_TOTP_SECRETS: Readonly<Record<number, string>> = {
  1: '4DP3DBKM62TVFPNM5QE6OO4P6STUYM3J',
  2: 'KMG4IZYMUXD3VSCZ6VRP5TRPN3VCYBEW',
  3: 'ZYVGUXLFHQY5BDL562CL5QODEESABP4I',
  4: 'TRGSIXPEFSEMGX6X6SMFLZYYSD5JRBQR',
  6: '4KMDJNV4B3PLNO2OQETFBT3OBZ7LXEUR',
};

/** The staff ids of the demo seed (`scripts/seed/identity.ts`): the only accounts that get the shared development password. */
export const SEEDED_STAFF_IDS: readonly number[] = [1, 2, 3, 4, 5, 6];

/**
 * Gives the seeded staff a password and the members with 2FA on their TOTP secret.
 *
 * Why: P2.6 "Dev credentials". It only fills what is empty (`password_hash IS NULL`, `totp_secret_enc IS NULL`), so running
 * the seed again never overwrites a password someone changed, and it leaves other staff (made in the console) alone: an
 * account invited by link must not get a known password.
 *
 * @param db the transaction to write with
 * @param config the application configuration (the argon2 cost and the encryption keys)
 * @returns how many staff rows got a password (`inserted`) and how many already had one (`existing`)
 */
export async function seedDevCredentials(db: DbExecutor, config: AppConfig): Promise<SeedReport> {
  const hasher = new PasswordHasher(config);
  const encryption = new EncryptionService(config);
  const staff = await db
    .select({ id: s.staffUsers.id, twofaEnabled: s.staffUsers.twofaEnabled })
    .from(s.staffUsers)
    .where(inArray(s.staffUsers.id, [...SEEDED_STAFF_IDS]));

  let inserted = 0;
  for (const member of staff) {
    const written = await db
      .update(s.staffUsers)
      .set({ passwordHash: await hasher.hash(DEV_PASSWORD) })
      .where(and(eq(s.staffUsers.id, member.id), isNull(s.staffUsers.passwordHash)))
      .returning({ id: s.staffUsers.id });
    inserted += written.length;

    const secret = DEV_TOTP_SECRETS[member.id];
    if (secret !== undefined && member.twofaEnabled) {
      await db
        .update(s.staffUsers)
        .set({ totpSecretEnc: encryption.encrypt(secret, STAFF_TOTP_AAD) })
        .where(and(eq(s.staffUsers.id, member.id), isNull(s.staffUsers.totpSecretEnc)));
    }
  }
  return { table: 'staff_users (credentials)', inserted, existing: staff.length - inserted };
}
