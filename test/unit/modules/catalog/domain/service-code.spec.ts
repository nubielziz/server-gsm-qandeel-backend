// Unit tests of the code the server makes for a new service (decision 074): the prefix by type, the format and the suffix tries.
import { describe, expect, it } from 'bun:test';
import { SERVICE_TYPES } from '@src/modules/catalog/db/schema';
import { SERVICE_CODE_PREFIX, codeAttempt, madeServiceCode } from '@src/modules/catalog/domain/service-code';

describe('SERVICE_CODE_PREFIX', () => {
  it('has one prefix for each of the four service types', () => {
    expect(Object.keys(SERVICE_CODE_PREFIX).sort()).toEqual([...SERVICE_TYPES].sort());
    expect(SERVICE_CODE_PREFIX).toEqual({ imei: 'IMEI', server: 'SRV', remote: 'RMT', file: 'FILE' });
  });

  it('keeps the prefixes apart, and apart from the importer family IMP', () => {
    const prefixes = Object.values(SERVICE_CODE_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes).not.toContain('IMP');
  });
});

describe('madeServiceCode', () => {
  it('is the prefix of the type, a hyphen and the id of the service', () => {
    expect(madeServiceCode('imei', 1042)).toBe('IMEI-1042');
    expect(madeServiceCode('server', 7)).toBe('SRV-7');
    expect(madeServiceCode('remote', 31)).toBe('RMT-31');
    expect(madeServiceCode('file', 5)).toBe('FILE-5');
  });

  it('makes a different code for every id, so two services never make the same one', () => {
    const codes = new Set([1, 2, 3, 10, 11, 100].map((id) => madeServiceCode('imei', id)));
    expect(codes.size).toBe(6);
  });

  it('fits the 40 characters of a code for any id the column can hold', () => {
    expect(madeServiceCode('file', Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(40);
    expect(madeServiceCode('file', Number.MAX_SAFE_INTEGER).length + '-99'.length).toBeLessThanOrEqual(40);
  });
});

describe('codeAttempt', () => {
  it('is the base itself first, then base-2, base-3, ...', () => {
    expect(codeAttempt('IMEI-9', 1)).toBe('IMEI-9');
    expect(codeAttempt('IMEI-9', 2)).toBe('IMEI-9-2');
    expect(codeAttempt('IMEI-9', 3)).toBe('IMEI-9-3');
    expect(codeAttempt('IMP-55', 10)).toBe('IMP-55-10');
  });

  it('counts a number below 1 as the first try', () => {
    expect(codeAttempt('IMEI-9', 0)).toBe('IMEI-9');
    expect(codeAttempt('IMEI-9', -4)).toBe('IMEI-9');
  });
});
