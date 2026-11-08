// Unit tests of the document label of a consent record.
import { describe, expect, it } from 'bun:test';
import { documentLabel } from './consent-documents';

describe('documentLabel', () => {
  it('writes the label of the type and the version', () => {
    expect(documentLabel('terms', '3.2')).toBe('Terms of service v3.2');
    expect(documentLabel('privacy', '2.0')).toBe('Privacy policy v2.0');
    expect(documentLabel('refund', '1.1')).toBe('Refund policy v1.1');
    expect(documentLabel('cookies', '1.0')).toBe('Cookie policy v1.0');
  });

  it('is null when the consent has no document, and keeps an unknown type as it is', () => {
    expect(documentLabel(null, null)).toBeNull();
    expect(documentLabel('terms', null)).toBeNull();
    expect(documentLabel('imprint', '1')).toBe('imprint v1');
  });
});
