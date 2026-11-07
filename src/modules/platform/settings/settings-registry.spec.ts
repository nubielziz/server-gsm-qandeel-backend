// Unit tests of the settings allow-list: which keys the generic settings route accepts and how it judges their values.
import { describe, expect, it } from 'bun:test';
import { imeiRetentionDaysProblem, settingsPatchProblems } from './settings-registry';

describe('imeiRetentionDaysProblem', () => {
  it('accepts whole numbers from 0 to 3650', () => {
    for (const value of [0, 1, 90, 3650]) expect(imeiRetentionDaysProblem(value)).toBeUndefined();
  });

  it('refuses anything else', () => {
    for (const value of [-1, 3651, 1.5, '90', null, true, undefined, Number.NaN]) {
      expect(imeiRetentionDaysProblem(value)).toBeString();
    }
  });
});

describe('settingsPatchProblems', () => {
  it('accepts a patch of allowed keys', () => {
    expect(settingsPatchProblems({ imeiRetentionDays: 30 })).toEqual([]);
  });

  it('names every key that is unknown, guarded by another route, or has a bad value', () => {
    const problems = settingsPatchProblems({
      adminAllowlistOnly: true,
      maintenance: { enabled: true },
      madeUpKey: 1,
      imeiRetentionDays: 9999,
    });
    expect(problems.map((problem) => problem.key)).toEqual([
      'adminAllowlistOnly',
      'maintenance',
      'madeUpKey',
      'imeiRetentionDays',
    ]);
  });
});
