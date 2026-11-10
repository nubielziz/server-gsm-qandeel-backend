# Feature 24E: Arabic in PDFs (ROADMAP phase 5; D6 §8, D-14)

Plan by Fable 5.2 (planner), 2026-11-10, against backend `main` @ `bd32229`. Implementer: one Sonnet 5.5, slices A to C,
**A is a spike with a go/no-go gate**. Worktree `../backend-24e` on `feat/backend-24e`, test database `gsm_24e_test`, Redis
DB 11 (LEAD-DECISIONS §1). No route, no table, no console change, no W0 dependency: it may branch from `main` at once. Read
first: `backend/CLAUDE.md`, `docs/briefs/_common.md` (its frontend-cwd and Serena lines are stale), `CONTRIBUTING.md`,
`docs/decisions/030-pdf-rendering.md`. Paths are backend-relative.

Rules (LEAD-DECISIONS §7): work only in the worktree; never run `docker compose`, `db:migrate`, `db:seed`, `src/main.ts` or
`scripts/ci.sh` there; no git command that changes state; no agents. Packages with `bun add` only, none with install scripts.
Targeted tests while developing, `bun run check` once at the end in the foreground.

## 1. What exists and what is missing

| # | Requirement | Status | Evidence (verified in the code) |
|---|---|---|---|
| 1 | Arabic text in generated PDFs | missing | One renderer, `src/modules/platform/pdf/pdf-renderer.ts` (pdf-lib `1.17.1`), embeds only `StandardFonts.Helvetica` and `HelveticaBold` (`:118,123-126`); `printable()` turns every character the font cannot encode into `?` (`:42-53`); decision 030: "Arabic shaping is out of scope" |
| 2 | Every document goes through it | exists | The only callers are `money/application/invoice-documents.ts:44`, `order-receipts.ts:108`, `client-statement.service.ts:82` (document built in `money/domain/client-statement.ts`) and `dispute.service.ts:141`; all pass a `PdfDocument` (`title`, `subtitle`, `blocks`, `footer`) to `PdfRenderer.render`. Changing the renderer covers invoices, receipts, statements and dispute evidence with **no caller change** |
| 3 | Where text is measured and drawn | exists | `Sheet.wrap` (word wrap by `font.widthOfTextAtSize`), `fit` (ellipsis), `title`, `block` (`heading`, `text`, `facts`, `table`), `footers`: every draw is `page.drawText(string, { font })` |
| 4 | Font engine | missing | No `@pdf-lib/fontkit`, no font file in the repo. The site uses IBM Plex Sans Arabic through `next/font/google` (`storefront/app/[lang]/layout.tsx:5,21`), so there is no local file to reuse |
| 5 | What pdf-lib does with a custom font | verified in `node_modules/pdf-lib/cjs/core/embedders` | `CustomFontEmbedder.encodeText` and `widthOfTextAtSize` both call `this.font.layout(text, this.fontFeatures)` (fontkit's layout engine: GSUB shaping, and it reverses a right-to-left run) and sum `glyph.advanceWidth` (`CustomFontEmbedder.js:51-66`); the subset embedder includes exactly the laid-out glyphs (`CustomFontSubsetEmbedder.js:36-40`); `customName` replaces the random font-name suffix (`:89`). So shaping happens inside `drawText`, **per string**; what pdf-lib does not do is split a mixed string into directional runs (bidi), and it ignores GPOS offsets |
| 6 | Packages (registry, 2026-11-10) | available | `@pdf-lib/fontkit` 1.1.1 (dependency `pako`, no install script; the package pdf-lib's README names), `bidi-js` 1.1.0 (MIT, UAX #9 implementation, dependency `require-from-string`, no install script). `fontkit` 2.0.4 is the fallback engine |

## 2. Design

### 2.1 Approach

1. **Latin stays exactly as it is.** Text Helvetica can encode is still drawn with the standard Helvetica fonts. A document
   with no other character embeds nothing new and must come out **byte-identical** to today (test).
2. **An Arabic-capable font is embedded only when a document needs it**, as a subset: IBM Plex Sans Arabic Regular and Bold
   (SIL OFL 1.1), the site's Arabic face. A pre-scan of the document's strings decides which weights are needed before any
   drawing (embedding is asynchronous, drawing is not).
3. **Bidirectional order is resolved by `bidi-js`** per line (UAX #9: wrap first in logical order, then reorder each line),
   giving visual runs; **shaping is fontkit's** inside `drawText`, one call per run, so contextual forms and lam-alef come
   from the font's GSUB tables.
4. The document layout stays left-to-right with English labels (the templates are English); Arabic appears as data
   (names, companies, service titles, notes). Right-aligned table columns stay right-aligned.

### 2.2 New files in `src/modules/platform/pdf/`

- `fonts/IBMPlexSansArabic-Regular.ttf`, `fonts/IBMPlexSansArabic-Bold.ttf`, `fonts/OFL.txt`, `fonts/README.md` (source:
  the official IBM Plex release on GitHub `IBM/plex`, the release tag, each file's SHA-256, the license name). TrueType
  files (`.ttf`), not WOFF. They live under `src/` so they ship with the code in any image (feature 24D copies `src/`).
  Do not add the `@ibm/plex*` npm packages (they carry a telemetry postinstall script). If `bun run format:check` trips on
  the binary files, add `*.ttf` to `.prettierignore`.
- `pdf-fonts.ts`: `ArabicFonts` (plain class, no Nest dependency): reads the two files once (path from `import.meta.url`),
  keeps the bytes and one parsed fontkit font per weight for coverage and direction questions:
  `covers(codePoint): boolean` (`hasGlyphForCodePoint`), `laysOutRightToLeft(text): boolean` (`layout(text).direction === 'rtl'`),
  `bytes(weight)`.
- `text-runs.ts` (pure functions, the heart of the feature):
  - `classify(text, canLatin, canArabic): string`: whitespace collapsed as today; bidi control characters (U+200E, U+200F,
    U+202A to U+202E, U+2066 to U+2069) removed after they were used for levels; a character neither font can draw becomes
    `?` (emoji, CJK: unchanged behaviour).
  - `visualRuns(line): VisualRun[]` with `VisualRun { text: string; font: 'latin' | 'arabic'; level: number }`, in
    left-to-right drawing order: embedding levels from `bidi.getEmbeddingLevels(line, 'auto')` (base direction from the
    first strong character); level runs split further by font (a run of odd level is drawn whole with the Arabic font so
    its spaces and punctuation stay inside one shaping call; an even run uses Helvetica where it can encode and the Arabic
    font otherwise, e.g. Arabic-Indic digits); runs ordered by rule L2; each run's `text` is its **logical** substring.
  - Per run, reconcile with what fontkit will do: let `want = level is odd`, `does = fonts.laysOutRightToLeft(text)` (only
    asked for Arabic-font runs; Helvetica never reverses). `want && !does` (an odd run without Arabic letters): reverse the
    code points before drawing. `!want && does`: reverse them so fontkit's own reversal restores the logical order.
  - Mirroring (parentheses and brackets at odd levels): `bidi.getMirroredCharactersMap`, applied only when the font does not
    do it itself (`availableFeatures` lacks `rtlm`); the spike decides and a test pins the result.
- `types/` declarations if the two packages ship none (`declare module '@pdf-lib/fontkit'`, `'bidi-js'` with the four
  functions used), next to the code that uses them.

### 2.3 Changes in `pdf-renderer.ts` (public types `PdfDocument`, `PdfBlock`, `PdfColumn` and `render` unchanged)

- `render`: pre-scan `title`, `subtitle`, every block string and `footer` → `needsArabic: { regular, bold }` (bold for the
  title, headings, fact values and table headers). When either is true: `pdf.registerFontkit(fontkit)` and
  `pdf.embedFont(bytes, { subset: true, customName: 'GSMArabic-Regular' | 'GSMArabic-Bold' })`. Otherwise the code path and
  the output are today's.
- `Sheet` gains `measure(text, size, weight)` (sum of the runs' widths, each with its own font) and
  `draw(text, x, y, size, color, weight)` (the runs left to right, advancing `x` by each run's width). `wrap`, `fit`, the
  right-aligned cell position and every `drawText` call go through these two; `printable` is replaced by `classify`.
  `wrap` and `fit` keep working on the logical string (the ellipsis is appended logically, so it lands on the correct side).
- The document title in the PDF properties is written as given (pdf-lib stores it as Unicode); for a Latin title the
  value is unchanged.
- `PdfRenderer` holds one `ArabicFonts` (created lazily on the first document that needs it).
- TSDoc and the class comment: what is supported and the limits of §2.4. Update `docs/decisions/030-pdf-rendering.md`
  (an "Amended 2026-11" paragraph: Arabic through fontkit + bidi-js + an embedded OFL font; the last "Consequences" sentence
  no longer holds) and the PDF part of `src/modules/platform/README.md`.

### 2.4 Known limits (write them in the decision and the README)

- Combining marks (harakat) are drawn at the font's default position: pdf-lib ignores GPOS anchors. Names and titles
  rarely carry them.
- Text extraction (copy and paste, search) of Arabic from the PDF may be imperfect: pdf-lib maps only glyphs that have a
  code point in the font's cmap. The page looks right; the tests therefore check glyphs, not extracted text.
- The page layout is not mirrored and the labels are English: a fully Arabic document template is a separate feature.
- Scripts other than Latin and Arabic still print `?`.
- A PDF with Arabic grows by the two font subsets (tens of kilobytes) and costs one font parse per render.

## 3. Database and API

None: no migration, no route, no contract, no error code. The four PDF routes keep their contracts and headers.

## 4. Admin console

None.

## 5. Risks and how the design closes them

| Area | Risk | Closure |
|---|---|---|
| Correctness | fontkit 1.1.1 shapes or orders a case wrongly, or subsetting drops a shaped glyph ("subsetting does not work for all fonts", pdf-lib README) | slice A proves every case of §7 before any renderer change; fallbacks in order: `fontkit` 2.0.4 as the registered engine; `subset: false`; otherwise stop with `BLOCKED` (do not hand-roll shaping) |
| Compatibility | Latin documents change (stored invoices and receipts are compared or re-downloaded) | Helvetica stays the Latin font; nothing is embedded without need; a golden test compares the bytes of a Latin fixture with the hash recorded on `main` before the change |
| Financial | Amount columns shift or digits reorder inside Arabic text | digits and Latin are even-level runs drawn left to right in Helvetica with unchanged widths; tests cover an Arabic memo with an invoice number, a date and an amount |
| Security | A user-controlled name uses bidi override characters to disguise text in a document (e.g. reversing an amount) | bidi control characters are stripped before drawing; base direction is derived per string, never taken from input markers |
| Security | Font parsing of untrusted data | the fonts are two vetted files in the repository with recorded hashes; no user file reaches fontkit |
| Performance | Invoice PDFs are rendered right after the commit of a request (`work.afterCommit(() => documents.render(…))`) | the Arabic path runs only for documents with Arabic; font bytes and parsed fonts are cached in the process; measured in the spike (target: under 100 ms extra for a one-page invoice). Moving invoice rendering to a job is **out of scope** (the money files belong to feature 21): recorded in §8 |
| Licensing | Shipping a font | SIL OFL 1.1 allows bundling and embedding; the license file sits beside the fonts; the font is not renamed or modified (a subset embedded in a PDF is allowed) |
| Build | The files are missing in a container or a worktree | under `src/`, read relative to the module; a unit test loads both files and checks their recorded SHA-256 |

## 6. Slices

**A. Spike (small, go/no-go; no renderer change).** `bun add @pdf-lib/fontkit bidi-js`; add the font files; write
`pdf-fonts.ts`, `text-runs.ts` and their specs (the shaping and ordering cases of §7); one throwaway-free spec that draws
Arabic with `PDFDocument` + `registerFontkit` + `embedFont(…, { subset: true, customName })` and checks the glyph counts in the
content stream. Record in the report: the engine used, whether subsetting works, whether the font mirrors by itself, the
render time. **Gate:** all cases green → continue; else the fallbacks of §5, else `BLOCKED: <which case fails>`.

**B. Renderer (medium).** Edit `pdf-renderer.ts` as §2.3; first record the SHA-256 of the Latin fixture rendered by the
unchanged renderer (run the new golden test once before editing and paste the hash into it). Acceptance: the golden test
passes after the change; every block kind draws Arabic, mixed and Latin text; wrapping, truncation, right alignment and
page breaks work with mixed text; no `?` for any Arabic letter, Arabic-Indic digit or Arabic punctuation.

**C. Documents and docs (small).** Integration checks through the four callers (no code change there), decision 030,
platform README, `package.json`/`bun.lock`. Acceptance: an invoice, a receipt, a statement and a dispute evidence file for
a merchant or customer with an Arabic name render with the Arabic font embedded.

Finish: `bun run format`, `bun run check` (foreground). Report: the gate result, files by folder, the limits of §2.4.

## 7. Tests

| File | Covers |
|---|---|
| `src/modules/platform/pdf/text-runs.spec.ts` | pure Arabic `سلام`: one Arabic run, level 1; pure Latin: one Latin run; `Order 123 for محمد علي (VIP)`: Latin, Arabic (the two words in one run, space inside), Latin, in that visual order; base-RTL `فاتورة INV-2026-0001 بتاريخ 2026-11-10`: the Arabic words on the right, the number and the date reading left to right between them; Arabic-Indic digits `٢٠٢٦` stay in logical order; parentheses around Arabic face the right way; bidi controls (U+202E) are removed and cannot reorder `100.00`; emoji and CJK become `?`; whitespace collapses as before |
| `src/modules/platform/pdf/pdf-fonts.spec.ts` | both files load and match their recorded SHA-256; **shaping**: for `سلام` the glyph ids of `layout()` differ from the nominal cmap glyphs of its letters (contextual forms) and the run is right-to-left; `لا` lays out as one glyph (lam-alef); coverage of the Arabic block, Arabic punctuation (`،` `؛` `؟`) and Arabic-Indic digits |
| `src/modules/platform/pdf/pdf-renderer.spec.ts` (extend; replace the "prints ? instead of failing" case for Arabic, keep it for emoji) | **golden**: a Latin-only document's SHA-256 equals the recorded one; a document with Arabic in the title, a heading, a fact value, a table cell, a text block and the footer: loads with pdf-lib, has Type0 fonts named `GSMArabic-Regular` and `GSMArabic-Bold`, and the decoded content streams (pdf-lib `decodePDFRawStream`) hold, under the Arabic font, hex strings of exactly 4 hex digits per expected glyph (`لا` → 1 glyph, `سلام` → 3 with the ligature or the count the spike recorded) and never the `?` glyph for an Arabic input; a Latin-only document has no `GSMArabic` font; a long mixed paragraph wraps and paginates; a right-aligned cell with Arabic ends at the column edge (`measure` equals the drawn width); `fit` truncates a long Arabic cell within the width; rendering the same Arabic document twice gives the same bytes |
| `test/integration/` (extend the existing invoice, receipt, statement and dispute-evidence tests, one case each) | a merchant or customer named in Arabic: the produced PDF embeds `GSMArabic-*`; the stored receipt is still served from its stored copy |

## 8. Decisions

Owner decisions taken with defaults: the PDF Arabic face is **IBM Plex Sans Arabic** (the site's; OFL), embedded only in
documents that contain Arabic; documents keep their English labels and left-to-right layout.

Spec decisions for the lead: decision 030 is amended (Arabic data is rendered: `@pdf-lib/fontkit` shaping, `bidi-js`
ordering, an embedded OFL font subset, Latin unchanged; limits: mark positioning, text extraction, no mirrored layout). No
B-entry is needed (no contract change). New dependencies: `@pdf-lib/fontkit`, `bidi-js` (the lead re-runs `bun install` at
merge; feature 24D also edits `package.json`).

Out of scope, recorded: **moving invoice rendering into a job** (D6 §9; the money files that call the renderer are feature
21's: do it after 21 if render time matters); Arabic document templates (translated labels, mirrored tables), which would
need a `locale` on `PdfDocument` and changes in the four money callers; other scripts; perfect harakat placement (a
HarfBuzz-based drawer).

## 9. Storefront handoff

None. Receipt and invoice downloads keep their routes, headers and file names; Arabic names and titles inside them now
print as Arabic instead of `?`.

## 10. Review against the code, and approval

Checked in the code: every line of `pdf-renderer.ts`, its spec and module; all four callers and that none shapes or strips
text itself; pdf-lib's `CustomFontEmbedder` and `CustomFontSubsetEmbedder` in `node_modules` (layout-based encoding and
width, glyph inclusion, `customName`); `package.json` (pdf-lib 1.17.1, no fontkit); the site's font setup; the registry
entries of the three packages. pdf-lib's embedding options were confirmed through Context7 (`/hopding/pdf-lib`:
`registerFontkit`, `embedFont(bytes, { subset, customName, features })`, "subsetting does not work for all fonts").

Correction to D6 §8: it says pdf-lib's documentation covers "custom-font embedding through fontkit only, not Arabic shaping
or bidi" and asks for a spike. The source shows shaping **is** applied (pdf-lib encodes text through fontkit's `layout`);
what is missing is bidi run splitting, which this plan adds. The spike stays, because fontkit 1.1.1's Arabic shaper,
subsetting with this font and mirroring are unproven until the cases of §7 run.

**Approved by Fable 5.2**
