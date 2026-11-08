// HTTP controller of the storefront policies (map domain H, stage 16, route PATCH /admin/storefront/settings).
import { Body, Controller } from '@nestjs/common';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { StorefrontSettingsService } from '../application/storefront-settings.service';
import { updateStorefrontSettings } from '../contracts/storefront-settings.contracts';

/**
 * The route that changes the storefront policies.
 *
 * Why: thin layer over {@link StorefrontSettingsService}.
 *
 * @route PATCH /admin/storefront/settings
 */
@Controller()
export class StorefrontSettingsController {
  constructor(private readonly settings: StorefrontSettingsService) {}

  /**
   * Changes policies.
   *
   * @param body the keys to change
   * @returns the policies after the change
   * @route PATCH /admin/storefront/settings
   */
  @Route(updateStorefrontSettings)
  update(@Body() body: BodyOf<typeof updateStorefrontSettings>): Promise<ResultOf<typeof updateStorefrontSettings>> {
    return this.settings.update(body);
  }
}
