// HTTP controller of the notification campaigns (feature 23, routes /admin/notification-campaigns*, scripts/map-additions/23.mjs).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../../common/contract';
import { AudiencePreviewService } from './audience-preview.service';
import { CampaignAdminService } from './campaign-admin.service';
import { CampaignSendService } from './campaign-send.service';
import {
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  listCampaignRecipients,
  listCampaigns,
  previewAudience,
  previewCampaign,
  scheduleCampaign,
  sendCampaign,
  showCampaign,
  testCampaign,
  updateCampaign,
} from './campaign.contracts';

/**
 * Routes of the notification campaigns.
 *
 * Why: owner list E (notification center): staff write, preview, test, schedule, send and follow broadcasts from the console. Thin
 * layer over {@link CampaignAdminService}, {@link CampaignSendService} and {@link AudiencePreviewService}.
 */
@Controller()
export class CampaignsController {
  constructor(
    private readonly admin: CampaignAdminService,
    private readonly sending: CampaignSendService,
    private readonly previews: AudiencePreviewService,
  ) {}

  /**
   * Lists campaigns.
   *
   * @param query range, sort, filters and search
   * @returns the page
   * @route GET /admin/notification-campaigns
   */
  @Route(listCampaigns)
  list(@Query() query: QueryOf<typeof listCampaigns>): Promise<ResultOf<typeof listCampaigns>> {
    return this.admin.list(query);
  }

  /**
   * Creates a draft.
   *
   * @param body the campaign
   * @returns the draft
   * @route POST /admin/notification-campaigns
   */
  @Route(createCampaign)
  create(@Body() body: BodyOf<typeof createCampaign>): Promise<ResultOf<typeof createCampaign>> {
    return this.admin.create(body);
  }

  /**
   * Counts an audience.
   *
   * @param body the audience, channels and purpose
   * @returns the counts
   * @route POST /admin/notification-campaigns/audience-preview
   */
  @Route(previewAudience)
  audience(@Body() body: BodyOf<typeof previewAudience>): Promise<ResultOf<typeof previewAudience>> {
    return this.previews.preview(body.audience, body.channels, body.purpose);
  }

  /**
   * Reads one campaign.
   *
   * @param params the id
   * @returns the detail
   * @route GET /admin/notification-campaigns/:id
   */
  @Route(showCampaign)
  show(@Param() params: ParamsOf<typeof showCampaign>): Promise<ResultOf<typeof showCampaign>> {
    return this.admin.get(params.id);
  }

  /**
   * Edits a draft or scheduled campaign.
   *
   * @param params the id
   * @param body the fields to change
   * @returns the detail
   * @route PATCH /admin/notification-campaigns/:id
   */
  @Route(updateCampaign)
  update(
    @Param() params: ParamsOf<typeof updateCampaign>,
    @Body() body: BodyOf<typeof updateCampaign>,
  ): Promise<ResultOf<typeof updateCampaign>> {
    return this.admin.update(params.id, body);
  }

  /**
   * Deletes a draft.
   *
   * @param params the id
   * @returns nothing (204)
   * @route DELETE /admin/notification-campaigns/:id
   */
  @Route(deleteCampaign)
  remove(@Param() params: ParamsOf<typeof deleteCampaign>): Promise<void> {
    return this.admin.remove(params.id);
  }

  /**
   * Renders a campaign.
   *
   * @param params the id
   * @param body the channel and audience
   * @returns the preview
   * @route POST /admin/notification-campaigns/:id/preview
   */
  @Route(previewCampaign)
  preview(
    @Param() params: ParamsOf<typeof previewCampaign>,
    @Body() body: BodyOf<typeof previewCampaign>,
  ): Promise<ResultOf<typeof previewCampaign>> {
    return this.admin.preview(params.id, body);
  }

  /**
   * Sends a test to the caller.
   *
   * @param params the id
   * @param body the channels
   * @returns the channels a message was made for
   * @route POST /admin/notification-campaigns/:id/test
   */
  @Route(testCampaign)
  test(
    @Param() params: ParamsOf<typeof testCampaign>,
    @Body() body: BodyOf<typeof testCampaign>,
  ): Promise<ResultOf<typeof testCampaign>> {
    return this.sending.test(params.id, body.channels);
  }

  /**
   * Sends a campaign now.
   *
   * @param params the id
   * @param body the confirmed number of people
   * @returns the queued campaign
   * @route POST /admin/notification-campaigns/:id/send
   */
  @Route(sendCampaign)
  send(
    @Param() params: ParamsOf<typeof sendCampaign>,
    @Body() body: BodyOf<typeof sendCampaign>,
  ): Promise<ResultOf<typeof sendCampaign>> {
    return this.sending.send(params.id, body.confirmRecipients);
  }

  /**
   * Schedules a campaign.
   *
   * @param params the id
   * @param body the time
   * @returns the scheduled campaign
   * @route POST /admin/notification-campaigns/:id/schedule
   */
  @Route(scheduleCampaign)
  schedule(
    @Param() params: ParamsOf<typeof scheduleCampaign>,
    @Body() body: BodyOf<typeof scheduleCampaign>,
  ): Promise<ResultOf<typeof scheduleCampaign>> {
    return this.sending.schedule(params.id, new Date(body.scheduledAt));
  }

  /**
   * Cancels a campaign.
   *
   * @param params the id
   * @returns the cancelled campaign
   * @route POST /admin/notification-campaigns/:id/cancel
   */
  @Route(cancelCampaign)
  cancel(@Param() params: ParamsOf<typeof cancelCampaign>): Promise<ResultOf<typeof cancelCampaign>> {
    return this.sending.cancel(params.id);
  }

  /**
   * Lists the recipients of a campaign on one channel.
   *
   * @param params the id
   * @param query range, status filter and channel
   * @returns the page
   * @route GET /admin/notification-campaigns/:id/recipients
   */
  @Route(listCampaignRecipients)
  recipients(
    @Param() params: ParamsOf<typeof listCampaignRecipients>,
    @Query() query: QueryOf<typeof listCampaignRecipients>,
  ): Promise<ResultOf<typeof listCampaignRecipients>> {
    return this.admin.recipients(params.id, query);
  }
}
