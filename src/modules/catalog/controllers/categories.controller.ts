// HTTP controller of the service category routes (map domain B, /admin/service-categories, stage 4). Thin: the rules live in
// CategoryAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CategoryAdminService } from '../application/category-admin.service';
import {
  createCategory,
  deleteCategory,
  listCategories,
  showCategory,
  updateCategory,
} from '../contracts/categories.contracts';

/**
 * The service category routes.
 *
 * Why: categories group the catalog (Dhru GROUPNAME) and choose which merchant groups see a service.
 *
 * @route GET /admin/service-categories
 * @route GET /admin/service-categories/:id
 * @route POST /admin/service-categories
 * @route PATCH /admin/service-categories/:id
 * @route DELETE /admin/service-categories/:id
 */
@Controller()
export class CategoriesController {
  constructor(private readonly categories: CategoryAdminService) {}

  /**
   * Lists categories.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/service-categories
   */
  @Route(listCategories)
  list(@Query() query: QueryOf<typeof listCategories>): Promise<ResultOf<typeof listCategories>> {
    return this.categories.list(query);
  }

  /**
   * Shows a category.
   *
   * @param params the category id
   * @returns the category
   * @route GET /admin/service-categories/:id
   */
  @Route(showCategory)
  show(@Param() params: ParamsOf<typeof showCategory>): Promise<ResultOf<typeof showCategory>> {
    return this.categories.show(params.id);
  }

  /**
   * Creates a category.
   *
   * @param body the category fields
   * @returns the new category
   * @route POST /admin/service-categories
   */
  @Route(createCategory)
  create(@Body() body: BodyOf<typeof createCategory>): Promise<ResultOf<typeof createCategory>> {
    return this.categories.create(body);
  }

  /**
   * Changes a category.
   *
   * @param params the category id
   * @param body the keys to change
   * @returns the updated category
   * @route PATCH /admin/service-categories/:id
   */
  @Route(updateCategory)
  update(
    @Param() params: ParamsOf<typeof updateCategory>,
    @Body() body: BodyOf<typeof updateCategory>,
  ): Promise<ResultOf<typeof updateCategory>> {
    return this.categories.update(params.id, body);
  }

  /**
   * Deletes a category.
   *
   * @param params the category id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/service-categories/:id
   */
  @Route(deleteCategory)
  remove(@Param() params: ParamsOf<typeof deleteCategory>): Promise<void> {
    return this.categories.remove(params.id);
  }
}
