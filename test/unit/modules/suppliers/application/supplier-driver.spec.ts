// Unit tests of the Dhru driver with a stand-in HTTP function: how each answer and each failure becomes a call record (outcome, status,
// error) and what is sent, without a network.
import { describe, expect, it } from 'bun:test';
import { HttpRequestError, type HttpResult } from '@src/infra/http';
import {
  type DriverContext,
  type DriverHttp,
  DhruDriver,
  RestDriver,
  SUPPLIER_ANSWER_LIMITS,
  answerTooLargeMessage,
} from '@src/modules/suppliers/application/supplier-driver';

const context: DriverContext = {
  baseUrl: 'https://api.example',
  username: 'gsm-supply',
  apiKey: 'secret-key',
  timeoutMs: 1500,
  paramFormat: 'json',
  policy: {},
};

/** An HTTP stand-in that answers one scripted result and remembers the request it got. */
function http(result: HttpResult | Error): DriverHttp & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    request(options) {
      sent.push(options as unknown as Record<string, unknown>);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

const answer = (body: unknown, status = 200): HttpResult => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    body: new TextEncoder().encode(text),
    durationMs: 12.4,
    text: () => text,
    json: <T>() => JSON.parse(text) as T,
  };
};

describe('DhruDriver', () => {
  it('posts the form to /api/index.php and reads a REFERENCEID, masking the key and the IMEI in the record', async () => {
    const stand = http(answer({ SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 5512 }] }));
    const call = await new DhruDriver(stand).placeOrder(context, {
      remoteServiceId: '4411',
      input: '352905112490861',
      quantity: 2,
      customFields: { AccountUser: 'ali' },
    });
    expect(call).toMatchObject({ ok: true, value: { reference: '5512' } });
    expect(call.record).toMatchObject({
      action: 'placeimeiorder',
      httpStatus: 200,
      durationMs: 12,
      error: '',
      outcome: 'ok',
    });
    expect(JSON.stringify(call.record)).not.toContain('352905112490861');
    expect(JSON.stringify(call.record)).not.toContain('secret-key');
    expect(call.record.request).toMatchObject({
      parameters: { ID: '4411', IMEI: '••••••••0861', QNT: 2, CUSTOMFIELD: { AccountUser: 'ali' } },
    });

    const [request] = stand.sent;
    expect(request).toMatchObject({
      url: 'https://api.example/api/index.php',
      method: 'POST',
      timeoutMs: 1500,
      target: 'supplier',
    });
    const body = request!.body as URLSearchParams;
    const parameters = JSON.parse(Buffer.from(body.get('parameters')!, 'base64').toString('utf8'));
    expect(JSON.parse(Buffer.from(parameters.CUSTOMFIELD, 'base64').toString('utf8'))).toEqual({ AccountUser: 'ali' });
  });

  it('sends a dhru_xml supplier the classic XML string, CUSTOMFIELD as base64 JSON inside it, and says the form in the record', async () => {
    const stand = http(answer({ SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 5513 }] }));
    const call = await new DhruDriver(stand).placeOrder(
      { ...context, paramFormat: 'dhru_xml' },
      { remoteServiceId: '4411', input: 'SERIAL-TEST-0001', quantity: 1, customFields: { Model: 'A&B' } },
    );
    expect(call).toMatchObject({ ok: true, value: { reference: '5513' } });
    const customField = Buffer.from('{"Model":"A&B"}', 'utf8').toString('base64');
    expect((stand.sent[0]!.body as URLSearchParams).get('parameters')).toBe(
      `<PARAMETERS><ID>4411</ID><IMEI>SERIAL-TEST-0001</IMEI><QNT>1</QNT><CUSTOMFIELD>${customField}</CUSTOMFIELD></PARAMETERS>`,
    );
    expect(call.record.request).toEqual({
      action: 'placeimeiorder',
      format: 'dhru_xml',
      parameters: { ID: '4411', IMEI: '••••••••0001', QNT: 1, CUSTOMFIELD: { Model: 'A&B' } },
    });

    const get = http(answer({ ID: '1', ERROR: [{ MESSAGE: 'NoResultFound' }] }));
    const status = await new DhruDriver(get).getOrder({ ...context, paramFormat: 'dhru_xml' }, '1');
    expect((get.sent[0]!.body as URLSearchParams).get('parameters')).toBe('<PARAMETERS><ID>1</ID></PARAMETERS>');
    expect(status).toMatchObject({ ok: false, kind: 'refused', message: 'NoResultFound' });
    expect(status.record).toMatchObject({ request: { format: 'dhru_xml' }, error: 'NoResultFound', outcome: 'error' });
  });

  it('says no form in the record of a call without parameters', async () => {
    const stand = http(answer({ SUCCESS: [{ AccoutInfo: { credit: '1.00' } }] }));
    const call = await new DhruDriver(stand).accountInfo({ ...context, paramFormat: 'dhru_xml' });
    expect(call.record.request).toEqual({ action: 'accountinfo' });
    expect((stand.sent[0]!.body as URLSearchParams).has('parameters')).toBe(false);
  });

  it('is a refusal (outcome error, HTTP 200) when the supplier answers ERROR', async () => {
    const call = await new DhruDriver(http(answer({ ERROR: [{ MESSAGE: 'Not enough credits' }] }))).placeOrder(
      context,
      {
        remoteServiceId: '1',
        input: null,
        quantity: 1,
        customFields: {},
      },
    );
    expect(call).toMatchObject({ ok: false, kind: 'refused', message: 'Not enough credits' });
    expect(call.record).toMatchObject({ httpStatus: 200, error: 'Not enough credits', outcome: 'error' });
  });

  it('is a timeout (outcome timeout, status 0, the time waited) when the HTTP call timed out', async () => {
    const call = await new DhruDriver(http(new HttpRequestError('timeout', 'The request timed out.'))).accountInfo(
      context,
    );
    expect(call).toMatchObject({ ok: false, kind: 'timeout', message: 'Timed out after 1500 ms' });
    expect(call.record).toMatchObject({ httpStatus: 0, error: 'Timed out after 1500 ms', outcome: 'timeout' });
    expect(call.record.durationMs).toBeGreaterThanOrEqual(1);
  });

  it('maps a refused connection, a blocked address, an HTTP error status and a body that is not JSON to failed calls', async () => {
    const network = await new DhruDriver(http(new HttpRequestError('network', 'x'))).accountInfo(context);
    expect(network).toMatchObject({ kind: 'network', message: 'Connection failed' });
    expect(network.record).toMatchObject({ httpStatus: 0, outcome: 'error' });

    const blocked = await new DhruDriver(
      http(new HttpRequestError('blocked', 'The address is not allowed.')),
    ).accountInfo(context);
    expect(blocked).toMatchObject({ kind: 'blocked', message: 'The address is not allowed.' });

    const status = await new DhruDriver(http(answer('down', 502))).accountInfo(context);
    expect(status).toMatchObject({ kind: 'invalid', message: 'The supplier answered HTTP 502.' });
    expect(status.record).toMatchObject({ httpStatus: 502, outcome: 'error' });

    const html = await new DhruDriver(http(answer('<html>maintenance</html>'))).accountInfo(context);
    expect(html).toMatchObject({ kind: 'invalid', message: 'The supplier answer is not JSON.' });
  });

  it('keeps only the count of a service list in the log', async () => {
    const list = {
      SUCCESS: [
        {
          LIST: {
            G: {
              GROUPNAME: 'G',
              GROUPTYPE: 'IMEI',
              SERVICES: { '1': { SERVICEID: 1, SERVICENAME: 'One', CREDIT: '1' } },
            },
          },
        },
      ],
    };
    const call = await new DhruDriver(http(answer(list))).serviceList(context);
    expect(call).toMatchObject({ ok: true, value: { services: [{ remoteId: '1', name: 'One' }], skipped: 0 } });
    expect(call.record.response).toEqual({ services: 1, skipped: 0 });
  });

  it('reads each answer up to its limit', async () => {
    const calls: Array<[string, (driver: DhruDriver, stand: DriverHttp) => Promise<unknown>]> = [
      ['accountinfo', (driver) => driver.accountInfo(context)],
      ['imeiservicelist', (driver) => driver.serviceList(context)],
      [
        'placeimeiorder',
        (driver) => driver.placeOrder(context, { remoteServiceId: '1', input: null, quantity: 1, customFields: {} }),
      ],
      ['getimeiorder', (driver) => driver.getOrder(context, '1')],
    ];
    const seen: Record<string, unknown> = {};
    for (const [action, run] of calls) {
      const stand = http(answer({ SUCCESS: [{}] }));
      await run(new DhruDriver(stand), stand);
      seen[action] = stand.sent[0]?.maxResponseBytes;
    }
    expect(seen).toEqual({
      accountinfo: 262_144,
      imeiservicelist: 16_777_216,
      placeimeiorder: 262_144,
      getimeiorder: 262_144,
    });
    expect(SUPPLIER_ANSWER_LIMITS.imeiservicelist).toBe(16 * 1024 * 1024);
  });

  it('turns an answer over the limit into an unusable answer that names the limit', async () => {
    const stand = http(new HttpRequestError('too_large', 'The response is larger than 262144 bytes.'));
    const call = await new DhruDriver(stand).getOrder(context, '1');
    expect(call).toMatchObject({
      ok: false,
      kind: 'invalid',
      message: "The supplier's answer is larger than 256 KiB; it was not read.",
    });
    expect(call.record).toMatchObject({ outcome: 'error', httpStatus: 0, response: null });
    expect(answerTooLargeMessage(16 * 1024 * 1024)).toBe(
      "The supplier's answer is larger than 16384 KiB; it was not read.",
    );
  });

  it('keeps no NUL and no lone surrogate anywhere in what a call returns or records', async () => {
    const poisoned = JSON.stringify({
      ERROR: [{ MESSAGE: 'refused\u0000 for \ud800 reasons', extra: 'a\u0000b\ud800', ['k\u0000ey']: 1 }],
    });
    const refused = await new DhruDriver(http(answer(poisoned))).getOrder(context, '1');
    const accepted = await new DhruDriver(
      http(answer(JSON.stringify({ SUCCESS: [{ STATUS: 4, CODE: 'done\u0000\ud800', extra: 'x\u0000' }] }))),
    ).getOrder(context, '1');
    for (const call of [refused, accepted]) {
      const text = JSON.stringify([call, call.record]);
      expect(text).not.toContain('\\u0000');
      expect(text.toLowerCase()).not.toContain('\\ud800');
    }
    expect(refused).toMatchObject({ ok: false, message: 'refused for  reasons' });
    expect(accepted).toMatchObject({ ok: true, value: { state: 'completed', code: 'done' } });
  });

  it('refuses an answer without a REFERENCEID or a STATUS as unusable', async () => {
    const noReference = await new DhruDriver(http(answer({ SUCCESS: [{ MESSAGE: 'ok' }] }))).placeOrder(context, {
      remoteServiceId: '1',
      input: null,
      quantity: 1,
      customFields: {},
    });
    expect(noReference).toMatchObject({ ok: false, kind: 'invalid' });
    const noStatus = await new DhruDriver(http(answer({ SUCCESS: [{ MESSAGE: 'ok' }] }))).getOrder(context, '1');
    expect(noStatus).toMatchObject({ ok: false, kind: 'invalid' });
  });
});

describe('RestDriver', () => {
  it('refuses every call with a clear message until a REST supplier exists', async () => {
    const rest = new RestDriver();
    for (const call of [
      await rest.accountInfo(context),
      await rest.serviceList(context),
      await rest.getOrder(context),
      await rest.placeOrder(context),
    ]) {
      expect(call).toMatchObject({
        ok: false,
        kind: 'unsupported',
        message: expect.stringContaining('REST suppliers are not supported yet'),
      });
      expect(call.record).toMatchObject({ httpStatus: 0, outcome: 'error' });
    }
  });
});
