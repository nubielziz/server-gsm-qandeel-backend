// Unit tests of the stored webhook keys (feature 24C): the legacy single key and the list of one or two keys share one column.
import { describe, expect, it } from 'bun:test';
import { webhookSecretsOf } from './gateway-credentials';

describe('webhookSecretsOf', () => {
  it('reads a legacy plain key as one key', () => {
    expect(webhookSecretsOf('whsec_legacy')).toEqual(['whsec_legacy']);
    expect(webhookSecretsOf('')).toEqual([]);
  });

  it('reads a list of one or two keys', () => {
    expect(webhookSecretsOf('["whsec_a"]')).toEqual(['whsec_a']);
    expect(webhookSecretsOf('["whsec_a","whsec_b"]')).toEqual(['whsec_a', 'whsec_b']);
  });

  it('reads anything else that decrypts as one key', () => {
    for (const odd of ['[', '[]', '["a","b","c"]', '[1]', '[""]', '["a",2]', '{"a":1}']) {
      expect(webhookSecretsOf(odd)).toEqual([odd]);
    }
  });
});
