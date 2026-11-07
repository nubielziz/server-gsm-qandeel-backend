// Unit tests of the verification rules: the documents a merchant submits and the note of a staff decision.
import { describe, expect, it } from 'bun:test';
import { MAX_DECISION_NOTE, checkDecisionNote, checkFileIds } from './kyc-rules';

describe('checkFileIds', () => {
  it('wants one to five distinct documents', () => {
    expect(checkFileIds([1])).toEqual([]);
    expect(checkFileIds([1, 2, 3, 4, 5])).toEqual([]);
    expect(checkFileIds([]).map((error) => error.code)).toEqual(['required']);
    expect(checkFileIds([1, 2, 3, 4, 5, 6]).map((error) => error.code)).toEqual(['max']);
    expect(checkFileIds([1, 2, 1]).map((error) => error.code)).toEqual(['duplicate']);
    expect(checkFileIds([]).every((error) => error.field === 'fileIds')).toBe(true);
  });
});

describe('checkDecisionNote', () => {
  it('requires a note for a rejection and bounds every note', () => {
    expect(checkDecisionNote('approve', '')).toBeUndefined();
    expect(checkDecisionNote('approve', 'Documents match.')).toBeUndefined();
    expect(checkDecisionNote('reject', '')?.code).toBe('required');
    expect(checkDecisionNote('reject', 'Blurry passport')).toBeUndefined();
    expect(checkDecisionNote('approve', 'x'.repeat(MAX_DECISION_NOTE + 1))?.code).toBe('length');
    expect(checkDecisionNote('approve', 'x'.repeat(MAX_DECISION_NOTE))).toBeUndefined();
  });
});
