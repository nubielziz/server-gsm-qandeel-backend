// HTTP controller of the system settings routes (map domain G, /admin/settings, stage 2). Thin; the rules live in
// SettingsAdminService.
import { Body, Controller } from '@nestjs/common';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { SettingsAdminService } from '../application/settings-admin.service';
import { getSettings, updateSettings } from '../contracts/settings.contracts';

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
   * @returns the settings after the change
   * @route PATCH /admin/settings
   */
  @Route(updateSettings)
  update(@Body() body: BodyOf<typeof updateSettings>): Promise<ResultOf<typeof updateSettings>> {
    return this.settings.update(body);
  }
}
