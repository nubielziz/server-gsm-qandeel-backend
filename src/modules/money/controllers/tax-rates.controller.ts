// HTTP controller of the tax rates by country (map domain E, stage 14, routes /admin/tax-rates; built ahead of feature 14b).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { TaxRateService } from '../application/tax-rate.service';
import { createTaxRate, getTaxRate, listTaxRates, updateTaxRate } from '../contracts/tax-rates.contracts';

/**
 * Routes of the tax rates.
 *
 * Why: thin layer over {@link TaxRateService}: the contracts check access, CSRF and shapes; the service applies the rules.
 */
@Controller()
export class TaxRatesController {
  constructor(private readonly taxRates: TaxRateService) {}

  /**
   * Lists the tax rates.
   *
   * @param query sort, range and search
   * @returns the page of rows
   * @route GET /admin/tax-rates
   */
  @Route(listTaxRates)
  list(@Query() query: QueryOf<typeof listTaxRates>): Promise<ResultOf<typeof listTaxRates>> {
    return this.taxRates.list(query);
  }

  /**
   * Reads one tax rate.
   *
   * @param params the row id
   * @returns the row
   * @route GET /admin/tax-rates/:id
   */
  @Route(getTaxRate)
  show(@Param() params: ParamsOf<typeof getTaxRate>): Promise<ResultOf<typeof getTaxRate>> {
    return this.taxRates.get(params.id);
  }

  /**
   * Adds a window.
   *
   * @param body the new window
   * @returns the stored row
   * @route POST /admin/tax-rates
   */
  @Route(createTaxRate)
  create(@Body() body: BodyOf<typeof createTaxRate>): Promise<ResultOf<typeof createTaxRate>> {
    return this.taxRates.create(body);
  }

  /**
   * Changes a window.
   *
   * @param params the row id
   * @param body the fields to change
   * @returns the stored row
   * @route PATCH /admin/tax-rates/:id
   */
  @Route(updateTaxRate)
  update(
    @Param() params: ParamsOf<typeof updateTaxRate>,
    @Body() body: BodyOf<typeof updateTaxRate>,
  ): Promise<ResultOf<typeof updateTaxRate>> {
    return this.taxRates.update(params.id, body);
  }
}
