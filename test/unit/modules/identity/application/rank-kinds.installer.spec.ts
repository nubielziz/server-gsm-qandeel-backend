// Unit tests of the installer of the rank kind lookup (decision 064): the kind of a group comes from the catalog's reader, and the
// kind-to-rights rule is rankKindOf (only b2b is a merchant rank).
import { describe, expect, it } from 'bun:test';
import type { DbService } from '@src/infra/db';
import type { RankGroupReads } from '@src/modules/catalog';
import { RankKindsInstaller } from '@src/modules/identity/application/rank-kinds.installer';
import { RankKinds } from '@src/modules/identity/security/rank-kinds';

const db = { db: { marker: 'db' } } as unknown as DbService;

function installed(kinds: Record<number, string>) {
  const seen: Array<{ db: unknown; groupId: number }> = [];
  const groups = {
    kindOf: (executor: unknown, groupId: number) => {
      seen.push({ db: executor, groupId });
      return Promise.resolve(kinds[groupId]);
    },
  } as unknown as RankGroupReads;
  const ranks = new RankKinds();
  new RankKindsInstaller(ranks, groups, db).onModuleInit();
  return { ranks, seen };
}

describe('RankKindsInstaller', () => {
  it('reads the kind of a group through RankGroupReads and the database of the service', async () => {
    const { ranks, seen } = installed({ 4: 'b2b' });
    expect(await ranks.kindOf(4)).toBe('merchant');
    expect(seen).toEqual([{ db: db.db, groupId: 4 }]);
  });

  it('gives retail rights to b2c_retail and to a kind the code does not know (fail closed)', async () => {
    const { ranks } = installed({ 1: 'b2c_retail', 2: 'wholesale', 3: '' });
    expect(await ranks.kindOf(1)).toBe('retail');
    expect(await ranks.kindOf(2)).toBe('retail');
    expect(await ranks.kindOf(3)).toBe('retail');
  });

  it('answers undefined for a group the catalog does not know', async () => {
    const { ranks } = installed({});
    expect(await ranks.kindOf(7)).toBeUndefined();
  });
});
