// The caller of a signed-in account route: the one principal every account gets from its session (whatever its rank), the actor that
// audit rows, order events, ledger lines, ticket authors and inbox owners name, and the parameter decorator handlers receive it with
// (decision 064). A leaf file: it reads the request through `access-state` and nothing else, so it loads before any service.
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../common/errors';
import type { RankKind } from './rank-kind';
import type { SessionStage } from '../db/schema';
import { principalOf } from '../security/access-state';
import type { SessionView } from '../security/session.types';

/**
 * A signed-in account: a merchant or a retail buyer, told apart by its rank.
 *
 * Why: there is one account type and one session cookie (decision 064); the rank kind decides which routes the account may call
 * (the default-deny rank gate), so the principal carries it. Handlers act on the account's own records only, by this id.
 *
 * `clientId` holds the same value as `accountId`: the controllers written for the old merchant principal keep compiling until the
 * contract release drops it.
 */
export interface AccountPrincipal {
  readonly kind: 'account';
  /** The account's id (`clients.id`). */
  readonly accountId: number;
  /** The same value as `accountId`, kept for the merchant controllers written before the accounts merged (dropped by the contract release). */
  readonly clientId: number;
  /** The rank the session saw when it was read: its id and its kind (`merchant` or `retail`). */
  readonly rank: { readonly id: number; readonly kind: RankKind };
  readonly stage: SessionStage;
  readonly ip: string;
  readonly session: SessionView;
}

/**
 * Who did a write, as the audit log, order events, the ledger and ticket authors name an account.
 *
 * Why: one word for every account, so history reads the same whatever the rank (decision 064).
 */
export interface AccountActor {
  readonly type: 'account';
  readonly id: number;
  /** The account's name when the write happened: history keeps the snapshot, a later rename does not change it. */
  readonly name: string;
}

/**
 * Names an account as the actor of a write.
 *
 * Why: audit rows, order events, ledger `created_by`, ticket authors and inbox owners all name the account the same way.
 *
 * @param account the account (an `AccountRecord`, or an id and the name of a session's snapshot)
 * @returns the actor with the type `account`
 */
export function actorOf(account: { readonly id: number; readonly name: string }): AccountActor {
  return { type: 'account', id: account.id, name: account.name };
}

/**
 * Tells whether the principal a guard produced is an account's.
 *
 * @param principal what the guards stored on the request
 * @returns true for a principal of kind `account`
 */
function isAccountPrincipal(principal: unknown): principal is AccountPrincipal {
  return typeof principal === 'object' && principal !== null && (principal as { kind?: unknown }).kind === 'account';
}

/**
 * The decorator that reads the principal of the request (see {@link CurrentAccount}).
 *
 * @throws {AppError} `UNAUTHORIZED` (401) when the request was not authenticated as an account
 */
const accountParam = createParamDecorator((_data: unknown, context: ExecutionContext): AccountPrincipal => {
  const principal: unknown = principalOf(context.switchToHttp().getRequest<FastifyRequest>());
  if (!isAccountPrincipal(principal)) throw new AppError('UNAUTHORIZED');
  return principal;
});

/**
 * Parameter decorator: the signed-in account of an account route.
 *
 * Why: the handlers of the merchant surface and of the store surface act for the account of the session only; this fails loudly
 * if the route was not authenticated as an account (the access guard has already refused anyone else).
 *
 * A function declaration, not a constant: `access-state` (which this file reads) names it as the old `CurrentMerchant`, and the two files import
 * each other, so the binding must exist before this file's body has run, whichever of the two is loaded first.
 *
 * @param dataOrPipes none (Nest passes them on to the factory, which ignores them)
 * @returns the parameter decorator
 * @throws {AppError} `UNAUTHORIZED` (401) when the request was not authenticated as an account
 * @example
 * `me(@CurrentAccount() account: AccountPrincipal)`
 */
export function CurrentAccount(...dataOrPipes: Parameters<typeof accountParam>): ParameterDecorator {
  return accountParam(...dataOrPipes);
}
