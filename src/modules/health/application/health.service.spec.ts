// Unit tests for the health status rule (decision 015): critical down = down, only non-critical down = degraded.
import { describe, expect, it } from 'bun:test';
import { foldStatus } from './health.service';

const result = (critical: boolean, up: boolean) => ({ indicator: { critical }, up });

describe('foldStatus', () => {
  it('is ok with no indicators or all up', () => {
    expect(foldStatus([])).toBe('ok');
    expect(foldStatus([result(true, true), result(false, true)])).toBe('ok');
  });

  it('is degraded when only non-critical indicators are down', () => {
    expect(foldStatus([result(true, true), result(false, false)])).toBe('degraded');
    expect(foldStatus([result(false, false), result(false, false)])).toBe('degraded');
  });

  it('is down when any critical indicator is down', () => {
    expect(foldStatus([result(true, false)])).toBe('down');
    expect(foldStatus([result(true, false), result(false, false)])).toBe('down');
    expect(foldStatus([result(false, true), result(true, false)])).toBe('down');
  });
});
