// Unit tests of the Dhru client protocol: the request body, the endpoint, each answer's reading and the redaction of stored bodies.
import { describe, expect, it } from 'bun:test';
import {
  amountText,
  dhruEndpoint,
  dhruRequestBody,
  parseDhruAnswer,
  readAccountInfo,
  readOrderStatus,
  readPlacedOrder,
  readServiceList,
  redactBody,
} from './dhru-protocol';

describe('dhruEndpoint', () => {
  it('appends the standard path to a bare base URL and keeps a .php address as it is', () => {
    expect(dhruEndpoint('https://api.nordicgsm.example')).toBe('https://api.nordicgsm.example/api/index.php');
    expect(dhruEndpoint('https://host.example///')).toBe('https://host.example/api/index.php');
    expect(dhruEndpoint('https://host.example/custom/dhru.php')).toBe('https://host.example/custom/dhru.php');
  });
});

describe('dhruRequestBody', () => {
  it('sends the credentials, the action, JSON format and the parameters as base64 JSON (decision 026)', () => {
    const body = dhruRequestBody({
      username: 'gsm-supply',
      apiKey: 'key-1',
      action: 'placeimeiorder',
      parameters: { ID: '4411', IMEI: '352905112490861' },
    });
    expect(body.get('username')).toBe('gsm-supply');
    expect(body.get('apiaccesskey')).toBe('key-1');
    expect(body.get('action')).toBe('placeimeiorder');
    expect(body.get('requestformat')).toBe('JSON');
    expect(JSON.parse(Buffer.from(body.get('parameters')!, 'base64').toString('utf8'))).toEqual({
      ID: '4411',
      IMEI: '352905112490861',
    });
  });

  it('leaves the parameters out of an action that takes none', () => {
    expect(dhruRequestBody({ username: 'u', apiKey: 'k', action: 'accountinfo' }).has('parameters')).toBe(false);
  });
});

describe('parseDhruAnswer', () => {
  it('reads the first SUCCESS entry, an ERROR message, and refuses anything else', () => {
    expect(parseDhruAnswer({ SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 7 }] })).toEqual({
      kind: 'success',
      payload: { MESSAGE: 'Order received', REFERENCEID: 7 },
    });
    expect(parseDhruAnswer({ ERROR: [{ MESSAGE: 'Not enough credits' }] })).toEqual({
      kind: 'error',
      message: 'Not enough credits',
    });
    expect(parseDhruAnswer({ ERROR: [{ MESSAGE: 'x' }], SUCCESS: [{}] }).kind).toBe('error');
    expect(parseDhruAnswer({ something: 1 }).kind).toBe('invalid');
    expect(parseDhruAnswer('nope').kind).toBe('invalid');
    expect(parseDhruAnswer(null).kind).toBe('invalid');
  });
});

describe('amountText', () => {
  it('reads numbers and decorated text as 4 decimals rounded half up', () => {
    expect(amountText('120.5')).toBe('120.5000');
    expect(amountText('$1,200.50')).toBe('1200.5000');
    expect(amountText(3)).toBe('3.0000');
    expect(amountText('0.00005')).toBe('0.0001');
    expect(amountText('abc')).toBeUndefined();
    expect(amountText(undefined)).toBeUndefined();
  });
});

describe('readAccountInfo', () => {
  it('reads the credit, currency and mail from the standard (misspelled) key', () => {
    expect(
      readAccountInfo({
        message: 'Your Accout Info',
        AccoutInfo: { credit: '1240.5', mail: 'a@b.c', currency: 'USD' },
      }),
    ).toEqual({
      ok: true,
      value: { credit: '1240.5000', currency: 'USD', mail: 'a@b.c' },
    });
    expect(readAccountInfo({ AccountInfo: { credit: '5' } })).toMatchObject({ ok: true });
  });

  it('refuses an answer without a readable credit', () => {
    expect(readAccountInfo({ AccoutInfo: { mail: 'x' } }).ok).toBe(false);
    expect(readAccountInfo({}).ok).toBe(false);
  });
});

describe('readServiceList', () => {
  const payload = {
    MESSAGE: 'IMEI Service List',
    LIST: {
      'Server tools': {
        GROUPNAME: 'Server tools',
        GROUPTYPE: 'SERVER',
        SERVICES: {
          '4411': {
            SERVICEID: 4411,
            SERVICENAME: 'Chimera 1 month',
            CREDIT: '19.8',
            TIME: 'Instant',
            'Requires.Network': 'None',
            'Requires.Custom': [{ fieldname: 'username', fieldtype: 'text', required: '1' }],
          },
          '4412': { SERVICEID: '4412', SERVICENAME: '', CREDIT: '1' },
          '4413': { SERVICEID: '4413', SERVICENAME: 'No price' },
        },
      },
      Checks: {
        GROUPNAME: 'Checks',
        GROUPTYPE: 'IMEI',
        SERVICES: {
          '9': { SERVICEID: '4411', SERVICENAME: 'Same id again', CREDIT: '2' },
          '10': { SERVICEID: '10', SERVICENAME: 'Carrier check', CREDIT: '0.5' },
        },
      },
    },
  };

  it('normalises the services of every group and drops the ones without an id, a name or a price', () => {
    const services = readServiceList(payload);
    expect(services.map((service) => service.remoteId)).toEqual(['4411', '10']);
    expect(services[0]).toMatchObject({
      group: 'Server tools',
      type: 'SERVER',
      name: 'Chimera 1 month',
      credit: '19.8000',
      time: 'Instant',
      requires: { Network: 'None' },
      customFields: [{ fieldname: 'username', fieldtype: 'text', required: '1' }],
    });
    expect(services[1]).toMatchObject({ group: 'Checks', type: 'IMEI', credit: '0.5000', time: '' });
  });

  it('answers an empty list for a payload without LIST', () => {
    expect(readServiceList({})).toEqual([]);
  });
});

describe('readPlacedOrder and readOrderStatus', () => {
  it('reads the REFERENCEID as text', () => {
    expect(readPlacedOrder({ REFERENCEID: 88121 })).toBe('88121');
    expect(readPlacedOrder({ REFERENCEID: ' ' })).toBeUndefined();
  });

  it('maps STATUS 4 to completed, 3 to rejected, 0, 1 and 2 to running and keeps the CODE', () => {
    expect(readOrderStatus({ STATUS: 4, CODE: 'Unlocked' })).toEqual({ state: 'completed', code: 'Unlocked' });
    expect(readOrderStatus({ STATUS: '3', CODE: 'IMEI not supported' })).toEqual({
      state: 'rejected',
      code: 'IMEI not supported',
    });
    for (const status of [0, 1, 2])
      expect(readOrderStatus({ STATUS: status })).toEqual({ state: 'running', code: null });
    expect(readOrderStatus({ STATUS: 9 })).toBeUndefined();
    expect(readOrderStatus({})).toBeUndefined();
  });
});

describe('redactBody', () => {
  it('masks credentials, keeps only the last four characters of an IMEI and leaves the rest', () => {
    const redacted = redactBody({
      action: 'placeimeiorder',
      apiaccesskey: 'secret-key',
      parameters: { ID: '4411', IMEI: '352905112490861', CUSTOMFIELD: { password: 'hunter2', username: 'ali' } },
    });
    expect(redacted).toEqual({
      action: 'placeimeiorder',
      apiaccesskey: '••••••••',
      parameters: { ID: '4411', IMEI: '••••••••0861', CUSTOMFIELD: { password: '••••••••', username: 'ali' } },
    });
  });

  it('replaces a body that is too large by a note', () => {
    expect(redactBody({ data: 'x'.repeat(30_000) })).toMatchObject({ truncated: true });
  });
});
