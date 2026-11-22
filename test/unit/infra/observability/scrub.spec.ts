// Unit tests of the Sentry scrubbing rules (decision 015, feature 24D): what may leave the process, and what may not.
import { describe, expect, it } from 'bun:test';
import { type ScrubbableEvent, scrubEvent, scrubText } from '@src/infra/observability/scrub';
import { DB_FAILURE_MARKER } from '../../../support/db-failure';

describe('scrubText', () => {
  it('masks e-mail addresses like the log serializers do', () => {
    expect(scrubText('duplicate key (email)=(rania.saleh@example.com) already exists')).toBe(
      'duplicate key (email)=(r***@example.com) already exists',
    );
    expect(scrubText('from a.b+c@mail.gsm-supply.example to x@y.io')).toBe(
      'from a***@mail.gsm-supply.example to x***@y.io',
    );
  });

  it('masks runs of 12 to 19 digits (IMEI, card-like numbers), also in groups, keeping the last four', () => {
    expect(scrubText('imei 356938035643809 not found')).toBe('imei ***3809 not found');
    expect(scrubText('card 4111 1111 1111 1111 refused')).toBe('card ***1111 refused');
    expect(scrubText('card 4111-1111-1111-1111')).toBe('card ***1111');
    expect(scrubText('account 1234567890123456789')).toBe('account ***6789');
  });

  it('leaves short numbers, order ids and ordinary text alone', () => {
    const text = 'order 48213 for client 7 failed after 3 attempts (HTTP 502)';
    expect(scrubText(text)).toBe(text);
    expect(scrubText('11 digits 12345678901 stay')).toBe('11 digits 12345678901 stay');
  });

  it('cuts a very long message', () => {
    const cut = scrubText('x'.repeat(5000));
    expect(cut.length).toBe(1003);
    expect(cut.endsWith('...')).toBe(true);
  });

  it('removes statement text', () => {
    const text = scrubText(`save failed: Failed query: insert into "x" values ($1)\nparams: ${DB_FAILURE_MARKER}`);
    expect(text).toBe('save failed: [database statement removed]');
  });

  it('masks an address cut by the limit', () => {
    const text = `${'a '.repeat(495)}name@example.com tail`;
    const scrubbed = scrubText(text);
    expect(scrubbed).not.toContain('name@');
    expect(scrubbed).toContain('n***@examp');
  });

  it('bounds its work whatever the input', () => {
    for (const text of ['a'.repeat(400_000), `${'a.'.repeat(200_000)}@x.io`, '1 '.repeat(200_000)]) {
      const started = performance.now();
      const scrubbed = scrubText(text);
      expect(scrubbed.length).toBeLessThanOrEqual(1003);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});

describe('scrubEvent', () => {
  const event = (): ScrubbableEvent & { tags: Record<string, string>; exception: { values: { value: string }[] } } => ({
    message: 'failed for a@b.com',
    request: {
      headers: { cookie: 'session=secret', authorization: 'Bearer abc' },
      data: { password: 'x' },
      query_string: 'imei=1',
    },
    user: { id: 5, email: 'a@b.com', ip_address: '1.2.3.4' },
    breadcrumbs: [{ message: 'clicked' }],
    extra: { body: { phone: '+962791234567' } },
    server_name: 'gsm-host-1',
    modules: { zod: '4.6.7' },
    exception: { values: [{ value: 'IMEI 356938035643809 / rania@example.com' }] },
    logentry: { message: 'param a@b.com', params: ['a@b.com'] },
    contexts: { runtime: { name: 'bun' }, trace: { trace_id: 't' }, device: { name: 'x' }, os: { name: 'linux' } },
    tags: { process: 'api', route: '/admin/orders/:id', request_id: 'req-1' },
  });

  it('removes request, user, breadcrumbs, extra data, host name and modules', () => {
    const scrubbed = scrubEvent(event());
    for (const key of ['request', 'user', 'breadcrumbs', 'extra', 'server_name', 'modules'] as const) {
      expect(scrubbed[key], key).toBeUndefined();
    }
  });

  it('masks messages and exception values, and drops log parameters', () => {
    const scrubbed = scrubEvent(event());
    expect(scrubbed.message).toBe('failed for a***@b.com');
    expect(scrubbed.exception.values[0]?.value).toBe('IMEI ***3809 / r***@example.com');
    expect(scrubbed.logentry).toEqual({ message: 'param a***@b.com' });
  });

  it('keeps the tags and only the runtime and trace contexts', () => {
    const scrubbed = scrubEvent(event());
    expect(scrubbed.tags).toEqual({ process: 'api', route: '/admin/orders/:id', request_id: 'req-1' });
    expect(Object.keys(scrubbed.contexts ?? {}).sort()).toEqual(['runtime', 'trace']);
  });

  it('accepts an event that has none of these parts', () => {
    expect(scrubEvent({})).toEqual({});
  });
});
