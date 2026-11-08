// HTTP controller of the TAC catalog (map domain B, stage 14, routes /admin/tac-catalog). Thin: the use cases are in
// TacCatalogAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { TacCatalogAdminService } from '../application/tac-catalog-admin.service';
import { createTacEntry, getTacEntry, listTacEntries, updateTacEntry } from '../contracts/tac-catalog.contracts';

/**
 * The TAC catalog routes of the console's Storefront page.
 *
 * Why: staff look up and correct which brand and model an IMEI prefix names (RULES storefront); the IMEI check of the storefront
 * reads the same table.
 *
 * @route GET /admin/tac-catalog
 * @route GET /admin/tac-catalog/:id
 * @route POST /admin/tac-catalog
 * @route PATCH /admin/tac-catalog/:id
 */
@Controller()
export class TacCatalogController {
  constructor(private readonly tac: TacCatalogAdminService) {}

  /**
   * Lists TAC entries.
   *
   * @param query the parsed list request
   * @returns the page and its total
   * @route GET /admin/tac-catalog
   */
  @Route(listTacEntries)
  list(@Query() query: QueryOf<typeof listTacEntries>): Promise<ResultOf<typeof listTacEntries>> {
    return this.tac.list(query);
  }

  /**
   * Reads one entry.
   *
   * @param params the entry id
   * @returns the entry
   * @route GET /admin/tac-catalog/:id
   */
  @Route(getTacEntry)
  show(@Param() params: ParamsOf<typeof getTacEntry>): Promise<ResultOf<typeof getTacEntry>> {
    return this.tac.get(params.id);
  }

  /**
   * Adds an entry.
   *
   * @param body the new entry
   * @returns the created entry
   * @route POST /admin/tac-catalog
   */
  @Route(createTacEntry)
  create(@Body() body: BodyOf<typeof createTacEntry>): Promise<ResultOf<typeof createTacEntry>> {
    return this.tac.create(body);
  }

  /**
   * Corrects an entry.
   *
   * @param params the entry id
   * @param body the fields to change
   * @returns the entry after the change
   * @route PATCH /admin/tac-catalog/:id
   */
  @Route(updateTacEntry)
  update(
    @Param() params: ParamsOf<typeof updateTacEntry>,
    @Body() body: BodyOf<typeof updateTacEntry>,
  ): Promise<ResultOf<typeof updateTacEntry>> {
    return this.tac.update(params.id, body);
  }
}
