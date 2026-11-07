// Unit tests of the save-time check of a webhook address (decision 023, B156), with a stand-in DNS resolver.
import { describe, expect, it } from 'bun:test';
import { webhookUrlProblem } from './webhook-url';

const publicDns = () => Promise.resolve(['93.184.216.34']);
const privateDns = () => Promise.resolve(['10.0.0.5']);
const noDns = () => Promise.reject(new Error('NXDOMAIN'));

describe('webhookUrlProblem', () => {
  it('accepts an https address on a public host', async () => {
    expect(await webhookUrlProblem('https://hooks.example.com/gsm?token=1', publicDns)).toBeUndefined();
  });

  it('accepts a public IP literal without a lookup', async () => {
    expect(await webhookUrlProblem('https://93.184.216.34/gsm', noDns)).toBeUndefined();
  });

  it('refuses plain http, whatever the environment', async () => {
    expect(await webhookUrlProblem('http://hooks.example.com/gsm', publicDns)).toContain('https://');
  });

  it('refuses text that is not an address', async () => {
    expect(await webhookUrlProblem('hooks.example.com', publicDns)).toContain('full address');
  });

  it('refuses credentials in the address', async () => {
    expect(await webhookUrlProblem('https://user:pw@hooks.example.com/', publicDns)).toContain('user name');
  });

  it('refuses a host that resolves to a private network, and private IP literals', async () => {
    expect(await webhookUrlProblem('https://hooks.example.com/', privateDns)).toContain('public host');
    for (const literal of [
      'https://127.0.0.1/',
      'https://10.1.2.3/',
      'https://169.254.169.254/latest',
      'https://[::1]/',
    ]) {
      expect(await webhookUrlProblem(literal, publicDns), literal).toContain('public host');
    }
  });

  it('refuses a host that does not resolve', async () => {
    expect(await webhookUrlProblem('https://nowhere.example.com/', noDns)).toContain('could not find');
  });
});
