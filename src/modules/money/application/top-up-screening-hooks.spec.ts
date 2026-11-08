// Unit tests of the top-up screening hook list (RESOLUTIONS money-3): an empty list flags nothing, the first flag wins, a throwing
// hook fails the screen (the credit never goes ahead on a screen that did not answer).
import { describe, expect, it } from 'bun:test';
import { expectRejection } from '../../../../test/support/rejection';
import type { DbExecutor } from '../../../infra/db';
import { type TopUpScreeningAnswer, TopUpScreeningHooks } from './top-up-screening-hooks';

const db = {} as DbExecutor;
const facts = { cardFingerprint: 'fp_1', email: 'merchant@example.com' };
const clear: TopUpScreeningAnswer = { flagged: false, reason: null };

describe('TopUpScreeningHooks', () => {
  it('flags nothing when no module registered a hook', async () => {
    expect(await new TopUpScreeningHooks().screen(db, facts)).toEqual(clear);
  });

  it('returns the first flagged answer and does not ask the hooks after it', async () => {
    const hooks = new TopUpScreeningHooks();
    const asked: string[] = [];
    hooks.add({ screenTopUp: () => (asked.push('a'), Promise.resolve(clear)) });
    hooks.add({ screenTopUp: () => (asked.push('b'), Promise.resolve({ flagged: true, reason: 'Risk review: b' })) });
    hooks.add({ screenTopUp: () => (asked.push('c'), Promise.resolve({ flagged: true, reason: 'Risk review: c' })) });
    expect(await hooks.screen(db, facts)).toEqual({ flagged: true, reason: 'Risk review: b' });
    expect(asked).toEqual(['a', 'b']);
  });

  it('hands every hook the facts and the transaction', async () => {
    const hooks = new TopUpScreeningHooks();
    const seen: unknown[] = [];
    hooks.add({ screenTopUp: (tx, given) => (seen.push(tx, given), Promise.resolve(clear)) });
    await hooks.screen(db, facts);
    expect(seen).toEqual([db, facts]);
  });

  it('lets a hook that throws fail the screen', async () => {
    const hooks = new TopUpScreeningHooks();
    hooks.add({ screenTopUp: () => Promise.reject(new Error('rules unavailable')) });
    await expectRejection(hooks.screen(db, facts), 'rules unavailable');
  });
});
