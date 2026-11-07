// Unit tests of the development mail sender's redaction: a log line shows which mail, never the whole address.
import { describe, expect, it } from 'bun:test';
import { redactEmail } from './log-mail-sender';

describe('redactEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(redactEmail('ali.hassan@example.com')).toBe('a***@example.com');
    expect(redactEmail('x@y.io')).toBe('x***@y.io');
  });

  it('hides everything when the text is not an address', () => {
    expect(redactEmail('no-at-sign')).toBe('***');
    expect(redactEmail('@example.com')).toBe('***');
    expect(redactEmail('')).toBe('***');
  });
});
