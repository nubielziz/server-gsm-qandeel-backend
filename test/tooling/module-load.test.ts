// Loads every module's public API, and the API and worker root modules, each in a fresh Bun process (decision 032), and checks that each
// public API carries the seams the account model needs and no longer carries what decision 064 deleted.
// Modules import each other through their index.ts and some pairs form import cycles (identity calls money and catalog
// services, their controllers use identity's decorators); a cycle that reads a binding before it is initialised fails at
// class-definition time, and only for some entry orders, so each entry point is loaded on its own here.
import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

const MODULE_ENTRIES = readdirSync(path.join(ROOT, 'src', 'modules'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `./src/modules/${entry.name}/index.ts`)
  .sort();

/**
 * Files inside a module that a test imports before any barrel: the account details editor reaches the shop's currencies through money's
 * leaf port, never through money's barrel, whose module leads back into identity's barrel and its write service.
 */
const INNER_ENTRIES = ['./src/modules/identity/application/client-details-editor.ts'];

/** Every entry point a process or a script may load first. */
const ENTRIES = [...MODULE_ENTRIES, ...INNER_ENTRIES, './src/app.module.ts', './src/worker.module.ts'];

/**
 * Imports one entry in a new Bun process started at the repository root (Bun reads the decorator flags of tsconfig.json
 * from the working directory).
 *
 * @param entry the file to import, relative to the repository root
 * @returns the exit code and what the process wrote to stderr
 */
async function load(entry: string): Promise<{ entry: string; exitCode: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, '-e', `import 'reflect-metadata'; await import('${entry}');`], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { entry, exitCode, stderr };
}

/** The values (classes, registries, functions) each module's index must export for the other modules to code against (decision 064). */
const NEW_PUBLIC_VALUES: Readonly<Record<string, readonly string[]>> = {
  identity: [
    'CurrentAccount',
    'actorOf',
    'canAct',
    'sessionStateOf',
    'rankKindOf',
    'AccountDirectory',
    'LegacyAccounts',
    'AccountRanks',
    'AccountSessions',
    'ApiKeyRevocation',
    'AccountAuthTokens',
    'AccountMailOutbox',
    'AccountSignIn',
    'AccountTwoFactorSetup',
    'AccountOwnPassword',
    'AccountLinkSignIn',
    'AccountEmailVerification',
    'OptionalAccountSession',
    'AccountAccessEffects',
    'AccountCreateGuards',
    'GuestClaimParticipants',
    'AccountListSql',
  ],
  money: [
    'walletKindOfRank',
    'lockAccountTopUps',
    'RankChangeGuards',
    'AccountWallets',
    'WalletErasure',
    'ShopCurrencyReads',
  ],
  orders: ['isPrepaidOrder', 'prepaidOrderSql', 'ShopOrders'],
  customers: ['AccountPrivacyReads'],
  catalog: ['RankGroupReads'],
};

/** The values decision 064 deletes: the merchant-only sign-in, the customer tokens and the customer mail family are gone from the indexes. */
const REMOVED_PUBLIC_VALUES: Readonly<Record<string, readonly string[]>> = {
  identity: ['MerchantPasswordSignIn', 'CustomerAuthTokens', 'CustomerTokensModule', 'CUSTOMER_TOKEN_PURPOSES'],
  customers: ['CustomerMailModule', 'CUSTOMER_MAIL_EVENTS'],
};

/**
 * Imports one module index in a new process and reports which of the given names it exports.
 *
 * @param moduleId the module folder name
 * @param names the export names to look for
 * @returns the exit code, what the process wrote to stderr and the names that are exported
 */
async function exportedNames(
  moduleId: string,
  names: readonly string[],
): Promise<{ exitCode: number; stderr: string; present: string[] }> {
  const script =
    "import 'reflect-metadata'; " +
    `const loaded = await import('./src/modules/${moduleId}/index.ts'); ` +
    `console.log(JSON.stringify(${JSON.stringify(names)}.filter((name) => name in loaded)));`;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const present = exitCode === 0 ? (JSON.parse(stdout.trim().split('\n').pop() ?? '[]') as string[]) : [];
  return { exitCode, stderr, present };
}

describe('module public APIs', () => {
  it('each load on their own, whatever is imported first (no import-cycle TDZ errors)', async () => {
    expect(MODULE_ENTRIES.length).toBeGreaterThanOrEqual(12);
    const results = await Promise.all(ENTRIES.map(load));
    const failed = results
      .filter((result) => result.exitCode !== 0)
      .map(
        (result) => `${result.entry}: ${result.stderr.split('\n').find((line) => /Error/.test(line)) ?? result.stderr}`,
      );
    expect(failed).toEqual([]);
  }, 30_000);

  it('exports the seams of the account model and no longer the files decision 064 deleted', async () => {
    const moduleIds = [...new Set([...Object.keys(NEW_PUBLIC_VALUES), ...Object.keys(REMOVED_PUBLIC_VALUES)])].sort();
    const problems: string[] = [];
    await Promise.all(
      moduleIds.map(async (moduleId) => {
        const expected = NEW_PUBLIC_VALUES[moduleId] ?? [];
        const removed = REMOVED_PUBLIC_VALUES[moduleId] ?? [];
        const result = await exportedNames(moduleId, [...expected, ...removed]);
        if (result.exitCode !== 0) {
          problems.push(
            `${moduleId}: does not load: ${result.stderr.split('\n').find((line) => /Error/.test(line)) ?? result.stderr}`,
          );
          return;
        }
        for (const name of expected)
          if (!result.present.includes(name)) problems.push(`${moduleId}: ${name} is not exported`);
        for (const name of removed)
          if (result.present.includes(name)) problems.push(`${moduleId}: ${name} is still exported`);
      }),
    );
    expect(problems.sort()).toEqual([]);
  }, 30_000);
});
