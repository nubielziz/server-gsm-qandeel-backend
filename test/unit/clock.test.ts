// Unit tests of the Clock (decision 031): the system clock reads the real time, the module provides it globally, and the test
// clock and manual timers behave as the tests that depend on them assume. They live in test/unit because they must read the
// real time, which specs under src/ may not.
import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'bun:test';
import { CLOCK, type Clock, SystemClock, TIMERS, type Timers, systemTimers } from '../../src/common/clock';
import { ClockModule } from '../../src/common/clock.module';
import { ManualTimers, TestClock } from '../support/clock';

describe('SystemClock', () => {
  it('reads the system time, as a new Date each time', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const now = clock.now();
    const nowMs = clock.nowMs();
    const after = Date.now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(nowMs).toBeGreaterThanOrEqual(now.getTime());
    expect(nowMs).toBeLessThanOrEqual(after);
    expect(clock.now()).not.toBe(clock.now());
  });
});

describe('ClockModule', () => {
  @Injectable()
  class NeedsTime {
    constructor(
      @Inject(CLOCK) readonly clock: Clock,
      @Inject(TIMERS) readonly timers: Timers,
    ) {}
  }
  @Module({ providers: [NeedsTime], exports: [NeedsTime] })
  class Feature {}

  it('provides the clock and the timers to a module that imports nothing for them', async () => {
    const root = await Test.createTestingModule({ imports: [ClockModule, Feature] }).compile();
    const service = root.get(NeedsTime, { strict: false });
    expect(service.clock).toBeInstanceOf(SystemClock);
    expect(service.timers).toBe(systemTimers);
    await root.close();
  });

  it('lets a test replace the clock', async () => {
    const test = new TestClock('2026-11-01T10:00:00.000Z');
    const root = await Test.createTestingModule({ imports: [ClockModule, Feature] })
      .overrideProvider(CLOCK)
      .useValue(test)
      .compile();
    expect(root.get(NeedsTime, { strict: false }).clock.now().toISOString()).toBe('2026-11-01T10:00:00.000Z');
    await root.close();
  });
});

describe('systemTimers', () => {
  it('runs a timer, and does not run one that was cleared', async () => {
    let ran = 0;
    systemTimers.setTimeout(() => ran++, 1);
    const cleared = systemTimers.setTimeout(() => (ran += 100), 1);
    systemTimers.clearTimeout(cleared);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toBe(1);
  });
});

describe('TestClock', () => {
  it('stands still until it is moved', () => {
    const clock = new TestClock('2026-11-01T10:00:00.000Z');
    expect(clock.nowMs()).toBe(Date.parse('2026-11-01T10:00:00.000Z'));
    expect(clock.now()).toEqual(clock.now());
    expect(clock.now()).not.toBe(clock.now());
  });

  it('moves forwards and backwards, and can be set', () => {
    const clock = new TestClock(1_000);
    expect(clock.advance(500)).toBe(1_500);
    expect(clock.advance(-1_000)).toBe(500);
    clock.set(new Date(9_000));
    expect(clock.nowMs()).toBe(9_000);
    clock.set('1970-01-01T00:00:10.000Z');
    expect(clock.nowMs()).toBe(10_000);
    clock.set(20_000);
    expect(clock.nowMs()).toBe(20_000);
  });

  it('starts at the real time by default and goes back to it on reset', () => {
    const before = Date.now();
    const clock = new TestClock();
    expect(clock.nowMs()).toBeGreaterThanOrEqual(before);
    clock.advance(86_400_000);
    clock.reset();
    expect(clock.nowMs()).toBeLessThan(before + 60_000);
  });

  it('hands out a copy of its date, so a caller cannot move it', () => {
    const clock = new TestClock(5_000);
    clock.now().setTime(0);
    expect(clock.nowMs()).toBe(5_000);
  });
});

describe('ManualTimers', () => {
  it('fires a timer only when its delay has passed in virtual time', () => {
    const timers = new ManualTimers();
    const fired: string[] = [];
    timers.setTimeout(() => fired.push('a'), 100);
    expect(timers.pending).toBe(1);
    expect(timers.delays).toEqual([100]);
    timers.advance(99);
    expect(fired).toEqual([]);
    expect(timers.delays).toEqual([1]);
    timers.advance(1);
    expect(fired).toEqual(['a']);
    expect(timers.pending).toBe(0);
  });

  it('runs due timers in order, including one that a timer sets inside the window', () => {
    const timers = new ManualTimers();
    const fired: string[] = [];
    timers.setTimeout(() => fired.push('late'), 300);
    timers.setTimeout(() => {
      fired.push('first');
      timers.setTimeout(() => fired.push('chained'), 100);
    }, 100);
    timers.advance(250);
    expect(fired).toEqual(['first', 'chained']);
    timers.advance(50);
    expect(fired).toEqual(['first', 'chained', 'late']);
  });

  it('does not fire a cleared timer, and ignores handles it does not know', () => {
    const timers = new ManualTimers();
    let ran = false;
    const handle = timers.setTimeout(() => (ran = true), 10);
    timers.clearTimeout(handle);
    timers.clearTimeout(undefined);
    timers.clearTimeout('not a handle');
    timers.advance(1_000);
    expect(ran).toBe(false);
  });

  it('moves a test clock together with the timers, also while a timer runs', () => {
    const clock = new TestClock(1_000_000);
    const timers = new ManualTimers(clock);
    const seen: number[] = [];
    timers.setTimeout(() => seen.push(clock.nowMs()), 400);
    timers.advance(1_000);
    expect(seen).toEqual([1_000_400]);
    expect(clock.nowMs()).toBe(1_001_000);
  });
});
