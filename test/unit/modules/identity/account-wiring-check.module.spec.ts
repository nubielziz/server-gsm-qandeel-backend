// Unit tests of the boot check of the account wiring (decision 064; mirrors src/modules/identity/account-wiring-check.module.ts): it names
// every entry the account registries lack, and passes once the modules that own the data registered theirs. No database: the registries are
// plain classes and the list's fragments build SQL values without running them.
// The catalog's index is loaded first, the way the API's root module loads it (decision 032): entered through identity's index, the module
// graph reads a class before it is initialised.
import '@src/modules/catalog';
import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { AccountCreateGuards, AccountListSql, GuestClaimParticipants } from '@src/modules/identity';
import {
  AccountWiringCheck,
  REQUIRED_ACCOUNT_CREATE_CHECKS,
  REQUIRED_GUEST_CLAIM_PARTICIPANTS,
  REQUIRED_RANK_CHANGE_CHECKS,
  missingAccountEntries,
} from '@src/modules/identity/account-wiring-check.module';
import { RankChangeGuards } from '@src/modules/money';

/** Four empty registries, as a process has them before any module init. */
function emptyRegistries() {
  return {
    rankChangeGuards: new RankChangeGuards(),
    guestClaims: new GuestClaimParticipants(),
    createGuards: new AccountCreateGuards(),
    accountList: new AccountListSql(),
  };
}

/** The registries after every owning module registered its entries, less the names given. */
function registriesWithout(...left: string[]) {
  const registries = emptyRegistries();
  for (const name of REQUIRED_RANK_CHANGE_CHECKS) {
    if (!left.includes(name)) registries.rankChangeGuards.register(name, () => Promise.resolve([]));
  }
  for (const name of REQUIRED_GUEST_CLAIM_PARTICIPANTS) {
    if (!left.includes(name)) registries.guestClaims.register(name, () => Promise.resolve(0));
  }
  for (const name of REQUIRED_ACCOUNT_CREATE_CHECKS) {
    if (!left.includes(name)) registries.createGuards.register(name, () => Promise.resolve());
  }
  if (!left.includes('order figures')) registries.accountList.registerOrderFigure(() => sql`0`);
  if (!left.includes('wallet balance')) registries.accountList.registerWalletBalance(() => sql`0`);
  return registries;
}

/** The check built on the given registries, as Nest builds it. */
function checkOn(registries: ReturnType<typeof emptyRegistries>): AccountWiringCheck {
  return new AccountWiringCheck(
    registries.rankChangeGuards,
    registries.guestClaims,
    registries.createGuards,
    registries.accountList,
  );
}

describe('the entries the account features rely on', () => {
  it('are the two rank change checks, the six guest-claim participants and the blocklist', () => {
    expect([...REQUIRED_RANK_CHANGE_CHECKS]).toEqual(['live_order', 'open_checkout']);
    expect([...REQUIRED_GUEST_CLAIM_PARTICIPANTS].sort()).toEqual(
      ['customers', 'files', 'money', 'orders', 'risk_assessments', 'support'].sort(),
    );
    expect([...REQUIRED_ACCOUNT_CREATE_CHECKS]).toEqual(['blocklist']);
  });
});

describe('missingAccountEntries', () => {
  it('names every entry of empty registries', () => {
    expect(missingAccountEntries(emptyRegistries())).toEqual([
      'rank change check "live_order"',
      'rank change check "open_checkout"',
      'guest claim participant "orders"',
      'guest claim participant "customers"',
      'guest claim participant "money"',
      'guest claim participant "files"',
      'guest claim participant "risk_assessments"',
      'guest claim participant "support"',
      'account create check "blocklist"',
      'account list fragment "order figures"',
      'account list fragment "wallet balance"',
    ]);
  });

  it('is empty once every module registered its entries', () => {
    expect(missingAccountEntries(registriesWithout())).toEqual([]);
  });

  it('names only what a left-out module would have registered', () => {
    // The checkout module registers the open-checkout check and the customers participant: without it, exactly those two are missing.
    expect(missingAccountEntries(registriesWithout('open_checkout', 'customers'))).toEqual([
      'rank change check "open_checkout"',
      'guest claim participant "customers"',
    ]);
    expect(missingAccountEntries(registriesWithout('wallet balance'))).toEqual([
      'account list fragment "wallet balance"',
    ]);
  });

  it('accepts entries of other modules beside the required ones', () => {
    const registries = registriesWithout();
    registries.guestClaims.register('extra', () => Promise.resolve(0));
    expect(missingAccountEntries(registries)).toEqual([]);
  });
});

describe('AccountWiringCheck', () => {
  it('refuses to boot while a rank change check is missing, and says which', () => {
    const check = checkOn(registriesWithout('live_order'));
    expect(() => check.onApplicationBootstrap()).toThrow(
      'The account wiring is incomplete (decision 064): missing rank change check "live_order"',
    );
  });

  it('names every gap in one boot error', () => {
    const check = checkOn(registriesWithout('support', 'blocklist'));
    expect(() => check.onApplicationBootstrap()).toThrow(
      /missing guest claim participant "support", account create check "blocklist"$/,
    );
  });

  it('lets the API boot when the wiring is complete', () => {
    expect(() => checkOn(registriesWithout()).onApplicationBootstrap()).not.toThrow();
  });
});
