// Unit tests of the processor table (decision 020): which combinations of @QueueProcessor are valid, and how a job finds
// its processor.
import { describe, expect, it } from 'bun:test';
import type { DiscoveryService } from '@nestjs/core';
import { type DiscoveredProcessor, buildProcessorTable, findQueueProcessors, handlerFor } from './queue-processor';

const instance = { process: () => Promise.resolve(undefined) };
const processor = (label: string, queue: DiscoveredProcessor['queue'], jobName?: string): DiscoveredProcessor => ({
  label,
  queue,
  jobName,
  instance,
});

describe('buildProcessorTable', () => {
  it('groups processors by queue', () => {
    const table = buildProcessorTable([
      processor('Dispatch', 'supplier-dispatch'),
      processor('Integrity', 'maintenance', 'ledger_integrity'),
      processor('Promotion', 'maintenance', 'group_promotion'),
    ]);
    expect([...table.keys()].sort()).toEqual(['maintenance', 'supplier-dispatch']);
    expect(table.get('supplier-dispatch')?.catchAll?.label).toBe('Dispatch');
    expect([...(table.get('maintenance')?.byName.keys() ?? [])].sort()).toEqual([
      'group_promotion',
      'ledger_integrity',
    ]);
  });

  it('is empty when nothing is registered', () => {
    expect(buildProcessorTable([]).size).toBe(0);
  });

  it('refuses two catch-all processors on one queue', () => {
    expect(() => buildProcessorTable([processor('A', 'files'), processor('B', 'files')])).toThrow(
      /more than one catch-all processor: A, B/,
    );
  });

  it('refuses a catch-all together with a named processor on one queue', () => {
    expect(() => buildProcessorTable([processor('All', 'alerts'), processor('One', 'alerts', 'evaluate')])).toThrow(
      /catch-all processor All and also named processors \(One for "evaluate"\)/,
    );
  });

  it('refuses two processors for one job name', () => {
    expect(() =>
      buildProcessorTable([processor('A', 'maintenance', 'retention'), processor('B', 'maintenance', 'retention')]),
    ).toThrow(/two processors for job "retention": A and B/);
  });

  it('accepts the same job name on different queues', () => {
    expect(
      buildProcessorTable([processor('A', 'maintenance', 'sync'), processor('B', 'supplier-sync', 'sync')]).size,
    ).toBe(2);
  });
});

describe('handlerFor', () => {
  it('prefers the processor of the job name and falls back to the catch-all', () => {
    const named = buildProcessorTable([processor('Tick', 'outbox-relay', 'tick')]).get('outbox-relay')!;
    expect(handlerFor(named, 'tick')?.label).toBe('Tick');
    expect(handlerFor(named, 'other')).toBeUndefined();
    const all = buildProcessorTable([processor('All', 'files')]).get('files')!;
    expect(handlerFor(all, 'anything')?.label).toBe('All');
  });
});

describe('findQueueProcessors', () => {
  /** A discovery service that finds one marked provider. */
  const discoveryWith = (wrapper: { static: boolean; instance: unknown }) =>
    ({
      getProviders: () => [
        {
          metatype: { name: 'SomeProcessor' },
          instance: wrapper.instance,
          isDependencyTreeStatic: () => wrapper.static,
        },
      ],
      getMetadataByDecorator: () => ({ queue: 'notifications' }),
    }) as unknown as DiscoveryService;

  it('finds a static processor', () => {
    const found = findQueueProcessors(discoveryWith({ static: true, instance }));
    expect(found.map((entry) => entry.label)).toEqual(['SomeProcessor']);
  });

  it('refuses a request-scoped processor at boot instead of skipping it (its jobs would pile up unnoticed)', () => {
    expect(() => findQueueProcessors(discoveryWith({ static: false, instance: undefined }))).toThrow(/request-scoped/);
  });
});
