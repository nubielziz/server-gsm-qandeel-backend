// HTTP controller of the system settings routes (map domain G, /admin/settings, stage 2). Thin; the rules live in
// SettingsAdminService.
import { Body, Controller, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { SettingsAdminService } from '../application/settings-admin.service';
import { getSettings, updateSettings } from '../contracts/settings.contracts';
import { identity } from '../infra/identity-access';

/**
 * The system settings routes.
 *
 * Why: the console's System tab and the privacy panel read and edit settings (RULES settings).
 *
 * @route GET /admin/settings
 * @route PATCH /admin/settings
 */
@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsAdminService) {}

  /**
   * Reads the settings.
   *
   * @returns the flat settings object
   * @route GET /admin/settings
   */
  @Route(getSettings)
  get(): Promise<ResultOf<typeof getSettings>> {
    return this.settings.get();
  }

  /**
   * Changes allow-listed settings.
   *
   * @param body the keys to set
   * @param request the request (its principal is the caller of the Owner-only keys)
   * @returns the settings after the change
   * @route PATCH /admin/settings
   */
  @Route(updateSettings)
  async update(
    @Body() body: BodyOf<typeof updateSettings>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof updateSettings>> {
    const principal = (await identity()).principalOf(request);
    // The route admits only a staff session with settings:update, so the caller is a staff member.
    return this.settings.update(body, principal?.kind === 'staff' ? principal : { permissions: [] });
  }
}
