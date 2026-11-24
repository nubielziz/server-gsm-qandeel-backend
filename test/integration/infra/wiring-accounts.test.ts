// Integration tests of the wiring of one account type (decision 064) on the real module graphs of both processes: every abstract port of
// the account model resolves to its implementation, and to the very instance the services inject; every registry is one instance and holds
// the entries of the modules that own the data; the worker resolves what its jobs read about accounts. Nothing here writes: the API is the
// test app (`createTestApp`, no database reset), the worker's graph is only compiled (no job starts).
// The test app is imported first: it loads the API's root module, whose order of entry is the one the module graph is written for (decision 032).
import { createTestApp, type TestApp } from '../../support/app';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { parseEnv, APP_CONFIG } from '@src/config';
import { JobSchedulerRegistry } from '@src/infra/queues';
import { LOG_DESTINATION } from '@src/infra/logging';
import { ClientGroupDirectory, RankGroupReads } from '@src/modules/catalog';
import { AccountPrivacyReads } from '@src/modules/customers';
import { AccountPrivacyReadsService } from '@src/modules/customers/application/account-privacy-reads.service';
import {
  AccountAccessEffects,
  AccountAuthTokens,
  AccountCreateGuards,
  AccountDirectory,
  AccountEmailVerification,
  AccountLinkSignIn,
  AccountListSql,
  AccountMailOutbox,
  AccountOwnPassword,
  AccountOwnProfile,
  AccountRanks,
  AccountSessions,
  AccountSignIn,
  AccountTwoFactorSetup,
  ApiKeyDirectory,
  ApiKeyRevocation,
  CapabilityTokenResolvers,
  GuestClaimParticipants,
  LegacyAccounts,
  OptionalAccountSession,
  SessionService,
} from '@src/modules/identity';
import { missingAccountEntries } from '@src/modules/identity/account-wiring-check.module';
import { AccountAccessEffectsService } from '@src/modules/identity/application/account-access-effects';
import { AccountAuthTokenService } from '@src/modules/identity/application/account-auth-tokens';
import { AccountEmailVerificationService } from '@src/modules/identity/application/account-email-verification.service';
import { AccountLinkSignInService } from '@src/modules/identity/application/account-link-sign-in.service';
import { AccountPasswordService } from '@src/modules/identity/application/account-password.service';
import { AccountSignInService } from '@src/modules/identity/application/account-sign-in.service';
import { AccountTwoFactorService } from '@src/modules/identity/application/account-two-factor.service';
import { MerchantAccountService } from '@src/modules/identity/application/merchant-account.service';
import { OptionalAccountSessionService } from '@src/modules/identity/application/optional-account-session';
import { AccountMailOutboxService } from '@src/modules/identity/application/mail/account-mail-outbox';
import {
  CustomerEmailVerificationMailProcessor,
  CustomerInvitedMailProcessor,
  CustomerPasswordResetMailProcessor,
  MagicLinkMailProcessor,
  MerchantEmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  MerchantPasswordResetMailProcessor,
} from '@src/modules/identity/jobs/account-mail.processors';
import { AccountWallets, CustomerWallets, RankChangeGuards, WalletErasure } from '@src/modules/money';
import { AccountWalletsService } from '@src/modules/money/application/account-wallets';
import { ShopOrders } from '@src/modules/orders';
import { ShopOrderReads } from '@src/modules/orders/application/shop-orders';
import { WorkerModule } from '@src/worker.module';
import { logSink } from '../../support/log-sink';
import { testInstanceEnv } from '../../support/env';
import { TEST_DATABASE_URL } from '../../support/db';

/** An abstract port, the class it must resolve to, and where it is bound. */
interface Binding {
  readonly port: Type<unknown> | (abstract new (...args: never[]) => unknown);
  readonly implementation: Type<unknown>;
  readonly name: string;
}

/** Every port of the account model the API binds with `useExisting` (decision 064). */
const API_BINDINGS: readonly Binding[] = [
  { name: 'AccountSessions', port: AccountSessions, implementation: SessionService },
  { name: 'ApiKeyRevocation', port: ApiKeyRevocation, implementation: ApiKeyDirectory },
  { name: 'AccountAuthTokens', port: AccountAuthTokens, implementation: AccountAuthTokenService },
  { name: 'AccountMailOutbox', port: AccountMailOutbox, implementation: AccountMailOutboxService },
  { name: 'AccountSignIn', port: AccountSignIn, implementation: AccountSignInService },
  { name: 'AccountTwoFactorSetup', port: AccountTwoFactorSetup, implementation: AccountTwoFactorService },
  { name: 'AccountOwnPassword', port: AccountOwnPassword, implementation: AccountPasswordService },
  { name: 'AccountLinkSignIn', port: AccountLinkSignIn, implementation: AccountLinkSignInService },
  { name: 'AccountEmailVerification', port: AccountEmailVerification, implementation: AccountEmailVerificationService },
  { name: 'OptionalAccountSession', port: OptionalAccountSession, implementation: OptionalAccountSessionService },
  { name: 'AccountOwnProfile', port: AccountOwnProfile, implementation: MerchantAccountService },
  { name: 'AccountAccessEffects', port: AccountAccessEffects, implementation: AccountAccessEffectsService },
  { name: 'AccountWallets', port: AccountWallets, implementation: AccountWalletsService },
  { name: 'WalletErasure', port: WalletErasure, implementation: CustomerWallets },
  { name: 'ShopOrders', port: ShopOrders, implementation: ShopOrderReads },
  { name: 'AccountPrivacyReads', port: AccountPrivacyReads, implementation: AccountPrivacyReadsService },
  { name: 'RankGroupReads', port: RankGroupReads, implementation: ClientGroupDirectory },
];

/** The classes that must exist once in the API: a second instance would split a registry or a test spy. */
const API_SINGLETONS: readonly (readonly [string, Type<unknown>])[] = [
  ['AccountDirectory', AccountDirectory],
  ['LegacyAccounts', LegacyAccounts],
  ['AccountRanks', AccountRanks],
  ['AccountCreateGuards', AccountCreateGuards],
  ['GuestClaimParticipants', GuestClaimParticipants],
  ['AccountListSql', AccountListSql],
  ['RankChangeGuards', RankChangeGuards],
  ['AccountWalletsService', AccountWalletsService],
  ['AccountAuthTokenService', AccountAuthTokenService],
  ['AccountMailOutboxService', AccountMailOutboxService],
];

/** The seven account mail processors (both ranks' links); the worker turns each into a BullMQ worker. */
const ACCOUNT_MAIL_PROCESSORS: readonly Type<unknown>[] = [
  MerchantEmailVerificationMailProcessor,
  MerchantPasswordResetMailProcessor,
  MerchantInvitedMailProcessor,
  MagicLinkMailProcessor,
  CustomerPasswordResetMailProcessor,
  CustomerInvitedMailProcessor,
  CustomerEmailVerificationMailProcessor,
];

describe('the API', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  it.each(API_BINDINGS.map((binding) => [binding.name, binding] as const))(
    'resolves %s to the instance of its implementation that the services inject',
    (_name, binding) => {
      const resolved = t.app.get(binding.port);
      expect(resolved).toBeInstanceOf(binding.implementation);
      // useExisting, never a second instance: the port is one of the implementation's instances in the graph.
      expect(t.app.get(binding.implementation, { each: true })).toContain(resolved);
    },
  );

  it.each(API_SINGLETONS)('holds one instance of %s', (_name, type) => {
    expect(t.app.get(type, { each: true })).toHaveLength(1);
  });

  it('gives the account link token port the one service a test spy watches', () => {
    expect(t.app.get(AccountAuthTokens)).toBe(t.app.get(AccountAuthTokenService));
  });

  it('holds the two checks of a rank change: a live order and an open checkout', () => {
    expect([...t.app.get(RankChangeGuards).names()].sort()).toEqual(['live_order', 'open_checkout']);
  });

  it('holds the six participants of the guest claim', () => {
    expect([...t.app.get(GuestClaimParticipants).names()].sort()).toEqual(
      ['customers', 'files', 'money', 'orders', 'risk_assessments', 'support'].sort(),
    );
  });

  it('holds the blocklist check of a staff create', () => {
    expect(t.app.get(AccountCreateGuards).names()).toEqual(['blocklist']);
  });

  it('builds both fragments of the account list', () => {
    const list = t.app.get(AccountListSql);
    const column = sql`1`;
    expect(() => list.orderFigure('ordersCount', column)).not.toThrow();
    expect(() => list.walletBalance(column)).not.toThrow();
  });

  it('passes the boot check of the account wiring', () => {
    expect(
      missingAccountEntries({
        rankChangeGuards: t.app.get(RankChangeGuards),
        guestClaims: t.app.get(GuestClaimParticipants),
        createGuards: t.app.get(AccountCreateGuards),
        accountList: t.app.get(AccountListSql),
      }),
    ).toEqual([]);
  });

  it('registers the resolver of the account link tokens', () => {
    expect(t.app.get(CapabilityTokenResolvers).has('link-token')).toBe(true);
  });
});

describe('the worker', () => {
  let worker: TestingModule;

  beforeAll(async () => {
    const config = parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL, ...testInstanceEnv() });
    // Compiled, not initialised: every provider is built (a missing one fails here) and no job, relay or metrics server starts.
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(LOG_DESTINATION)
      .useValue(logSink)
      .compile();
  }, 60_000);
  afterAll(async () => {
    await worker.close();
  });

  it('resolves the account records, the rank reads and the live wallet reads its jobs use', () => {
    expect(worker.get(AccountDirectory, { strict: false })).toBeInstanceOf(AccountDirectory);
    expect(worker.get(LegacyAccounts, { strict: false })).toBeInstanceOf(LegacyAccounts);
    expect(worker.get(RankGroupReads, { strict: false })).toBeInstanceOf(ClientGroupDirectory);
    expect(worker.get(AccountWallets, { strict: false })).toBeInstanceOf(AccountWalletsService);
    expect(worker.get(AccountWalletsService, { strict: false, each: true })).toHaveLength(1);
  });

  it('resolves the account link tokens and the mail outbox, and every account mail processor', () => {
    expect(worker.get(AccountAuthTokens, { strict: false })).toBeInstanceOf(AccountAuthTokenService);
    expect(worker.get(AccountMailOutbox, { strict: false })).toBeInstanceOf(AccountMailOutboxService);
    for (const processor of ACCOUNT_MAIL_PROCESSORS) {
      expect(worker.get(processor, { strict: false, each: true })).toHaveLength(1);
    }
  });

  it('loads none of the API-only registries of a rank change', () => {
    expect(() => worker.get(RankChangeGuards, { strict: false })).toThrow();
  });

  it('retires the scheduler of the old automatic checkout reminder', () => {
    worker.get(WorkerModule).onModuleInit();
    expect(worker.get(JobSchedulerRegistry, { strict: false }).retired()).toContainEqual({
      queue: 'maintenance',
      id: 'checkout-recovery-sweep',
    });
  });
});
