// HTTP controller of currencies and exchange rates (map domain E, stage 3, routes /admin/currencies).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { createCurrency, getCurrency, listCurrencies, updateCurrency } from '../contracts/currencies.contracts';
import { CurrencyService } from '../application/currency.service';

/**
 * The currency routes of the console's Settings page.
 *
 * Why: staff list currencies, add one, switch it on the storefront and set its rate and markup (RULES settings 7).
 *
 * @route GET /admin/currencies
 * @route GET /admin/currencies/:id
 * @route POST /admin/currencies
 * @route PATCH /admin/currencies/:id
 */
@Controller()
export class CurrenciesController {
  constructor(private readonly currencies: CurrencyService) {}

  /**
   * Lists currencies.
   *
   * @param query the parsed list request
   * @returns the page and its total
   * @route GET /admin/currencies
   */
  @Route(listCurrencies)
  list(@Query() query: QueryOf<typeof listCurrencies>): Promise<ResultOf<typeof listCurrencies>> {
    return this.currencies.list(query);
  }

  /**
   * Reads one currency.
   *
   * @param params the currency id
   * @returns the currency
   * @route GET /admin/currencies/:id
   */
  @Route(getCurrency)
  show(@Param() params: ParamsOf<typeof getCurrency>): Promise<ResultOf<typeof getCurrency>> {
    return this.currencies.get(params.id);
  }

  /**
   * Adds a currency.
   *
   * @param body the new currency
   * @returns the created currency
   * @route POST /admin/currencies
   */
  @Route(createCurrency)
  create(@Body() body: BodyOf<typeof createCurrency>): Promise<ResultOf<typeof createCurrency>> {
    return this.currencies.create(body);
  }

  /**
   * Changes a currency.
   *
   * @param params the currency id
   * @param body the fields to change
   * @returns the changed currency
   * @route PATCH /admin/currencies/:id
   */
  @Route(updateCurrency)
  update(
    @Param() params: ParamsOf<typeof updateCurrency>,
    @Body() body: BodyOf<typeof updateCurrency>,
  ): Promise<ResultOf<typeof updateCurrency>> {
    return this.currencies.update(params.id, body);
  }
}
