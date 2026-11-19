# Fonts of the PDF renderer

The Arabic-capable font of `PdfRenderer` (decision 030, amended by feature 24E). Latin text uses the standard Helvetica, which
needs no file; these files are embedded (as a subset) only in a document that contains Arabic.

| File | Weight | SHA-256 |
|---|---|---|
| `IBMPlexSansArabic-Regular.ttf` | Regular | `8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981` |
| `IBMPlexSansArabic-Bold.ttf` | Bold | `b74f809dead12442ed56e02a12c3bcc02076c9ad4e32f17d0a9ca6fc1aafc89e` |
| `OFL.txt` | License | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` |

- **Font:** IBM Plex Sans Arabic (the storefront's Arabic face), © 2017 IBM Corp., Reserved Font Name "Plex".
- **License:** SIL Open Font License 1.1 (`OFL.txt`, the release's `LICENSE.txt`, byte for byte). The files are not renamed or
  modified; embedding a subset in a PDF is allowed by the license.
- **Source:** the official IBM Plex release on GitHub, tag `@ibm/plex-sans-arabic@1.1.0` (2024-11-13), asset
  `ibm-plex-sans-arabic.zip` (SHA-256 `f03915581aea37d82792c188b08064023a73494d679b8e19f85f5971db714013`), files
  `ibm-plex-sans-arabic/fonts/complete/ttf/IBMPlexSansArabic-{Regular,Bold}.ttf` and `ibm-plex-sans-arabic/LICENSE.txt`.
  The `@ibm/plex*` npm packages are not used (they run a postinstall script).
- **Checked by:** `test/unit/modules/platform/pdf/pdf-fonts.spec.ts` (the hashes above, as recorded in `ARABIC_FONT_FILES` of `pdf-fonts.ts`).

To update a font: download the new release asset, replace the file, and update the hash here and in `pdf-fonts.ts`; the
renderer and text-run tests then show whether shaping still holds.
