// PublishItemEditService: the staff edits of a publish draft's rows (feature 31, decision 040, plan 31 sections 5.2 and 6.5): the row's
// `PATCH` and the `bulk` change. Both write only `listing_publish_items`: a preview changes nothing a visitor or a merchant can see.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { AppError, type FieldError } from '../../../../common/errors';
import { DbService } from '../../../../infra/db';
import type { ListingPublishItem } from '../../db/schema';
import { listingNamesOfAll } from '../../infra/listing.repository';
import { nameKey, titleKey } from '../domain/naming';
import { type FactsChange, type RowEdit, editRow, resetDropsPriceChoice, withFacts } from '../domain/publish-edit';
import type { DraftDetected } from '../domain/publish-draft';
import { namingTypeOf } from '../domain/publish-draft';
import type { PublishItemView } from '../domain/publish-view';
import {
  countBlockedAmong,
  itemsByIds,
  lockPendingItem,
  lockRun,
  setIncluded,
  shareRun,
  writeDraftRows,
  writeFacts,
} from '../infra/publish.repository';
import { type ItemSelectionFilter, findItemRow, otherItemsOf, selectItemIds } from '../infra/publish-read.repository';
import { PublishDraftFacts } from './publish-draft-facts';
import { itemViewsOf } from './publish-item-views';
import { PRICE_PERMISSION, missingPermission } from './publish-permissions';

/** What `POST /admin/publish-runs/:id/items/bulk` selects: some rows by id, or every row a filter matches. */
export type BulkSelect = { readonly itemIds: readonly number[] } | { readonly filter: ItemSelectionFilter };

/** What a bulk change sets (at least one key; the contract demands it). */
export interface BulkSet extends FactsChange {
  readonly included?: boolean;
}

/** Rows read, recomputed and written in one page of a bulk change of the facts (plan 31 section 5.2). */
const FACTS_PAGE = 500;

/** Ids in one statement of a bulk change. */
const ID_PAGE = 1000;

const notFound = (what: string) => new AppError('NOT_FOUND', { detail: `No ${what} has this id.` });

const notADraft = () => new AppError('CONFLICT', { detail: 'This run is no longer a draft.' });

function invalid(errors: readonly FieldError[]): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [...errors] });
}

/** Splits a list into pages. */
function pagesOf<T>(list: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let at = 0; at < list.length; at += size) pages.push(list.slice(at, at + size));
  return pages;
}

/** The fields of a stored row an edit starts from. */
function editableOf(item: ListingPublishItem) {
  return {
    serviceId: item.serviceId,
    detected: item.detected as unknown as DraftDetected,
    title: item.title,
    slug: item.slug,
    slugSource: item.slugSource,
    brand: item.brand,
    carrier: item.carrier,
    country: item.country,
    priceMode: item.priceMode,
    priceOverride: item.priceOverride,
    replacesPrice: item.replacesPrice,
    flags: item.flags,
    state: item.state,
    included: item.included,
    edited: item.edited,
  };
}

/**
 * The staff edits of the rows of a publish draft.
 *
 * Why: plan 31 section 5.2: staff correct the preview before anything is published. A row is edited one at a time (`edit`: a title, an
 * address, the facts, a price choice, the tick, or a reset) or many at once (`bulk`: the tick and the facts of the rows picked by id or by a
 * filter). The locks are those of 6.5: a row edit takes the run row `FOR SHARE`, and checks that it is a `draft` under that lock, then the
 * item row `FOR UPDATE`; apply, cancel and "Check again" take the run row `FOR UPDATE`, so an edit and a move of the run never interleave
 * (either apply publishes the edited row, or the edit answers `409`); a bulk takes the run row `FOR UPDATE` itself (one at a time).
 *
 * Side effects: updates `listing_publish_items` only. No audit row (a draft is not a record of the shop; apply, cancel and the run switch are
 * audited), no service, listing, price, search document or cache key.
 *
 * @see docs/briefs/31-bulk-publish.md (sections 3.2, 5.2 and 6.5)
 */
@Injectable()
export class PublishItemEditService {
  constructor(
    private readonly db: DbService,
    private readonly facts: PublishDraftFacts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Edits one row of a draft and judges it again on the facts of now.
   *
   * The refusals are decided before the single `UPDATE`: the row is stored whole or not at all. A row the evaluation blocks (the service
   * was disabled since, a price under a floor that rose) is stored `blocked` and unticked, and the answer is `200`; only `included: true`
   * on a row that is blocked after the change is refused.
   *
   * @param runId the run
   * @param itemId the row
   * @param edit the body of the `PATCH`
   * @param canPrice whether the staff member holds `storefront:update` (a reset of a row with a price choice needs it; the controller
   *   already refused the price keys without it)
   * @returns the row as the list shows it
   * @throws {AppError} `NOT_FOUND` (404: unknown run or row); `CONFLICT` (409: the run is not a draft, or the service is gone);
   *   `FORBIDDEN` (403: a reset would drop a typed price or a rule chosen over one, without `storefront:update`);
   *   `VALIDATION_FAILED` (422: `retailPrice` `invalid` or `below_floor`; `slug` `invalid` or `duplicate`; `pricing` `invalid`;
   *   `included` `blocked`; `retailPrice` or `reset` with `conflict`)
   */
  async edit(runId: number, itemId: number, edit: RowEdit, canPrice: boolean): Promise<PublishItemView> {
    return this.db.runInTransaction(async ({ tx }) => {
      const run = await shareRun(tx, runId);
      if (run === undefined) throw notFound('publish run');
      if (run.status !== 'draft') throw notADraft();
      const item = await lockPendingItem(tx, runId, itemId);
      if (item === undefined) throw notFound('row of this run');
      // Under the item lock: the choice a reset would drop is the one stored now.
      if (edit.reset === true && !canPrice && resetDropsPriceChoice(item)) throw missingPermission(PRICE_PERMISSION);

      const known = (await this.facts.read(tx, [item.serviceId])).get(item.serviceId);
      if (known === undefined) {
        throw new AppError('CONFLICT', { detail: 'This service is gone, so its row cannot be edited.' });
      }
      const listings = await listingNamesOfAll(tx);
      const others = await otherItemsOf(tx, runId, itemId);

      const own = nameKey(known.service.name);
      const listingTitles = new Set(listings.map((listing) => titleKey(listing.publicTitle)));
      const result = editRow(editableOf(item), edit, {
        facts: known.facts,
        price: known.price,
        naming: {
          name: known.service.name,
          type: namingTypeOf(known.service.type, known.service.hasMainInput),
          group: known.service.categoryName,
        },
        listingSlugs: new Set(listings.map((listing) => listing.slug)),
        otherSlugs: new Set(others.map((other) => other.slug)),
        titleTaken: (title) => {
          const key = titleKey(title);
          return (
            key !== '' &&
            (listingTitles.has(key) ||
              others.some((other) => titleKey(other.title) === key && nameKey(other.serviceName) !== own))
          );
        },
      });
      if (!result.ok) throw invalid(result.problems);

      await writeDraftRows(tx, runId, [result.row], this.clock.now());
      const row = await findItemRow(tx, runId, itemId);
      return (await itemViewsOf(tx, [row!]))[0]!;
    });
  }

  /**
   * Sets the tick or the facts of many rows of a draft.
   *
   * One transaction with the run row `FOR UPDATE` and the `draft` check under it. The tick is one set-based statement checked against the
   * stored state (a blocked row never takes it: `refused` counts them). A fact is written in pages of 500 rows: `reflag` recomputes the
   * flags that derive from the three facts and the state follows from the flags, in one `UPDATE ... FROM (VALUES ...)` per page, and the
   * row becomes `edited`. No price is read and no tick is moved by a fact.
   *
   * @param runId the run
   * @param select the rows: by id, or every row a filter matches
   * @param set the tick and the facts to set (at least one)
   * @returns how many rows changed, and how many could not take `included: true`
   * @throws {AppError} `NOT_FOUND` (404); `CONFLICT` (409: the run is not a draft); `VALIDATION_FAILED` (422 on `select.itemIds` with the
   *   code `invalid`: a row that is not in this run)
   */
  async bulk(runId: number, select: BulkSelect, set: BulkSet): Promise<{ changed: number; refused: number }> {
    return this.db.runInTransaction(async ({ tx }) => {
      const run = await lockRun(tx, runId);
      if (run === undefined) throw notFound('publish run');
      if (run.status !== 'draft') throw notADraft();

      let ids: number[];
      if ('itemIds' in select) {
        const wanted = [...new Set(select.itemIds)];
        ids = [];
        for (const page of pagesOf(wanted, ID_PAGE))
          ids.push(...(await itemsByIds(tx, runId, page)).map((row) => row.id));
        if (ids.length !== wanted.length) {
          throw invalid([
            { field: 'select.itemIds', code: 'invalid', message: 'Some of these rows are not in this run.' },
          ]);
        }
      } else {
        ids = await selectItemIds(tx, runId, select.filter);
      }

      const changed = new Set<number>();
      let refused = 0;
      if (set.included !== undefined) {
        for (const page of pagesOf(ids, ID_PAGE)) {
          if (set.included) refused += await countBlockedAmong(tx, runId, page);
          for (const id of await setIncluded(tx, runId, page, set.included)) changed.add(id);
        }
      }
      if (set.brand !== undefined || set.carrier !== undefined || set.country !== undefined) {
        const change: FactsChange = { brand: set.brand, carrier: set.carrier, country: set.country };
        const now = this.clock.now();
        for (const page of pagesOf(ids, FACTS_PAGE)) {
          const writes = [];
          for (const item of await itemsByIds(tx, runId, page)) {
            const next = withFacts({ ...editableOf(item), blockedReason: item.blockedReason }, change);
            if (next === null) continue;
            writes.push({
              id: item.id,
              brand: next.brand,
              carrier: next.carrier,
              country: next.country,
              flags: next.flags,
              state: next.state,
            });
            changed.add(item.id);
          }
          await writeFacts(tx, runId, writes, now);
        }
      }
      return { changed: changed.size, refused };
    });
  }
}
