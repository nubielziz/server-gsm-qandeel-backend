// HTTP controller of the role routes and the permission catalog (map domain A, /admin/roles and /admin/permissions, stage 2).
// Thin: it maps the request to the use case; the rules live in RoleAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { RoleAdminService } from '../application/role-admin.service';
import { createRole, deleteRole, listPermissions, listRoles, showRole, updateRole } from '../contracts/roles.contracts';
import { CurrentStaff } from '../security/access-state';
import type { StaffPrincipal } from '../security/principal';

/**
 * The role routes.
 *
 * Why: roles and the permission catalog drive the console's access screen (ALIGNMENT § 4).
 *
 * @route GET /admin/roles
 * @route GET /admin/roles/:id
 * @route POST /admin/roles
 * @route PATCH /admin/roles/:id
 * @route DELETE /admin/roles/:id
 * @route GET /admin/permissions
 */
@Controller()
export class RolesController {
  constructor(private readonly roles: RoleAdminService) {}

  /**
   * Lists roles.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/roles
   */
  @Route(listRoles)
  list(@Query() query: QueryOf<typeof listRoles>): Promise<ResultOf<typeof listRoles>> {
    return this.roles.list(query);
  }

  /**
   * Shows a role.
   *
   * @param params the role id
   * @returns the role
   * @route GET /admin/roles/:id
   */
  @Route(showRole)
  show(@Param() params: ParamsOf<typeof showRole>): Promise<ResultOf<typeof showRole>> {
    return this.roles.show(params.id);
  }

  /**
   * Creates a role.
   *
   * @param staff the caller
   * @param body the name and permissions
   * @returns the new role
   * @route POST /admin/roles
   */
  @Route(createRole)
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createRole>,
  ): Promise<ResultOf<typeof createRole>> {
    return this.roles.create(staff, body);
  }

  /**
   * Updates a role.
   *
   * @param staff the caller
   * @param params the role id
   * @param body the keys to change
   * @returns the updated role
   * @route PATCH /admin/roles/:id
   */
  @Route(updateRole)
  update(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateRole>,
    @Body() body: BodyOf<typeof updateRole>,
  ): Promise<ResultOf<typeof updateRole>> {
    return this.roles.update(staff, params.id, body);
  }

  /**
   * Deletes a role.
   *
   * @param staff the caller
   * @param params the role id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/roles/:id
   */
  @Route(deleteRole)
  remove(@CurrentStaff() staff: StaffPrincipal, @Param() params: ParamsOf<typeof deleteRole>): Promise<void> {
    return this.roles.remove(staff, params.id);
  }

  /**
   * Lists the permission catalog.
   *
   * @returns every concrete permission with group and label
   * @route GET /admin/permissions
   */
  @Route(listPermissions)
  permissions(): ResultOf<typeof listPermissions> {
    return this.roles.permissions();
  }
}
