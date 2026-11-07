// HTTP controller of the supplier connection routes (map domain C, /admin/suppliers*, stage 6). Thin: the rules live in
// SupplierAdminService, SupplierReader, SupplierConnectionService and SupplierCatalogueService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { SupplierAdminService } from '../application/supplier-admin.service';
import { SupplierCatalogueService } from '../application/supplier-catalogue.service';
import { SupplierConnectionService } from '../application/supplier-connection.service';
import { SupplierReader } from '../application/supplier-reader';
import { AppError } from '../../../common/errors';
import {
  createSupplier,
  deleteSupplier,
  importServices,
  listSupplierServices,
  listSuppliers,
  previewImport,
  showSupplier,
  syncSupplier,
  testSupplier,
  updateSupplier,
} from '../contracts/suppliers.contracts';

/**
 * The supplier routes.
 *
 * Why: the console's Suppliers page: connections, their health, the test and sync buttons, the supplier's catalogue and the import.
 *
 * @route GET /admin/suppliers
 * @route GET /admin/suppliers/:id
 * @route POST /admin/suppliers
 * @route PATCH /admin/suppliers/:id
 * @route DELETE /admin/suppliers/:id
 * @route POST /admin/suppliers/:id/test
 * @route POST /admin/suppliers/:id/sync
 * @route GET /admin/suppliers/:id/services
 * @route POST /admin/suppliers/:id/import/preview
 * @route POST /admin/suppliers/:id/import
 */
@Controller()
export class SuppliersController {
  constructor(
    private readonly admin: SupplierAdminService,
    private readonly reader: SupplierReader,
    private readonly connection: SupplierConnectionService,
    private readonly catalogue: SupplierCatalogueService,
  ) {}

  /**
   * Lists suppliers.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/suppliers
   */
  @Route(listSuppliers)
  list(@Query() query: QueryOf<typeof listSuppliers>): Promise<ResultOf<typeof listSuppliers>> {
    return this.reader.list(query);
  }

  /**
   * Shows a supplier with its history and links.
   *
   * @param params the supplier id
   * @returns the detail
   * @route GET /admin/suppliers/:id
   */
  @Route(showSupplier)
  async show(@Param() params: ParamsOf<typeof showSupplier>): Promise<ResultOf<typeof showSupplier>> {
    const detail = await this.reader.detail(params.id);
    if (!detail) throw new AppError('NOT_FOUND', { detail: 'No supplier has this id.' });
    return detail;
  }

  /**
   * Adds a supplier.
   *
   * @param body the supplier fields
   * @returns the new supplier
   * @route POST /admin/suppliers
   */
  @Route(createSupplier)
  create(@Body() body: BodyOf<typeof createSupplier>): Promise<ResultOf<typeof createSupplier>> {
    return this.admin.create(body);
  }

  /**
   * Changes a supplier.
   *
   * @param params the supplier id
   * @param body the keys to change
   * @returns the updated supplier
   * @route PATCH /admin/suppliers/:id
   */
  @Route(updateSupplier)
  update(
    @Param() params: ParamsOf<typeof updateSupplier>,
    @Body() body: BodyOf<typeof updateSupplier>,
  ): Promise<ResultOf<typeof updateSupplier>> {
    return this.admin.update(params.id, body);
  }

  /**
   * Deletes a supplier nothing refers to.
   *
   * @param params the supplier id
   * @returns nothing: the answer is `204`
   * @route DELETE /admin/suppliers/:id
   */
  @Route(deleteSupplier)
  remove(@Param() params: ParamsOf<typeof deleteSupplier>): Promise<void> {
    return this.admin.remove(params.id);
  }

  /**
   * Tests the connection.
   *
   * @param params the supplier id
   * @returns whether it worked and what the supplier said
   * @route POST /admin/suppliers/:id/test
   */
  @Route(testSupplier)
  test(@Param() params: ParamsOf<typeof testSupplier>): Promise<ResultOf<typeof testSupplier>> {
    return this.connection.test(params.id);
  }

  /**
   * Syncs the supplier now.
   *
   * @param params the supplier id
   * @returns the counts and the balance
   * @route POST /admin/suppliers/:id/sync
   */
  @Route(syncSupplier)
  sync(@Param() params: ParamsOf<typeof syncSupplier>): Promise<ResultOf<typeof syncSupplier>> {
    return this.connection.sync(params.id);
  }

  /**
   * Lists the supplier's synced services.
   *
   * @param params the supplier id
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/suppliers/:id/services
   */
  @Route(listSupplierServices)
  services(
    @Param() params: ParamsOf<typeof listSupplierServices>,
    @Query() query: QueryOf<typeof listSupplierServices>,
  ): Promise<ResultOf<typeof listSupplierServices>> {
    return this.catalogue.listServices(params.id, query);
  }

  /**
   * Previews an import.
   *
   * @param params the supplier id
   * @param body the picked supplier services
   * @returns what would happen to each
   * @route POST /admin/suppliers/:id/import/preview
   */
  @Route(previewImport)
  preview(
    @Param() params: ParamsOf<typeof previewImport>,
    @Body() body: BodyOf<typeof previewImport>,
  ): Promise<ResultOf<typeof previewImport>> {
    return this.catalogue.preview(params.id, body.supplierServiceIds);
  }

  /**
   * Imports supplier services.
   *
   * @param params the supplier id
   * @param body the picked supplier services
   * @returns how many were created, updated and left as they were
   * @route POST /admin/suppliers/:id/import
   */
  @Route(importServices)
  import(
    @Param() params: ParamsOf<typeof importServices>,
    @Body() body: BodyOf<typeof importServices>,
  ): Promise<ResultOf<typeof importServices>> {
    return this.catalogue.import(params.id, body.supplierServiceIds);
  }
}
