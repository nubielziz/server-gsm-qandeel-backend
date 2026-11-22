// Unit tests of the one-off seal pass loop (decision 054): it pages by id, counts what it sealed and what changed meanwhile, and stops on a short page.
import { describe, expect, it } from 'bun:test';
import { parseEnv } from '@src/config';
import { CapabilityTokenVault, type SealedCapabilityToken } from '@src/infra/crypto/capability-token-vault';
import { SEAL_PAGE, type CapabilityTokenTable, sealCapabilityTokens } from '@src/infra/crypto/capability-token-seal';
import { EncryptionService } from '@src/infra/crypto/encryption.service';
import { TokenService } from '@src/infra/crypto/token.service';

const config = parseEnv({ NODE_ENV: 'test' });
const vault = new CapabilityTokenVault(new TokenService(config), new EncryptionService(config));

/** An in-memory table: rows by id, a plain token each, and a hook that lets a row change between the read and the write. */
function memoryTable(count: number, changeId?: number) {
  const rows = new Map<number, { token: string | null; sealed?: SealedCapabilityToken }>();
  for (let id = 1; id <= count; id += 1) rows.set(id, { token: `token-${id}` });
  const reads: Array<{ afterId: number; limit: number }> = [];
  const table: CapabilityTokenTable = {
    unsealed: (afterId, limit) => {
      reads.push({ afterId, limit });
      const page = [...rows.entries()]
        .filter(([id, row]) => id > afterId && row.token !== null)
        .slice(0, limit)
        .map(([id, row]) => ({ id, token: row.token as string }));
      return Promise.resolve(page);
    },
    seal: (row, sealed) => {
      const current = rows.get(row.id);
      if (row.id === changeId && current) current.token = 'changed-meanwhile';
      if (current?.token !== row.token) return Promise.resolve(false);
      rows.set(row.id, { token: null, sealed });
      return Promise.resolve(true);
    },
  };
  return { rows, reads, table };
}

describe('sealCapabilityTokens', () => {
  it('seals every row once, paging by id, and stops on a short page', async () => {
    const { rows, reads, table } = memoryTable(SEAL_PAGE + 3);
    expect(await sealCapabilityTokens(vault, 'ticket', table)).toEqual({ sealed: SEAL_PAGE + 3, unchanged: 0 });
    expect(reads).toEqual([
      { afterId: 0, limit: SEAL_PAGE },
      { afterId: SEAL_PAGE, limit: SEAL_PAGE },
    ]);
    expect([...rows.values()].every((row) => row.token === null && row.sealed !== undefined)).toBe(true);
    expect(rows.get(1)?.sealed?.hash).toBe(vault.hashOf('ticket', 'token-1'));
  });

  it('counts a row that changed meanwhile as unchanged and leaves it as it was', async () => {
    const { rows, table } = memoryTable(3, 2);
    expect(await sealCapabilityTokens(vault, 'checkout', table)).toEqual({ sealed: 2, unchanged: 1 });
    expect(rows.get(2)?.token).toBe('changed-meanwhile');
  });

  it('finds nothing to do on a repeat and on an empty table', async () => {
    const { table } = memoryTable(2);
    await sealCapabilityTokens(vault, 'tracking', table);
    expect(await sealCapabilityTokens(vault, 'tracking', table)).toEqual({ sealed: 0, unchanged: 0 });
    expect(await sealCapabilityTokens(vault, 'tracking', memoryTable(0).table)).toEqual({ sealed: 0, unchanged: 0 });
  });
});
