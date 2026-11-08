// Unit tests of the four supplier call contracts (decision 026): they are registered under the manifest keys, their examples and the
// answers of the fake supplier pass them, a malformed answer is refused, and the readers of dhru-protocol agree with them.
import { describe, expect, it } from 'bun:test';
import { supplierCallRegistry } from '../../../common/contract';
import {
  DHRU_ACTIONS,
  parseDhruAnswer,
  readAccountInfo,
  readOrderStatus,
  readPlacedOrder,
  readServiceList,
} from '../domain/dhru-protocol';
import {
  SUPPLIER_CALLS,
  accountInfoCall,
  getOrderCall,
  placeOrderCall,
  serviceListCall,
} from './supplier-calls.contracts';

const passes = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe('the registry', () => {
  it('holds the four calls of the map under their manifest keys, in the order of the map', () => {
    expect(SUPPLIER_CALLS.map((call) => call.key)).toEqual([
      'SUPPLIER accountinfo',
      'SUPPLIER imeiservicelist',
      'SUPPLIER placeimeiorder+placeimeiorderbulk',
      'SUPPLIER getimeiorder+getimeiorderbulk',
    ]);
    expect(supplierCallRegistry.keys()).toEqual(SUPPLIER_CALLS.map((call) => call.key));
    for (const call of SUPPLIER_CALLS) expect(supplierCallRegistry.get(call.key)).toBe(call);
  });

  it('names the same actions as the client sends (DHRU_ACTIONS), so renaming one side fails here', () => {
    expect(SUPPLIER_CALLS.map((call) => call.action).sort()).toEqual(Object.values(DHRU_ACTIONS).sort());
    for (const action of Object.values(DHRU_ACTIONS)) expect(supplierCallRegistry.forAction(action)).toBeDefined();
  });

  it('marks the two bulk variants as described but never sent, and says so in the description', () => {
    for (const call of [placeOrderCall, getOrderCall]) {
      expect(call.bulkAction).toBe(`${call.action}bulk`);
      expect(call.sendsBulk).toBe(false);
      expect(call.description).toContain('never sends');
    }
    for (const call of [accountInfoCall, serviceListCall]) expect(call.bulkAction).toBeNull();
  });

  it('has an example of the answer, of the error and (where the call takes parameters) of the request, each valid', () => {
    for (const call of SUPPLIER_CALLS) {
      expect(call.examples.response, call.key).toBeDefined();
      expect(call.examples.error, call.key).toBeDefined();
      expect(passes(call.success, call.examples.response), call.key).toBe(true);
      expect(passes(call.answer, { SUCCESS: [call.examples.response], apiversion: '6.1' }), call.key).toBe(true);
      expect(passes(call.answer, { ERROR: [call.examples.error], apiversion: '6.1' }), call.key).toBe(true);
    }
    expect(accountInfoCall.params).toBeUndefined();
    expect(serviceListCall.params).toBeUndefined();
    expect(passes(placeOrderCall.params, placeOrderCall.examples.request)).toBe(true);
    expect(passes(getOrderCall.params, getOrderCall.examples.request)).toBe(true);
  });
});

describe('SUPPLIER accountinfo', () => {
  it('accepts the standard spelling, the corrected one, a number and decorated text as the credit', () => {
    expect(passes(accountInfoCall.success, { AccoutInfo: { credit: '1240.50', currency: 'USD', mail: 'a@b.c' } })).toBe(
      true,
    );
    expect(passes(accountInfoCall.success, { AccountInfo: { credit: 5 } })).toBe(true);
    expect(passes(accountInfoCall.success, { AccoutInfo: { credit: '$1,200.50' } })).toBe(true);
  });

  it('ignores extra fields and a currency or mail of the wrong type', () => {
    expect(
      passes(accountInfoCall.success, { AccoutInfo: { credit: '1', currency: null, mail: {}, extra: 1 }, other: true }),
    ).toBe(true);
  });

  it('refuses an answer without a block or without a readable credit', () => {
    for (const body of [
      {},
      { AccoutInfo: { mail: 'x' } },
      { AccoutInfo: { credit: 'abc' } },
      { AccoutInfo: 'x' },
      { AccoutInfo: { credit: null } },
    ]) {
      expect(passes(accountInfoCall.success, body), JSON.stringify(body)).toBe(false);
    }
  });
});

describe('SUPPLIER imeiservicelist', () => {
  const good = {
    LIST: {
      G: {
        GROUPNAME: 'G',
        GROUPTYPE: 'IMEI',
        SERVICES: {
          '1': {
            SERVICEID: 1,
            SERVICENAME: 'One',
            CREDIT: '1.5',
            TIME: '1 hour',
            'Requires.Custom': [{ fieldname: 'a' }],
          },
        },
      },
    },
  };

  it('accepts the shape of decision 026, with ids as numbers or text', () => {
    expect(passes(serviceListCall.success, good)).toBe(true);
    expect(
      passes(serviceListCall.success, {
        LIST: { G: { SERVICES: { '2': { SERVICEID: '2', SERVICENAME: 'Two', CREDIT: 2 } } } },
      }),
    ).toBe(true);
  });

  it('refuses an answer whose success entry is not an object', () => {
    expect(serviceListCall.answer.safeParse({ SUCCESS: ['x'] }).success).toBe(false);
    expect(serviceListCall.answer.safeParse({ SUCCESS: [] }).success).toBe(false);
  });

  it('never refuses the whole list for one odd group, service or field: they are skipped by the reader', () => {
    for (const body of [
      {},
      { LIST: [] },
      { LIST: 'x' },
      { LIST: { G: 'x' } },
      { LIST: { G: { SERVICES: [] } } },
      { LIST: { G: { SERVICES: { '1': 'x', '2': { SERVICENAME: { a: 1 }, CREDIT: null, TIME: [] } } } } },
    ]) {
      expect(passes(serviceListCall.success, body), JSON.stringify(body)).toBe(true);
    }
  });
});

describe('SUPPLIER placeimeiorder', () => {
  it('refuses an answer without a REFERENCEID, accepts it as text or a number', () => {
    expect(passes(placeOrderCall.success, { MESSAGE: 'Order received', REFERENCEID: '88121' })).toBe(true);
    expect(passes(placeOrderCall.success, { REFERENCEID: 7 })).toBe(true);
    for (const body of [{}, { MESSAGE: 'ok' }, { REFERENCEID: ' ' }, { REFERENCEID: null }, { REFERENCEID: ['1'] }]) {
      expect(passes(placeOrderCall.success, body), JSON.stringify(body)).toBe(false);
    }
  });

  it('describes the parameters the client sends: the service, the optional input, a quantity and the optional custom fields', () => {
    expect(passes(placeOrderCall.params, { ID: '4411', QNT: 1 })).toBe(true);
    expect(
      passes(placeOrderCall.params, { ID: '4411', IMEI: '352905112490861', QNT: 2, CUSTOMFIELD: { a: 'b' } }),
    ).toBe(true);
    for (const body of [
      {},
      { ID: '', QNT: 1 },
      { ID: '1' },
      { ID: '1', QNT: 0 },
      { ID: '1', QNT: 1.5 },
      { ID: 1, QNT: 1 },
      { ID: '1', QNT: 1, CUSTOMFIELD: { a: 1 } },
    ]) {
      expect(passes(placeOrderCall.params, body), JSON.stringify(body)).toBe(false);
    }
  });
});

describe('SUPPLIER getimeiorder', () => {
  it('accepts STATUS 0, 1, 3 and 4 (2 as running) as a number or as text, with or without a CODE', () => {
    for (const status of [0, 1, 2, 3, 4, '0', '4', ' 3 ']) {
      expect(passes(getOrderCall.success, { STATUS: status, CODE: 'x' }), String(status)).toBe(true);
    }
    expect(passes(getOrderCall.success, { STATUS: 1 })).toBe(true);
  });

  it('refuses a missing, blank or unknown STATUS', () => {
    for (const body of [{}, { CODE: 'x' }, { STATUS: '' }, { STATUS: 5 }, { STATUS: 'done' }, { STATUS: null }]) {
      expect(passes(getOrderCall.success, body), JSON.stringify(body)).toBe(false);
    }
  });

  it('describes the parameters the client sends: the order reference', () => {
    expect(passes(getOrderCall.params, { ID: '88121' })).toBe(true);
    expect(passes(getOrderCall.params, { ID: '' })).toBe(false);
    expect(passes(getOrderCall.params, {})).toBe(false);
  });
});

describe('the readers of dhru-protocol read through the contracts', () => {
  const entry = (body: unknown): Record<string, unknown> => {
    const answer = parseDhruAnswer({ SUCCESS: [body] });
    if (answer.kind !== 'success') throw new Error('not a success');
    return answer.payload;
  };

  it('accepts exactly what the contract accepts: accountinfo', () => {
    const bodies = [
      { AccoutInfo: { credit: '1' } },
      { AccountInfo: { credit: 2 } },
      {},
      { AccoutInfo: { credit: 'abc' } },
      { AccoutInfo: [] },
    ];
    for (const body of bodies) {
      expect(readAccountInfo(entry(body)).ok, JSON.stringify(body)).toBe(passes(accountInfoCall.success, body));
    }
  });

  it('accepts exactly what the contract accepts: placeimeiorder', () => {
    for (const body of [{ REFERENCEID: 'a' }, { REFERENCEID: 0 }, { REFERENCEID: '' }, {}, { REFERENCEID: false }]) {
      expect(readPlacedOrder(entry(body)) !== undefined, JSON.stringify(body)).toBe(
        passes(placeOrderCall.success, body),
      );
    }
  });

  it('accepts exactly what the contract accepts: getimeiorder', () => {
    for (const body of [{ STATUS: 4 }, { STATUS: '3', CODE: 'no' }, { STATUS: 2 }, { STATUS: 7 }, { STATUS: '' }, {}]) {
      expect(readOrderStatus(entry(body)) !== undefined, JSON.stringify(body)).toBe(passes(getOrderCall.success, body));
    }
  });

  it('reads a service list the contract accepts into the services it can use, keeping the raw entry', () => {
    const body = serviceListCall.examples.response as Record<string, unknown>;
    const services = readServiceList(entry(body));
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      remoteId: '4411',
      group: 'Carrier unlock',
      type: 'IMEI',
      credit: '13.5000',
      requires: { Network: 'None' },
    });
    expect(services[0]?.raw).toMatchObject({ SERVICENAME: 'AT&T USA Premier', 'Requires.Network': 'None' });
  });
});
