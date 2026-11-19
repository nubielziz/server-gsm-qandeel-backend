// Brand detection of the shop naming (feature 31, plan section 3.5; A3 section 4): an app or store named in the title, else the
// tool of a server service, else the device maker. Pure; a row's brand depends on that row alone (the tool list is frozen data).
import { APP_BRANDS, DEVICE_BRANDS } from './lexicon/brands';
import { GROUP_NOISE, KNOWN_TOOLS, NAME_BRAND_GROUPS, TOOL_ALIASES } from './lexicon/tools';
import { type NamingKind, titleCaseIfShouting } from './title-rules';

/** What a brand is: a device maker, a server tool, or an app or store. */
export type BrandKind = 'device' | 'tool' | 'app';

/** The brands of {@link BrandKind}, for checks and filters. */
export const BRAND_KINDS: readonly BrandKind[] = ['device', 'tool', 'app'];

/** A detected brand and its kind. */
export interface DetectedBrand {
  /** The brand as the shop shows it (`Apple`, `Chimera Tool`, `iTunes`). */
  readonly name: string;
  /** Its kind. */
  readonly kind: BrandKind;
}

/** A group longer than this, or holding `/`, `,` or `|`, is a feature list rather than a tool's name. */
const LISTY_GROUP_LENGTH = 45;

/** Tells whether a group text is a list of features or makers rather than one tool's name. */
function isListyGroup(group: string): boolean {
  return /[/,|]/.test(group) || group.length > LISTY_GROUP_LENGTH;
}

/**
 * The tool brand a server group names (`Chimera Tool - Direct Source Services` gives `Chimera Tool`): brackets, emoji and the
 * supplier's noise words removed, merged by the alias list, Title Case when shouting.
 *
 * Why: A3 section 4: 322 of the 394 tool brands come from the group, the tool's shop at the supplier.
 *
 * @param group the group text as {@link groupText} gives it
 * @returns the tool's name; `''` when nothing is left
 */
export function toolFromGroup(group: string): string {
  let g = group
    .replace(/\s*[[(].*?[\])]\s*/g, ' ')
    .replace(/\s+-\s+(?:Direct Source|Free |Tool$).*$/i, '')
    .replace(GROUP_NOISE, ' ');
  g = g
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,.\-/]+$/, '')
    .replace(/\s+(?:Tool Pro)$/i, ' Tool Pro');
  for (const [pattern, tool] of TOOL_ALIASES) if (pattern.test(g)) return tool;
  return titleCaseIfShouting(g);
}

/** The app named earliest in the text, if any. */
function earliestApp(title: string): string | null {
  let best: { at: number; brand: string } | null = null;
  for (const [brand, pattern] of APP_BRANDS) {
    const match = pattern.exec(title);
    if (match !== null && (best === null || match.index < best.at)) best = { at: match.index, brand };
  }
  return best?.brand ?? null;
}

/** The tool of a server service, from its group, the frozen tool list, or the head of its name. */
function serverTool(title: string, group: string): string | null {
  const listy = isListyGroup(group);
  if (!NAME_BRAND_GROUPS.has(group) && !listy) {
    const tool = toolFromGroup(group);
    if (tool !== '') return tool;
  }
  const lower = title.toLowerCase();
  const known = KNOWN_TOOLS.find((tool) => lower.includes(tool.toLowerCase()));
  if (known !== undefined) return known;
  if (listy) {
    // "Android Auth Tool AAT - AUTO API ..." gives "Android Auth Tool AAT".
    const head = title
      .replace(/[[(].*$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+-\s+| Credits?\b| Activation\b/i)[0];
    if (head !== undefined && head.length >= 3) {
      const short = head.replace(/\s+\d+\s*(?:months?|years?|pcs?|pc)\b.*$/i, '').replace(/\s+(?:new|renew)$/i, '');
      for (const [pattern, tool] of TOOL_ALIASES) if (pattern.test(short)) return tool;
      if (short.length <= 40) return short;
    }
  }
  return null;
}

/** The single device maker the text names, or `null` for none or several. */
function deviceMaker(text: string): { readonly maker: string | null; readonly named: number } {
  const makers = [...new Set(DEVICE_BRANDS.filter(([, pattern]) => pattern.test(text)).map(([brand]) => brand))];
  if (makers.length === 1) return { maker: makers[0] ?? null, named: 1 };
  if (
    makers.length === 2 &&
    makers.includes('Apple') &&
    !makers.includes('Samsung') &&
    /\b(?:iphone|ipad|icloud|fmi)\b/i.test(text) &&
    !/\bandroid|generic\b/i.test(text)
  ) {
    // An iPhone service that also names one other maker's word (a tool name, a model) is still an Apple service.
    return { maker: 'Apple', named: 2 };
  }
  return { maker: null, named: makers.length };
}

/**
 * Detects the brand of one service.
 *
 * Why: plan section 3.5, A3 section 4: (1) an app or store named in the title, the earliest match winning; (2) for a server
 * service the tool: from the group, unless the group is a shop-like or a feature-list group, else from the frozen tool list or
 * the head of the name; (3) the device maker named in the title, else in the group; none when several makers are named. The
 * traps (`Nothing Tool`, `Kyocera Phone`, `Apple ID ... Microsoft Mail`, `Dhru Fusion - Telegram`, `Knoxwizard`) are unit tests.
 *
 * @param title the title before the cut (rules R1-R12)
 * @param group the group text as {@link groupText} gives it
 * @param kind the family of rules of the service type
 * @returns the brand and its kind, or `null` when nothing matches (the preview shows the gap; the rules never guess)
 */
export function detectBrand(title: string, group: string, kind: NamingKind): DetectedBrand | null {
  const app = earliestApp(title);
  if (app !== null) return { name: app, kind: 'app' };
  if (kind === 'server') {
    const tool = serverTool(title, group);
    if (tool !== null) return { name: tool, kind: 'tool' };
  }
  const fromTitle = deviceMaker(title);
  if (fromTitle.maker !== null) return { name: fromTitle.maker, kind: 'device' };
  if (fromTitle.named > 1) return null;
  const fromGroup = deviceMaker(group);
  return fromGroup.maker !== null && fromGroup.named === 1 ? { name: fromGroup.maker, kind: 'device' } : null;
}
