// HTTP controller of the storefront listing routes (map domain H, /admin/service-listings, stage 15). Thin: the rules live in
// ListingAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { ListingAdminService } from '../application/listing-admin.service';
import { createListing, listListings, showListing, updateListing } from '../contracts/listings.contracts';

/**
 * The storefront listing routes.
 *
 * Why: staff decide which services appear on the public site and at what retail price.
 *
 * @route GET /admin/service-listings
 * @route GET /admin/service-listings/:id
 * @route POST /admin/service-listings
 * @route PATCH /admin/service-listings/:id
 */
@Controller()
export class ListingsController {
  constructor(private readonly listings: ListingAdminService) {}

  /**
   * Lists listings.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/service-listings
   */
  @Route(listListings)
  list(@Query() query: QueryOf<typeof listListings>): Promise<ResultOf<typeof listListings>> {
    return this.listings.list(query);
  }

  /**
   * Shows a listing.
   *
   * @param params the listing id
   * @returns the listing
   * @route GET /admin/service-listings/:id
   */
  @Route(showListing)
  show(@Param() params: ParamsOf<typeof showListing>): Promise<ResultOf<typeof showListing>> {
    return this.listings.show(params.id);
  }

  /**
   * Creates a listing.
   *
   * @param body the service, language, title and optional slug
   * @returns the new listing
   * @route POST /admin/service-listings
   */
  @Route(createListing)
  create(@Body() body: BodyOf<typeof createListing>): Promise<ResultOf<typeof createListing>> {
    return this.listings.create(body);
  }

  /**
   * Changes a listing.
   *
   * @param params the listing id
   * @param body `isListed` and/or `retailPrice`
   * @returns the updated listing
   * @route PATCH /admin/service-listings/:id
   */
  @Route(updateListing)
  update(
    @Param() params: ParamsOf<typeof updateListing>,
    @Body() body: BodyOf<typeof updateListing>,
  ): Promise<ResultOf<typeof updateListing>> {
    return this.listings.update(params.id, body);
  }
}
