// Shape parity (decision 009, docs/contract/TESTS.md § 2): for every built route the frontend calls, the response, the
// request and the success status match what the console reads and sends, and the harvested fixture satisfies the
// response schema. Deviations pass only through test/contract/allowlist.ts.
import { afterAll, describe, expect, it } from 'bun:test';
import { ALLOWLIST } from './allowlist';
import { RULES } from './lib/compare';
import { type Finding, compareRoute, describeFinding } from './lib/compare-route';
import { reconcile, validateEntries } from './lib/allowlist-check';
import { fixtureFindings } from './lib/fixture-check';
import {
  fixtureFileName,
  loadFixtures,
  loadFrontendEndpoints,
  loadMismatchIds,
  loadSuccessStatuses,
} from './lib/inputs';
import { appSnapshot } from './lib/snapshot';
import { createValidator } from './lib/validate';

const snapshot = await appSnapshot();
const frontend = new Map(loadFrontendEndpoints().map((endpoint) => [endpoint.key, endpoint]));
const statuses = loadSuccessStatuses();
const fixtures = new Map(loadFixtures().map((fixture) => [fixture.file, fixture]));
const ajv = createValidator();

/** Every finding of the run, for the allowlist checks at the end. */
const allFindings: Finding[] = [];

const compared = snapshot.contracts.filter((contract) => frontend.has(contract.key));

describe('built routes the frontend calls', () => {
  it('has routes to compare', () => {
    // GET /health is the one map route the console calls that exists since P2.1; the others arrive with their features.
    expect(compared.map((contract) => contract.key)).toContain('GET /health');
  });

  for (const contract of compared) {
    it(`${contract.key}: response, request and status match the console`, () => {
      const endpoint = frontend.get(contract.key);
      const expected = statuses.get(contract.key);
      if (!endpoint || expected === undefined)
        throw new Error(`${contract.key}: no frontend function or documented status`);
      const found = [
        ...compareRoute(endpoint, contract, expected),
        ...fixtureFindings(contract, fixtures.get(fixtureFileName(contract.key)), ajv),
      ];
      allFindings.push(...found);
      const { unexpected } = reconcile(found, ALLOWLIST);
      expect(unexpected.map(describeFinding)).toEqual([]);
    });
  }
});

describe('extra backend fields', () => {
  it('are reported, never failing', () => {
    const extra = allFindings.filter((finding) => finding.severity === 'info');
    if (extra.length > 0) console.info(`contract notes (${extra.length}):\n${extra.map(describeFinding).join('\n')}`);
    expect(extra.every((finding) => finding.severity === 'info')).toBe(true);
  });
});

describe('the allowlist', () => {
  it('cites existing B-ids, known rules and a reason, once each', () => {
    expect(validateEntries(ALLOWLIST, loadMismatchIds(), RULES)).toEqual([]);
  });

  it('has no stale entry: each one still matches a real deviation', () => {
    // Runs after the route tests above (bun runs a file's tests in order).
    const { stale } = reconcile(allFindings, ALLOWLIST);
    expect(stale.map((entry) => `${entry.route} [${entry.part ?? 'response'}] ${entry.path} (${entry.rule})`)).toEqual(
      [],
    );
  });
});

afterAll(() => {
  const pending = snapshot.contracts.length;
  console.info(
    `shape parity: ${compared.length} of ${pending} built routes are called by the console and were compared.`,
  );
});
