// Accepted deviations between the backend and the frontend contract (docs/contract/TESTS.md, decision 009).
import type { AllowlistEntry } from './lib/allowlist-check';

/**
 * Deviations the contract tests accept, each tied to a decision in docs/contract/MISMATCHES.md.
 *
 * Why: the frontend decides the wire format and the map decides the rules; where the lead chose otherwise the choice
 * is a B-entry, and this list is the only place a test is told to accept it. An entry whose B-id does not exist, or that
 * no longer matches a real deviation, fails the build, so the list cannot rot. Add an entry only after the B-entry
 * exists; see test/contract/README.md.
 *
 * @example
 * { route: 'GET /admin/orders', part: 'response', path: 'data[].status', rule: 'enum', mismatch: 'B16',
 *   reason: 'The backend adds needs_attention until the console learns the status.' }
 */
export const ALLOWLIST: readonly AllowlistEntry[] = [];
