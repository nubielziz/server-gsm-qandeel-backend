// AccountIdentityRegistrar: plugs the one-time links of accounts into the access guard at boot (decisions 010, 018, 064).
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { AuthToken } from '../db/schema';
import { ACCOUNT_TOKEN_PURPOSES } from '../ports/account-auth-tokens';
import { CapabilityTokenResolvers } from '../security/machine/capability-tokens';
import { AccountAuthTokenService } from './account-auth-tokens';

/**
 * The purposes the `link-token` routes accept in the expand release: the sign-in link and the verification link of
 * `POST /store/v1/auth/verify`, and the invitation and reset links of the password alias that shares the guard.
 *
 * Why: the access guard only asks "is this token a usable link"; which purposes one route takes is that route's use case (a wrong
 * purpose there is the same `410 TOKEN_INVALID`). The contract release narrows this list to `magic_link`.
 */
const LINK_TOKEN_PURPOSES: readonly string[] = ACCOUNT_TOKEN_PURPOSES;

/**
 * Tells whether a stored link can still be used.
 *
 * Why: every use case that exchanges a link and the guard that resolves it judge usability by this one rule: not used up (a voided link
 * counts as used) and not expired.
 *
 * @param link the stored link
 * @param nowMs the clock's time in milliseconds
 * @returns true for a link that is unused and not expired
 */
export function isUsableLink(link: Pick<AuthToken, 'usedAt' | 'expiresAt'>, nowMs: number): boolean {
  return link.usedAt === null && link.expiresAt.getTime() > nowMs;
}

/**
 * Registers the link-token resolver of accounts with the identity module's registry.
 *
 * Why: decision 064. The sign-in link of the shop and the password links of every rank are one kind of token with one subject type, so
 * one resolver serves the `link-token` routes. The resolver only looks: it never spends the token, which the use case does in its own
 * transaction together with the work it unlocks. Without it every link is `410 TOKEN_INVALID` (the guard fails closed). The session
 * subject resolver of accounts is not here: it belongs to the session core.
 *
 * Side effects: one `register` call at boot (a second registration of the kind is a boot-time error).
 *
 * @see POST /store/v1/auth/verify
 */
@Injectable()
export class AccountIdentityRegistrar implements OnModuleInit {
  constructor(
    private readonly capabilityTokens: CapabilityTokenResolvers,
    private readonly authTokens: AccountAuthTokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers the resolver of the `link-token` access kind. */
  onModuleInit(): void {
    this.capabilityTokens.register({
      kind: 'link-token',
      resolve: async (token) => {
        const link = await this.authTokens.findByHash(token);
        const usable =
          link !== undefined && LINK_TOKEN_PURPOSES.includes(link.purpose) && isUsableLink(link, this.clock.nowMs());
        return usable ? { id: link.id } : null;
      },
    });
  }
}
