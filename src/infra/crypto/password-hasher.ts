// Password hashing with argon2id through @node-rs/argon2 (decision 007). Cost parameters come from the config and are
// stored in every PHC string, so they can be raised later and old hashes still verify.
import { Inject, Injectable } from '@nestjs/common';
import { hash, parseOptions, verify } from '@node-rs/argon2';
import { APP_CONFIG, type AppConfig } from '../../config';

/** Every hash we create or accept starts like this. */
const PHC_PREFIX = '$argon2id$';
/** Longest password hashed; a bound on the work an anonymous caller can ask for. The password policy is stricter. */
export const MAX_PASSWORD_BYTES = 1024;

/**
 * Hashes and verifies passwords with argon2id.
 *
 * Why: decision 007: only human-chosen secrets use argon2; the parameters (OWASP baseline m = 19 MiB, t = 2, p = 1) are
 * tuned per host with `bun run bench:argon2` to 50-150 ms. The package's default algorithm is argon2id, but its `Algorithm`
 * enum is an ambient const enum that `isolatedModules` rejects, so the code relies on the default and asserts the
 * `$argon2id$` prefix of every result instead.
 *
 * @see docs/decisions/007-password-hashing.md
 */
@Injectable()
export class PasswordHasher {
  private readonly options: { readonly memoryCost: number; readonly timeCost: number; readonly parallelism: number };

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const { memoryKib, timeCost, parallelism } = config.security.argon2;
    this.options = { memoryCost: memoryKib, timeCost, parallelism };
  }

  /**
   * Hashes a password.
   *
   * Why: the result is the PHC string stored in `staff_users.password_hash` and the other credential tables.
   *
   * @param password the plain password
   * @returns `$argon2id$v=19$m=...,t=...,p=...$salt$hash`, with a fresh random salt
   * @throws {RangeError} for an empty password or one longer than 1024 bytes (the password policy refuses these earlier)
   * @throws {Error} if the library ever returns something other than an argon2id hash
   */
  async hash(password: string): Promise<string> {
    if (password === '' || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
      throw new RangeError(`A password must be 1 to ${MAX_PASSWORD_BYTES} bytes`);
    }
    const hashed = await hash(password, this.options);
    if (!hashed.startsWith(PHC_PREFIX)) throw new Error('The password hash is not argon2id');
    return hashed;
  }

  /**
   * Checks a password against a stored hash.
   *
   * Why: sign-in. A hash that is not argon2id or cannot be parsed never verifies, and a password that is too long to have
   * been accepted is refused without doing the work.
   *
   * @param hashed the stored PHC string
   * @param password the password the user typed
   * @returns true when it matches; false for a wrong password or a stored value that is not a usable argon2id hash
   */
  async verify(hashed: string, password: string): Promise<boolean> {
    if (!hashed.startsWith(PHC_PREFIX) || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return false;
    try {
      return await verify(hashed, password);
    } catch {
      return false;
    }
  }

  /**
   * Tells whether a stored hash was made with weaker parameters than the current configuration.
   *
   * Why: decision 007 lets the cost be raised later; the sign-in code re-hashes a correct password when this is true.
   *
   * @param hashed the stored PHC string
   * @returns true when it should be replaced (other algorithm, or lower memory, time or parallelism than configured)
   */
  needsRehash(hashed: string): boolean {
    if (!hashed.startsWith(PHC_PREFIX)) return true;
    try {
      const stored = parseOptions(hashed);
      return (
        stored.memoryCost < this.options.memoryCost ||
        stored.timeCost < this.options.timeCost ||
        stored.parallelism < this.options.parallelism
      );
    } catch {
      return true;
    }
  }
}
