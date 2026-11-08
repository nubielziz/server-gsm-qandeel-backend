// Unit tests of the mail check of the System health page (feature 12a): ok when the server answers, down without details otherwise.
import { describe, expect, it } from 'bun:test';
import { MAIL_PROBE_TOKEN, MailHealthProbe } from './mail-health-probe';
import type { MailTransport } from './mail-transport';

const transport = (verify: () => Promise<void>): MailTransport => ({ verify }) as unknown as MailTransport;

describe('MailHealthProbe', () => {
  it('reports ok when the mail server answers', async () => {
    expect(await new MailHealthProbe(transport(() => Promise.resolve())).check()).toEqual({ status: 'ok' });
  });

  it('reports down without the server address or the error text when it does not', async () => {
    const probe = new MailHealthProbe(
      transport(() => Promise.reject(new Error('connect ECONNREFUSED smtp.secret.example:465 user:pw'))),
    );
    const result = await probe.check();
    expect(result).toEqual({ status: 'down', detail: 'The mail server did not answer.' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('uses the token the health module injects', () => {
    expect(MAIL_PROBE_TOKEN as symbol).toBe(Symbol.for('gsm.MAIL_PROBE'));
  });
});
