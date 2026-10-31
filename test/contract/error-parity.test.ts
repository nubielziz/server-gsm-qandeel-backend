// Error parity (decision 009, docs/contract/TESTS.md § 3): the error catalog equals docs/contract/error-codes.md, and
// every code the frontend references exists in it with the status the frontend expects. Backend-only codes are reported.
import { describe, expect, it } from 'bun:test';
import { ERROR_CATALOG } from '../../src/common/errors';
import { loadErrorCodesDocument, loadFrontendErrorRefs } from './lib/inputs';

const documented = loadErrorCodesDocument();
const documentedByCode = new Map(documented.map((row) => [row.code, row]));
const catalog = new Map(Object.entries(ERROR_CATALOG).map(([code, entry]) => [code, entry]));

/** Codes the console makes up itself (error-codes.md: "Client-only codes ... are not emitted"). */
const CLIENT_ONLY = new Set(['NETWORK_ERROR', 'INVALID_RESPONSE', 'HTTP_<status>']);
/** Spellings that only the console's tests use, and the catalog code they stand for. */
const TEST_SPELLINGS: Readonly<Record<string, string>> = { INTERNAL: 'INTERNAL_ERROR' };

describe('the catalog against docs/contract/error-codes.md', () => {
  it('lists the same codes', () => {
    expect([...catalog.keys()].filter((code) => !documentedByCode.has(code)).sort()).toEqual([]);
    expect([...documentedByCode.keys()].filter((code) => !catalog.has(code)).sort()).toEqual([]);
  });

  it('gives each code the documented status and a title', () => {
    const wrong: string[] = [];
    for (const row of documented) {
      const entry = catalog.get(row.code);
      if (entry?.status !== row.status) wrong.push(`${row.code}: document ${row.status}, catalog ${entry?.status}`);
      if (!entry?.title) wrong.push(`${row.code}: no title`);
    }
    expect(wrong).toEqual([]);
  });

  it('documents each code once', () => {
    expect(documented.length).toBe(documentedByCode.size);
  });
});

describe('the codes the frontend references', () => {
  const references = loadFrontendErrorRefs();
  const serverReferences = references.filter((ref) => !CLIENT_ONLY.has(ref.code));

  it('exist in the catalog with the status the frontend expects', () => {
    const wrong: string[] = [];
    for (const ref of serverReferences) {
      const code = TEST_SPELLINGS[ref.code] ?? ref.code;
      const entry = catalog.get(code);
      if (!entry) wrong.push(`${ref.code}: not in the catalog (used at ${ref.where.slice(0, 2).join(', ')})`);
      else if (entry.status !== ref.status)
        wrong.push(`${ref.code}: frontend expects ${ref.status}, catalog has ${entry.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('are the codes marked "Frontend" in error-codes.md', () => {
    const referenced = new Set(serverReferences.map((ref) => TEST_SPELLINGS[ref.code] ?? ref.code));
    const marked = new Set(documented.filter((row) => row.frontend).map((row) => row.code));
    expect([...referenced].filter((code) => !marked.has(code)).sort()).toEqual([]);
    expect([...marked].filter((code) => !referenced.has(code)).sort()).toEqual([]);
  });

  it('keep the client-only codes out of the catalog', () => {
    for (const code of CLIENT_ONLY) expect(catalog.has(code), code).toBe(false);
  });

  it('reports the codes only the backend uses (not a failure)', () => {
    const referenced = new Set(serverReferences.map((ref) => TEST_SPELLINGS[ref.code] ?? ref.code));
    const backendOnly = [...catalog.keys()].filter((code) => !referenced.has(code)).sort();
    // The console shows these through their title and detail (error-codes.md); printing them keeps the report visible.
    console.info(`error codes only the backend emits (${backendOnly.length}): ${backendOnly.join(', ')}`);
    expect(backendOnly).toEqual(
      documented
        .filter((row) => !row.frontend)
        .map((row) => row.code)
        .sort(),
    );
  });
});
