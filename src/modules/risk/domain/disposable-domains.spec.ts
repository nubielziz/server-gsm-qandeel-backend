// Unit tests of the disposable mailbox list (feature 18).
import { describe, expect, it } from 'bun:test';
import { isDisposableEmail } from './disposable-domains';

describe('isDisposableEmail', () => {
  it('recognises a listed provider and its subdomains, in any case', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
    expect(isDisposableEmail('X@MAILINATOR.COM')).toBe(true);
    expect(isDisposableEmail('x@box.yopmail.com')).toBe(true);
  });

  it('does not flag an ordinary or look-alike domain', () => {
    expect(isDisposableEmail('x@gmail.com')).toBe(false);
    expect(isDisposableEmail('x@notmailinator.com')).toBe(false);
    expect(isDisposableEmail('no-at-sign')).toBe(false);
    expect(isDisposableEmail('')).toBe(false);
  });
});
