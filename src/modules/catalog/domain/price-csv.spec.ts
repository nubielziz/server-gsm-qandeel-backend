// Unit tests of the price list CSV: the header, CRLF line ends, quoting and the spreadsheet formula guard.
import { describe, expect, it } from 'bun:test';
import { csvCell, priceListCsv } from './price-csv';

describe('csvCell', () => {
  it('quotes a cell with a comma, a quote or a line break', () => {
    expect(csvCell('AT&T, USA')).toBe('"AT&T, USA"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('plain')).toBe('plain');
  });

  it('writes a cell that would run as a formula as text', () => {
    for (const text of ['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx']) {
      expect(csvCell(text).replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });
});

describe('priceListCsv', () => {
  it('writes the header and one line per service, with CRLF line ends', () => {
    const csv = priceListCsv([
      {
        serviceId: 5,
        code: 'IMEI-ATT-USA',
        name: 'AT&T USA Unlock',
        type: 'imei',
        category: 'Carrier unlock',
        price: '16.9300',
        currency: 'USD',
        deliveryTime: '2 days',
      },
      {
        serviceId: 6,
        code: 'X',
        name: '=EVIL()',
        type: 'file',
        category: 'A, B',
        price: '1.0000',
        currency: 'USD',
        deliveryTime: '5 min',
      },
    ]);
    expect(csv).toBe(
      'serviceId,code,name,type,category,price,currency,deliveryTime\r\n' +
        '5,IMEI-ATT-USA,AT&T USA Unlock,imei,Carrier unlock,16.9300,USD,2 days\r\n' +
        `6,X,'=EVIL(),file,"A, B",1.0000,USD,5 min\r\n`,
    );
  });

  it('writes only the header for an empty list', () => {
    expect(priceListCsv([])).toBe('serviceId,code,name,type,category,price,currency,deliveryTime\r\n');
  });
});
