// Unit tests of the search circuit breaker (feature 29, plan section 3.4) on a TestClock: what opens it at once, the threshold, the
// half-open probe.
import { describe, expect, it } from 'bun:test';
import { TestClock } from '../../../test/support/clock';
import { SearchCircuit } from './search-circuit';
import { SearchNotReady, SearchRejected, SearchUnavailable } from './search-errors';

const clock = () => new TestClock('2026-11-16T10:00:00.000Z');

describe('SearchCircuit', () => {
  it('opens at once on a 5xx, a refused key, a node out of resources and a missing alias', () => {
    for (const error of [
      new SearchUnavailable('server', 'x'),
      new SearchUnavailable('auth', 'x'),
      new SearchUnavailable('resources', 'x'),
      new SearchNotReady('x'),
    ]) {
      const circuit = new SearchCircuit(clock());
      circuit.failed(error);
      expect(circuit.state(), error.message).toBe('open');
      expect(circuit.allow()).toBe(false);
    }
  });

  it('opens after 3 other failures within 30 s, and forgets older ones', () => {
    const time = clock();
    const circuit = new SearchCircuit(time);
    circuit.failed(new SearchUnavailable('timeout', 'x'));
    circuit.failed(new SearchRejected(400, 'x'));
    time.advance(31_000);
    circuit.failed(new SearchUnavailable('network', 'x'));
    expect(circuit.state()).toBe('closed');
    circuit.failed(new SearchUnavailable('timeout', 'x'));
    circuit.failed(new Error('malformed'));
    expect(circuit.state()).toBe('open');
  });

  it('lets one probe through after 15 s: success closes it, failure opens it again', () => {
    const time = clock();
    const circuit = new SearchCircuit(time);
    circuit.failed(new SearchUnavailable('server', 'x'));
    time.advance(14_999);
    expect(circuit.allow()).toBe(false);
    time.advance(1);
    expect(circuit.state()).toBe('half_open');
    expect(circuit.allow()).toBe(true);
    expect(circuit.allow()).toBe(false);
    circuit.failed(new SearchUnavailable('timeout', 'x'));
    expect(circuit.state()).toBe('open');
    time.advance(15_000);
    expect(circuit.allow()).toBe(true);
    circuit.succeeded();
    expect(circuit.state()).toBe('closed');
    expect(circuit.allow()).toBe(true);
  });

  it('replaces a probe that never reported back', () => {
    const time = clock();
    const circuit = new SearchCircuit(time);
    circuit.failed(new SearchNotReady('x'));
    time.advance(15_000);
    expect(circuit.allow()).toBe(true);
    time.advance(15_000);
    expect(circuit.allow()).toBe(true);
  });
});
