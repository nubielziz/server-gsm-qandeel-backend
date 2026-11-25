// Unit tests of the rules of services sold as codes (decision 069): when a service counts as supplied, `out_of_stock`, and the words of
// the two refusals that guard the stock.
import { describe, expect, it } from 'bun:test';
import {
  CODES_IN_STOCK,
  NOT_STOCK_SERVICE,
  NOT_STOCK_SERVICE_MESSAGE,
  type SupplyFacts,
  codesInStockMessage,
  supplyStateOf,
} from '@src/modules/catalog/domain/code-stock';

const facts = (values: Partial<SupplyFacts>): SupplyFacts => ({
  activeLink: false,
  usableLink: false,
  stockDelivery: false,
  availableCodes: 0,
  ...values,
});

describe('supplyStateOf', () => {
  it('is ok with a usable supplier, whatever the stock', () => {
    expect(supplyStateOf(facts({ activeLink: true, usableLink: true }))).toBe('ok');
    expect(supplyStateOf(facts({ activeLink: true, usableLink: true, stockDelivery: true }))).toBe('ok');
    expect(supplyStateOf(facts({ activeLink: true, usableLink: true, stockDelivery: true, availableCodes: 3 }))).toBe(
      'ok',
    );
  });

  it('counts one available code of a stock service as supply, with no supplier or a paused one', () => {
    expect(supplyStateOf(facts({ stockDelivery: true, availableCodes: 1 }))).toBe('ok');
    expect(supplyStateOf(facts({ stockDelivery: true, availableCodes: 40, activeLink: true }))).toBe('ok');
  });

  it('is out_of_stock for a stock service with no usable supplier and no code, never supplier_unavailable', () => {
    expect(supplyStateOf(facts({ stockDelivery: true }))).toBe('out_of_stock');
    expect(supplyStateOf(facts({ stockDelivery: true, activeLink: true }))).toBe('out_of_stock');
  });

  it('never counts codes of a service that is not delivered from code stock', () => {
    expect(supplyStateOf(facts({ availableCodes: 12 }))).toBe('no_link');
    expect(supplyStateOf(facts({ availableCodes: 12, activeLink: true }))).toBe('supplier_unavailable');
  });

  it('keeps no_link and supplier_unavailable for any other service', () => {
    expect(supplyStateOf(facts({}))).toBe('no_link');
    expect(supplyStateOf(facts({ activeLink: true }))).toBe('supplier_unavailable');
  });
});

describe('the refusals that guard the stock', () => {
  it('names the codes to void before the flag goes off, one code in the singular', () => {
    expect(codesInStockMessage(3)).toBe('Void the 3 codes in stock first.');
    expect(codesInStockMessage(1)).toBe('Void the 1 code in stock first.');
    expect(CODES_IN_STOCK).toBe('codes_in_stock');
  });

  it('asks for the flag before an import', () => {
    expect(NOT_STOCK_SERVICE).toBe('not_stock_service');
    expect(NOT_STOCK_SERVICE_MESSAGE).toBe('Turn on Delivered from code stock for this service first.');
  });
});
