// The fixed sentences of the customer's security notice (decision 047): one per staff action, each completing the template's
// "Our support team made this change to your account: {{change}}." and none carrying a secret.
import { describe, expect, it } from 'bun:test';
import { CUSTOMER_SECURITY_NOTICE_PHRASES } from '@src/modules/customers/application/mail/customer-security-notices';

describe('CUSTOMER_SECURITY_NOTICE_PHRASES', () => {
  const phrases = Object.entries(CUSTOMER_SECURITY_NOTICE_PHRASES);

  it('has a sentence for the email change, the temporary password and the account made with one', () => {
    expect(Object.keys(CUSTOMER_SECURITY_NOTICE_PHRASES).sort()).toEqual([
      'account_created_with_temporary_password',
      'email_changed',
      'temporary_password',
    ]);
  });

  it('has a different sentence for each case', () => {
    expect(new Set(phrases.map(([, text]) => text)).size).toBe(phrases.length);
  });

  it.each(phrases)(
    '%s completes the template sentence: lower case start, no final stop, no placeholder',
    (_kind, text) => {
      expect(text).toMatch(/^[a-z]/);
      expect(text.endsWith('.')).toBe(false);
      expect(text).not.toContain('{{');
    },
  );
});
