// PageGeneratorService: the use case of `POST /admin/content-pages/generate` (feature 19, RESOLUTIONS b2c-15): draft landing pages for
// brand x model x network, refusing a run that would create more than 50.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { NewContentPage } from '../db/schema';
import {
  GENERATED_LOCALE,
  STOREFRONT_GENERATE_MAX_COMBINATIONS,
  STOREFRONT_GENERATE_MAX_PER_RUN,
  cleanList,
  combinationsOf,
  draftBody,
  overCapDetail,
  resolveModels,
  splitUsableModels,
  splitUsableNetworks,
} from '../domain/page-generator';
import { insertPagesSkippingTaken, takenSlugs } from '../infra/content-page.repository';
import { listTacNames } from '../infra/foreign-reads.repository';
import { listCarriers } from '../infra/page-generator.repository';
import { type ContentPageView, toContentPageView } from './content-page-admin.service';

/** The request as the use case takes it. */
export interface GenerateInput {
  readonly brands: readonly string[];
  readonly models: readonly string[];
  readonly networks: readonly string[];
}

/** What the route answers. */
export interface GenerateResult {
  readonly created: ContentPageView[];
  /** The distinct combinations that already had a page (one made by a parallel run counts too). */
  readonly skipped: number;
  /** The catalogue models left out because their name has no Latin letter or digit, so it cannot make a slug; absent when none. */
  readonly unusableModels?: number;
  /** The carriers of the listings left out for the same reason (an "all networks" run only); absent when none. */
  readonly unusableNetworks?: number;
}

/** The refusal of a run over the cap and of a run over the combinations bound: b2c-15's sentence, `422` with no field. */
const refusal = (newPages: number) =>
  new AppError('VALIDATION_FAILED', { detail: overCapDetail(newPages), errors: [] });

/**
 * Generates draft landing pages.
 *
 * Why: the map's landing-page generator ("drafts for review only"): the SEO pages for every model on every network are many and alike,
 * so staff generate them and review each. All-or-nothing on the cap (b2c-15): the server counts the new combinations first and
 * refuses the whole run when there are more than 50, so nobody has to guess which 50 were made. The insert itself skips a slug that
 * another request took meanwhile (`ON CONFLICT DO NOTHING`), so a race makes fewer drafts, never an error or a 51st; a page a parallel
 * run made counts as one that already existed. A catalogue model or a listing carrier whose name cannot make a slug is skipped and
 * counted in `unusableModels` / `unusableNetworks`, so one odd name never refuses an "all models" or "all networks" run.
 *
 * Side effects: inserts up to 50 `content_pages` rows (`draft`, no `published_at`) and writes one `audit_logs` row, in one transaction.
 *
 * @see docs/contract/endpoints/storefront.md (POST /admin/content-pages/generate)
 */
@Injectable()
export class PageGeneratorService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Makes the drafts.
   *
   * @param input the typed brands, models and networks (empty lists mean everything the site knows)
   * @param staffId the signed-in staff member (`author_id`)
   * @returns the new drafts, how many distinct combinations already had a page, and how many catalogue models and listing carriers had
   *   no usable name
   * @throws {AppError} `VALIDATION_FAILED` (422) with no field when the run would create more than 50 new drafts, when it covers more
   *   than 20 000 combinations, or when the catalogue read for it is longer than 20 000 models (the same sentence); on `models` or
   *   `networks` for a typed name that makes no slug
   */
  async generate(input: GenerateInput, staffId: number): Promise<GenerateResult> {
    const brands = cleanList(input.brands);
    const typedModels = cleanList(input.models);
    const typedNetworks = cleanList(input.networks);
    return this.db.runInTransaction(async ({ tx }) => {
      const lowerBrands = brands.map((brand) => brand.toLowerCase());
      const catalogue = {
        ofBrands:
          typedModels.length > 0
            ? []
            : await listTacNames(
                tx,
                lowerBrands.length > 0 ? { brands: lowerBrands } : {},
                STOREFRONT_GENERATE_MAX_COMBINATIONS + 1,
              ),
        ofNames:
          typedModels.length > 0
            ? await listTacNames(
                tx,
                { names: typedModels.map((name) => name.toLowerCase()) },
                STOREFRONT_GENERATE_MAX_COMBINATIONS,
              )
            : [],
      };
      const resolved = resolveModels(brands, typedModels, catalogue);
      // The catalogue read stops at MAX + 1 rows, so a longer list is the sign that the catalogue is bigger than the bound and this list is
      // cut. Judge it before any unusable name is dropped: dropping one would take the extra row away and pass an incomplete catalogue.
      if (typedModels.length === 0 && resolved.length > STOREFRONT_GENERATE_MAX_COMBINATIONS) {
        throw refusal(resolved.length);
      }
      // A typed name that makes no slug is the caller's mistake (422 below); a catalogue name is data the caller cannot fix: skip it.
      const { usable: models, unusable: unusableModels } =
        typedModels.length > 0 ? { usable: resolved, unusable: [] } : splitUsableModels(resolved);
      // The same for a listing carrier: skip and count it on an "all networks" run, 422 on `networks` below for a typed one.
      const { usable: networks, unusable: unusableNetworks } =
        typedNetworks.length > 0
          ? { usable: typedNetworks, unusable: [] }
          : splitUsableNetworks([...new Map((await listCarriers(tx)).map((c) => [c.toLowerCase(), c])).values()]);
      if (models.length * networks.length > STOREFRONT_GENERATE_MAX_COMBINATIONS) {
        throw refusal(models.length * networks.length);
      }

      const { drafts, unusable } = combinationsOf(models, networks);
      if (unusable) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            {
              field: unusable.field,
              code: 'no_slug',
              message: `"${unusable.value}" needs at least one Latin letter or digit to make a web address.`,
            },
          ],
        });
      }
      const taken = await takenSlugs(
        tx,
        GENERATED_LOCALE,
        drafts.map((draft) => draft.slug),
      );
      const fresh = drafts.filter((draft) => !taken.has(draft.slug));
      if (fresh.length > STOREFRONT_GENERATE_MAX_PER_RUN) throw refusal(fresh.length);

      const rows: NewContentPage[] = fresh.map((draft) => ({
        kind: 'model',
        slug: draft.slug,
        locale: GENERATED_LOCALE,
        title: draft.title,
        bodyMd: draftBody(draft),
        status: 'draft',
        authorId: staffId,
        templateParams: { brand: draft.brand, model: draft.model, network: draft.network },
      }));
      const created = await insertPagesSkippingTaken(tx, rows);
      // Distinct combinations minus the ones this run made: those that existed, or that a parallel run made first.
      const skipped = drafts.length - created.length;
      await this.audit.record(tx, {
        action: 'generated landing pages',
        entityType: 'content_page',
        entityLabel: `${created.length} drafts`,
        after: {
          created: created.length,
          skipped,
          unusableModels: unusableModels.length,
          unusableNetworks: unusableNetworks.length,
          pageIds: created.map((page) => page.id),
        },
      });
      return {
        created: created.map(toContentPageView),
        skipped,
        ...(unusableModels.length > 0 ? { unusableModels: unusableModels.length } : {}),
        ...(unusableNetworks.length > 0 ? { unusableNetworks: unusableNetworks.length } : {}),
      };
    });
  }
}
