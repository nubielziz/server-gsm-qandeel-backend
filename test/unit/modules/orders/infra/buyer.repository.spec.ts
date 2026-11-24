// Unit tests of the one run-time check of the order engine's money paths: they must run in a transaction (decision 064).
import { describe, expect, it } from 'bun:test';
import type { DbExecutor } from '@src/infra/db';
import { asTransaction } from '@src/modules/orders/infra/buyer.repository';

describe('asTransaction', () => {
  it('hands back the same object when the executor is a transaction (it can roll back)', () => {
    const transaction = { rollback: () => undefined } as unknown as DbExecutor;
    expect(asTransaction(transaction)).toBe(transaction as never);
  });

  it('refuses a plain database handle: a money path outside a transaction is a programming error', () => {
    expect(() => asTransaction({} as DbExecutor)).toThrow('inside a transaction');
  });
});
