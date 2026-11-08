// Unit tests of MailTransport (feature 12a, decision 033): it adds the configured sender, passes the message to its driver, answers `verify` for the
// `mail` health check of feature 9, and closes the driver on shutdown.
import { describe, expect, it } from 'bun:test';
import { expectRejection } from '../../../../test/support/rejection';
import { parseEnv } from '../../../config';
import { InMemoryMailDriver } from './mail-driver';
import { MailTransport } from './mail-transport';

const config = parseEnv({ NODE_ENV: 'test', MAIL_FROM: 'GSM Support <help@gsm.example>' });

describe('MailTransport', () => {
  it('sends with the sender from MAIL_FROM', async () => {
    const driver = new InMemoryMailDriver();
    const transport = new MailTransport(driver, config);
    expect(transport.from).toBe('GSM Support <help@gsm.example>');
    await transport.send({ to: 'a@example.com', subject: 'S', text: 'T', messageId: '<1@gsm.example>' });
    expect(driver.sent).toEqual([
      {
        from: 'GSM Support <help@gsm.example>',
        to: 'a@example.com',
        subject: 'S',
        text: 'T',
        messageId: '<1@gsm.example>',
      },
    ]);
  });

  it('verifies the server for the health check, and passes its failure on', async () => {
    const driver = new InMemoryMailDriver();
    const transport = new MailTransport(driver, config);
    expect(await transport.verify()).toBeUndefined();
    driver.verifyError = new Error('Connection refused');
    await expectRejection(transport.verify(), 'Connection refused');
  });

  it('closes the driver on shutdown when it has anything to close', () => {
    let closed = 0;
    const driver = Object.assign(new InMemoryMailDriver(), { close: () => (closed += 1) });
    new MailTransport(driver, config).onApplicationShutdown();
    expect(closed).toBe(1);
    expect(() => new MailTransport(new InMemoryMailDriver(), config).onApplicationShutdown()).not.toThrow();
  });
});
