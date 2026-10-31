// Unit tests of the scheduler registry (decision 020): what a module may register, and what is refused at boot.
import { describe, expect, it } from 'bun:test';
import { repeatOptionsOf } from './job-scheduler-runner';
import { type JobSchedulerSpec, JobSchedulerRegistry } from './job-schedulers';

const spec = (overrides: Partial<JobSchedulerSpec> = {}): JobSchedulerSpec => ({
  id: 'ledger-integrity',
  queue: 'maintenance',
  jobName: 'ledger_integrity',
  pattern: '30 2 * * *',
  description: 'Nightly ledger integrity check.',
  ...overrides,
});

describe('JobSchedulerRegistry', () => {
  it('lists what was registered, in order', () => {
    const registry = new JobSchedulerRegistry();
    registry.register(spec());
    registry.register(spec({ id: 'price-sync', pattern: undefined, every: 900_000 }));
    expect(registry.list().map((entry) => entry.id)).toEqual(['ledger-integrity', 'price-sync']);
  });

  it('needs exactly one of every and pattern', () => {
    const registry = new JobSchedulerRegistry();
    expect(() => registry.register(spec({ pattern: undefined }))).toThrow(/exactly one of "every" and "pattern"/);
    expect(() => registry.register(spec({ every: 1000 }))).toThrow(/exactly one of "every" and "pattern"/);
  });

  it('needs every to be a positive whole number of milliseconds', () => {
    const registry = new JobSchedulerRegistry();
    for (const every of [0, -5, 1.5, Number.NaN]) {
      expect(() => registry.register(spec({ pattern: undefined, every })), String(every)).toThrow(
        /positive whole number/,
      );
    }
  });

  it('refuses a duplicate id on one queue but allows it on another', () => {
    const registry = new JobSchedulerRegistry();
    registry.register(spec());
    expect(() => registry.register(spec())).toThrow(/already registered/);
    registry.register(spec({ queue: 'alerts' }));
    expect(registry.list()).toHaveLength(2);
  });

  it('refuses an unknown queue and an id with odd characters', () => {
    const registry = new JobSchedulerRegistry();
    expect(() => registry.register(spec({ queue: 'nope' as never }))).toThrow(/unknown queue/);
    expect(() => registry.register(spec({ id: 'Bad Id' }))).toThrow(/lower case/);
    expect(() => registry.register(spec({ id: 'a:b' }))).toThrow(/lower case/);
  });

  it('keeps retired ids apart and refuses an id that is both live and retired', () => {
    const registry = new JobSchedulerRegistry();
    registry.register(spec());
    registry.retire('maintenance', 'old-sync');
    expect(registry.retired()).toEqual([{ queue: 'maintenance', id: 'old-sync' }]);
    expect(() => registry.retire('maintenance', 'ledger-integrity')).toThrow(/registered and retired/);
    registry.retire('alerts', 'x');
    expect(() => registry.register(spec({ queue: 'alerts', id: 'x' }))).toThrow(/registered and retired/);
  });
});

describe('repeatOptionsOf', () => {
  it('maps every to { every } and a cron pattern to { pattern, tz } with UTC by default', () => {
    expect(repeatOptionsOf(spec({ pattern: undefined, every: 1000 }))).toEqual({ every: 1000 });
    expect(repeatOptionsOf(spec())).toEqual({ pattern: '30 2 * * *', tz: 'UTC' });
    expect(repeatOptionsOf(spec({ tz: 'Asia/Amman' }))).toEqual({ pattern: '30 2 * * *', tz: 'Asia/Amman' });
  });
});
