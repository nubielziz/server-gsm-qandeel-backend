import { describe, expect, it } from 'bun:test';
import { Registry } from 'prom-client';
import { SystemClock } from '../../../../common/clock';
import { parseEnv } from '../../../../config';
import {
  SearchCircuit,
  SearchMetrics,
  SearchNotReady,
  SearchRejected,
  SearchUnavailable,
  type TypesenseClient,
} from '../../../../infra/search';
import { SearchEngine, reasonOf } from './search-engine';

function engine(env: Record<string, string> = {}) {
  const config = parseEnv({ NODE_ENV: 'test', SEARCH_ENABLED_TEST: 'true', ...env });
  const metrics = new SearchMetrics(new Registry());
  const circuit = new SearchCircuit(new SystemClock());
  return { search: new SearchEngine({} as TypesenseClient, circuit, metrics, config), metrics, circuit };
}

const value = async (
  counter: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> },
  label?: [string, string],
) =>
  (await counter.get()).values
    .filter((v) => (label ? v.labels[label[0]] === label[1] : true))
    .reduce((sum, v) => sum + v.value, 0);

describe('reasonOf', () => {
  it('names the three reasons the metric tells apart', () => {
    expect(reasonOf(new SearchNotReady('x'))).toBe('not_ready');
    expect(reasonOf(new SearchUnavailable('timeout', 'x'))).toBe('timeout');
    expect(reasonOf(new SearchUnavailable('network', 'x'))).toBe('error');
    expect(reasonOf(new SearchRejected(400, 'x'))).toBe('error');
    expect(reasonOf(new Error('x'))).toBe('error');
  });
});

describe('SearchEngine.run', () => {
  it('answers the engine value and counts the request', async () => {
    const { search, metrics } = engine();
    const outcome = await search.run(
      'suggest',
      () => Promise.resolve(7),
      () => Promise.resolve(0),
    );
    expect(outcome).toEqual({ engine: 'typesense', value: 7 });
    expect(await value(metrics.requests, ['engine', 'typesense'])).toBe(1);
  });

  it('passes the suggest timeout to a suggest call and the results timeout to the others', async () => {
    const { search } = engine({ SEARCH_SUGGEST_TIMEOUT_MS: '300', SEARCH_TIMEOUT_MS: '900' });
    const seen: number[] = [];
    await search.run(
      'suggest',
      (_client, timeout) => Promise.resolve(seen.push(timeout)),
      () => Promise.resolve(0),
    );
    await search.run(
      'results',
      (_client, timeout) => Promise.resolve(seen.push(timeout)),
      () => Promise.resolve(0),
    );
    expect(seen).toEqual([300, 900]);
  });

  it('answers the fallback, with its reason, when the call fails, and never throws the engine error', async () => {
    const { search, metrics } = engine();
    const timeout = await search.run(
      'results',
      () => Promise.reject(new SearchUnavailable('timeout', 'slow')),
      (reason) => Promise.resolve(reason),
    );
    expect(timeout).toEqual({ engine: 'fallback', value: 'timeout', reason: 'timeout' });
    const missing = await search.run(
      'results',
      () => Promise.reject(new SearchNotReady('no alias')),
      (reason) => Promise.resolve(reason),
    );
    expect(missing).toMatchObject({ engine: 'fallback', reason: 'not_ready' });
    expect(await value(metrics.fallbacks, ['reason', 'not_ready'])).toBe(1);
    expect(await value(metrics.requests, ['engine', 'fallback'])).toBe(2);
  });

  it('falls back on a refusal of our own request without counting it against the engine', async () => {
    const { search, circuit, metrics } = engine();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const outcome = await search.run(
        'results',
        () => Promise.reject(new SearchRejected(400, 'bad parameter')),
        (reason) => Promise.resolve(reason),
      );
      expect(outcome).toEqual({ engine: 'fallback', value: 'error', reason: 'error' });
    }
    expect(circuit.state()).toBe('closed');
    expect(circuit.allow()).toBe(true);
    expect(await value(metrics.fallbacks, ['reason', 'error'])).toBe(5);
    // The engine's own failures still count: three timeouts open it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await search.run(
        'results',
        () => Promise.reject(new SearchUnavailable('timeout', 'slow')),
        () => Promise.resolve(0),
      );
    }
    expect(circuit.state()).toBe('open');
  });

  it('does not call the engine while the circuit is open, nor when search is off', async () => {
    const { search, circuit, metrics } = engine();
    circuit.failed(new SearchUnavailable('server', 'down'));
    let called = false;
    const open = await search.run(
      'suggest',
      () => ((called = true), Promise.resolve(1)),
      () => Promise.resolve(0),
    );
    expect(open).toMatchObject({ engine: 'fallback', reason: 'circuit_open' });
    expect(called).toBe(false);
    const off = engine({ SEARCH_ENABLED_TEST: 'false' });
    const disabled = await off.search.run(
      'suggest',
      () => ((called = true), Promise.resolve(1)),
      () => Promise.resolve(0),
    );
    expect(disabled).toMatchObject({ engine: 'fallback', reason: 'disabled' });
    expect(called).toBe(false);
    expect(await value(off.metrics.fallbacks, ['reason', 'disabled'])).toBe(1);
    expect(await value(metrics.fallbacks, ['reason', 'circuit_open'])).toBe(1);
  });

  it('closes the circuit again after a call that works', async () => {
    const { search, circuit } = engine();
    await search.run(
      'suggest',
      () => Promise.reject(new SearchUnavailable('network', 'x')),
      () => Promise.resolve(0),
    );
    expect(circuit.state()).toBe('closed');
    await search.run(
      'suggest',
      () => Promise.resolve(1),
      () => Promise.resolve(0),
    );
    expect(circuit.state()).toBe('closed');
  });
});
