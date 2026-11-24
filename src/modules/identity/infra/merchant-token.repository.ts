// The one-time links of merchants, kept until the contract release (decision 064): a merchant is an account, so these are the queries of
// account-token.repository.ts under their old names. New code imports that file.
import type { AccountTokenPurpose } from '../ports/account-auth-tokens';

export {
  PASSWORD_LINK_PURPOSES,
  findAccountTokenByHash as findClientTokenByHash,
  findAccountTokenById as findClientTokenById,
  rotateAccountToken as rotateClientToken,
  voidOpenAccountTokens as voidOpenClientTokens,
} from './account-token.repository';

/**
 * The purposes a merchant's one-time token can have: the merchant subset of the closed `auth_tokens.purpose` list.
 *
 * Why: resolution identity-platform-2: `verify_email` (register), `reset` (forgot password) and `invite` (staff created the
 * merchant); `magic_link` is the sign-in link of the retail rank.
 *
 * Kept until the contract release; new code uses `ACCOUNT_TOKEN_PURPOSES`.
 */
export const CLIENT_TOKEN_PURPOSES = [
  'verify_email',
  'reset',
  'invite',
] as const satisfies readonly AccountTokenPurpose[];

/** One value of {@link CLIENT_TOKEN_PURPOSES}. */
export type ClientTokenPurpose = (typeof CLIENT_TOKEN_PURPOSES)[number];
