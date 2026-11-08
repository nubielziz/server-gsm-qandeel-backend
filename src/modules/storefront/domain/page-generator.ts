// The pure rules of the landing-page generator (feature 19, RESOLUTIONS b2c-15, endpoint doc `POST /admin/content-pages/generate`): how the
// typed lists become model x network combinations, what each draft looks like, and when a run is refused. No database, no clock.
import { slugOf } from './slug';

/** The most new drafts one run creates; more refuses the whole run (b2c-15: a code constant, no setting, no console field). */
export const STOREFRONT_GENERATE_MAX_PER_RUN = 50;

/**
 * The most combinations one run looks at.
 *
 * Why: a safety bound, not a rule: "all brands x all models x all networks" of a big TAC catalogue would otherwise read and test millions
 * of slugs. 20 000 is far above the 50 new drafts a run may make plus the pages that already exist.
 */
export const STOREFRONT_GENERATE_MAX_COMBINATIONS = 20_000;

/** The language and kind of every generated draft (the mock and the endpoint doc: `en`, `model`). */
export const GENERATED_LOCALE = 'en';

/** A model with the brand the catalogue (or the request) puts it under. */
export interface ModelRef {
  readonly brand: string;
  readonly name: string;
}

/** One draft to create. */
export interface Combination {
  readonly brand: string;
  readonly model: string;
  readonly network: string;
  readonly title: string;
  readonly slug: string;
}

/**
 * Cleans a typed list.
 *
 * Why: the endpoint doc says the lists are "split on commas and new lines, trimmed". The console splits already; the server splits again
 * so a client that sends one text per list gets the same result. Blank entries go, and a repeat (ignoring case) keeps its first spelling.
 *
 * @param values the entries as sent
 * @returns the entries trimmed, split, without blanks or repeats
 */
export function cleanList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    for (const part of value.split(/[,\r\n]+/)) {
      const text = part.trim();
      const key = text.toLowerCase();
      if (text === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  }
  return out;
}

/** What the catalogue knows about the models of the request, in the shape {@link resolveModels} reads. */
export interface CatalogueNames {
  /** Every (brand, name) of the chosen brands, or of all brands when none was typed; used when no model was typed. */
  readonly ofBrands: readonly ModelRef[];
  /** Every (brand, name) whose name is one of the typed models, whatever the brand; used to find a typed model's brand. */
  readonly ofNames: readonly ModelRef[];
}

/**
 * Works out the models of a run and the brand each belongs to.
 *
 * Why: the endpoint doc: with no models typed, the catalogue's marketing names (else model) of the chosen brands; with models typed, those
 * models (a typed model that is not in the catalogue is generated as well). The brand goes into `template_params`: the catalogue's brand
 * for a model it knows (the chosen brand first when two brands share a name), else the one brand that was typed, else empty.
 *
 * @param brands the typed brands (cleaned)
 * @param models the typed models (cleaned)
 * @param catalogue what the catalogue returned
 * @returns the models in the order they are generated (typed order, or brand then name)
 */
export function resolveModels(
  brands: readonly string[],
  models: readonly string[],
  catalogue: CatalogueNames,
): ModelRef[] {
  if (models.length === 0) return [...catalogue.ofBrands];
  const chosen = new Set(brands.map((brand) => brand.toLowerCase()));
  return models.map((typed) => {
    const known = catalogue.ofNames.filter((entry) => entry.name.toLowerCase() === typed.toLowerCase());
    const entry = known.find((candidate) => chosen.has(candidate.brand.toLowerCase())) ?? known[0];
    if (entry) return entry;
    return { brand: brands.length === 1 ? brands[0]! : '', name: typed };
  });
}

/**
 * The title of a draft.
 *
 * @param model the model name
 * @param network the carrier
 * @returns `Unlock <model> on <network>` (the endpoint doc)
 */
export function draftTitle(model: string, network: string): string {
  return `Unlock ${model} on ${network}`;
}

/**
 * The short Markdown body of a draft.
 *
 * Why: the mock writes `Draft for review.`; a few lines more give the reviewer the shape of the page without pretending to be final text.
 *
 * @param combination the draft
 * @returns the Markdown
 */
export function draftBody(combination: Combination): string {
  const device = combination.brand === '' ? combination.model : `${combination.brand} ${combination.model}`;
  return (
    `# ${combination.title}\n\n` +
    `Draft for review. Explain how to unlock the ${device} locked to ${combination.network} with its IMEI: ` +
    'what the buyer needs, how long it takes and what to do after the unlock.\n'
  );
}

/** What {@link combinationsOf} produced. */
export interface Combinations {
  /** The distinct drafts, by model then network. A combination whose slug an earlier one of the run has is merged into it, not counted. */
  readonly drafts: Combination[];
  /** The first model or network whose title makes no slug (no Latin letter or digit), if any. */
  readonly unusable?: { readonly field: 'models' | 'networks'; readonly value: string };
}

/** The models of a run split by whether their name can make a slug. */
export interface ModelSplit {
  /** The models whose name has at least one Latin letter or digit. */
  readonly usable: ModelRef[];
  /** The models whose name cannot make a slug. */
  readonly unusable: ModelRef[];
}

/**
 * Splits models into those whose name can make a web address and those that cannot.
 *
 * Why: a model name from the TAC catalogue is data the caller cannot fix, so one name with no Latin letter or digit (`هاتف`) must not
 * refuse a whole "all models" run: the run skips it and counts it. A name the caller typed is a mistake the caller can fix, so the use
 * case does not use this split for typed models (it answers `422` on `models`, see {@link combinationsOf}).
 *
 * @param models the models of the run
 * @returns the models that can make a slug and the ones that cannot, each in the order given
 */
export function splitUsableModels(models: readonly ModelRef[]): ModelSplit {
  const named: ModelRef[] = [];
  const unnamed: ModelRef[] = [];
  for (const model of models) (slugOf(model.name) === '' ? unnamed : named).push(model);
  return { usable: named, unusable: unnamed };
}

/** The networks of a run split by whether their name can make a slug. */
export interface NetworkSplit {
  /** The networks whose name has at least one Latin letter or digit. */
  readonly usable: string[];
  /** The networks whose name cannot make a slug. */
  readonly unusable: string[];
}

/**
 * Splits networks into those whose name can make a web address and those that cannot.
 *
 * Why: the carriers of an "all networks" run come from the service listings, data the caller cannot fix in this request, so one carrier
 * with no Latin letter or digit must not refuse the whole run: it is skipped and counted, like a catalogue model (see
 * {@link splitUsableModels}). A network the caller typed is a mistake the caller can fix, so the use case does not use this split for
 * typed networks (it answers `422` on `networks`, see {@link combinationsOf}).
 *
 * @param networks the carriers of the run
 * @returns the carriers that can make a slug and the ones that cannot, each in the order given
 */
export function splitUsableNetworks(networks: readonly string[]): NetworkSplit {
  const named: string[] = [];
  const unnamed: string[] = [];
  for (const network of networks) (slugOf(network) === '' ? unnamed : named).push(network);
  return { usable: named, unusable: unnamed };
}

/**
 * Builds the model x network combinations.
 *
 * @param models the models of the run
 * @param networks the networks of the run
 * @returns the distinct drafts (repeats of a slug inside the run are merged), and a name that cannot make a slug
 */
export function combinationsOf(models: readonly ModelRef[], networks: readonly string[]): Combinations {
  for (const model of models) if (slugOf(model.name) === '') return unusable('models', model.name);
  for (const network of networks) if (slugOf(network) === '') return unusable('networks', network);
  const seen = new Set<string>();
  const drafts: Combination[] = [];
  for (const model of models) {
    for (const network of networks) {
      const title = draftTitle(model.name, network);
      const slug = slugOf(title);
      if (seen.has(slug)) continue;
      seen.add(slug);
      drafts.push({ brand: model.brand, model: model.name, network, title, slug });
    }
  }
  return { drafts };
}

function unusable(field: 'models' | 'networks', value: string): Combinations {
  return { drafts: [], unusable: { field, value } };
}

/**
 * The sentence a run over the cap is refused with.
 *
 * @param newPages how many new drafts the run would create
 * @returns b2c-15's text
 */
export function overCapDetail(newPages: number): string {
  return `This run would create ${newPages} pages; the limit is ${STOREFRONT_GENERATE_MAX_PER_RUN} per run. Narrow the lists.`;
}
