// HTTP controller of the merchant group routes (map domain B, /admin/client-groups, stage 4). Thin: it maps the request to the
// use case; the rules live in ClientGroupAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { ClientGroupAdminService } from '../application/client-group-admin.service';
import {
  createClientGroup,
  deleteClientGroup,
  listClientGroups,
  showClientGroup,
  updateClientGroup,
} from '../contracts/client-groups.contracts';

/**
 * The merchant group routes.
 *
 * Why: groups carry the discount, the promotion threshold, the deposit limit and the credit rule of the merchants in them.
 *
 * @route GET /admin/client-groups
 * @route GET /admin/client-groups/:id
 * @route POST /admin/client-groups
 * @route PATCH /admin/client-groups/:id
 * @route DELETE /admin/client-groups/:id
 */
@Controller()
export class ClientGroupsController {
  constructor(private readonly groups: ClientGroupAdminService) {}

  /**
   * Lists groups.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/client-groups
   */
  @Route(listClientGroups)
  list(@Query() query: QueryOf<typeof listClientGroups>): Promise<ResultOf<typeof listClientGroups>> {
    return this.groups.list(query);
  }

  /**
   * Shows a group.
   *
   * @param params the group id
   * @returns the group
   * @route GET /admin/client-groups/:id
   */
  @Route(showClientGroup)
  show(@Param() params: ParamsOf<typeof showClientGroup>): Promise<ResultOf<typeof showClientGroup>> {
    return this.groups.show(params.id);
  }

  /**
   * Creates a group.
   *
   * @param body the group fields
   * @returns the new group
   * @route POST /admin/client-groups
   */
  @Route(createClientGroup)
  create(@Body() body: BodyOf<typeof createClientGroup>): Promise<ResultOf<typeof createClientGroup>> {
    return this.groups.create(body);
  }

  /**
   * Changes a group.
   *
   * @param params the group id
   * @param body the keys to change
   * @returns the updated group
   * @route PATCH /admin/client-groups/:id
   */
  @Route(updateClientGroup)
  update(
    @Param() params: ParamsOf<typeof updateClientGroup>,
    @Body() body: BodyOf<typeof updateClientGroup>,
  ): Promise<ResultOf<typeof updateClientGroup>> {
    return this.groups.update(params.id, body);
  }

  /**
   * Deletes a group.
   *
   * @param params the group id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/client-groups/:id
   */
  @Route(deleteClientGroup)
  remove(@Param() params: ParamsOf<typeof deleteClientGroup>): Promise<void> {
    return this.groups.remove(params.id);
  }
}
