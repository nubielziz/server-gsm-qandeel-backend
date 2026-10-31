// Unit tests of the per-request context (decisions 012, 018): the actor and IP the guards record, the audit counter.
import { describe, expect, it } from 'bun:test';
import { countAuditRecord, getRequestContext, runInRequestContext, setRequestActor } from './request-context';

describe('request context', () => {
  it('is empty outside a request, and the helpers do nothing there', () => {
    expect(getRequestContext()).toBeUndefined();
    setRequestActor({ type: 'staff', id: 1 }, '10.0.0.1');
    countAuditRecord();
    expect(getRequestContext()).toBeUndefined();
  });

  it('starts without an actor, an IP or audit rows', () => {
    runInRequestContext('r1', () => {
      expect(getRequestContext()).toEqual({ requestId: 'r1', actor: undefined, ip: undefined, auditRecords: 0 });
    });
  });

  it('keeps what a guard recorded for everything the request starts afterwards', async () => {
    await runInRequestContext('r2', async () => {
      setRequestActor({ type: 'client', id: 12 }, '203.0.113.5');
      await new Promise((resolve) => setTimeout(resolve, 1));
      countAuditRecord();
      countAuditRecord();
      expect(getRequestContext()).toMatchObject({
        requestId: 'r2',
        actor: { type: 'client', id: 12 },
        ip: '203.0.113.5',
        auditRecords: 2,
      });
    });
  });

  it('keeps parallel requests apart', async () => {
    const seen = await Promise.all(
      [1, 2, 3].map((id) =>
        runInRequestContext(`r${id}`, async () => {
          setRequestActor({ type: 'staff', id }, `10.0.0.${id}`);
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
          return getRequestContext()?.actor?.id;
        }),
      ),
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  it('gives a nested context its own actor', () => {
    runInRequestContext('outer', () => {
      setRequestActor({ type: 'staff', id: 1 }, '10.0.0.1');
      runInRequestContext('inner', () => {
        expect(getRequestContext()?.actor).toBeUndefined();
      });
      expect(getRequestContext()?.actor?.id).toBe(1);
    });
  });
});
