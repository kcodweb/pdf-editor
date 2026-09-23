# PDF Worker

Free PDF tools that run entirely in your browser. Files are processed on your own device and never uploaded.

**Live site:** https://kcodweb.github.io/pdf-editor/
**Android app:** download the latest APK from [Releases](https://github.com/kcodweb/pdf-editor/releases).

## Tools

| Organize | Optimize | Convert | Edit & review | Security |
|---|---|---|---|---|
| Merge PDF | Compress PDF | Images → PDF | Edit PDF | Protect PDF |
| Split PDF | Grayscale PDF | Word → PDF | Sign PDF | Unlock PDF |
| Remove pages | OCR PDF | Excel → PDF | Fill PDF forms | Redact PDF |
| Extract pages | | PDF → JPG / PNG | Annotate PDF | |
| Organize pages | | PDF → Word | Add page numbers | |
| Rotate PDF | | PDF → Text | Add watermark | |
| Crop PDF | | | Compare PDF | |
| Pages per sheet | | | Edit PDF properties | |

Batch mode (many files in, one ZIP out) works with compress, PDF → JPG, PDF → Word, PDF → Text, protect, grayscale and pages per sheet.

### The editor

- Edit the PDF's existing text, reusing the original font when it has the characters you type. Rotated text (90°/180°/270°) can be edited too.
- Add text, drawings, highlights, shapes, stamps, images, signatures and comments.
- Use white-out, or real redaction that removes the content for good.
- Reorder, rotate, duplicate and delete pages, merge more files in and insert blank pages.
- Fill forms, run OCR on scans, and find text.
- Add page numbers, headers, footers and watermarks.
- Handles Arabic/Hebrew mixed with English (correct word order), CJK, Devanagari and emoji.
- Works on phones: touch toolbar, pinch zoom, long-press to reorder.
- Dark mode (follows the system, or choose Light/Dark/System).
- Long jobs show progress and can be cancelled.

## How it works

It's a static site: plain HTML, CSS and JavaScript, with no build step and no server.

| Library | Used for |
|---|---|
| [pdf.js](https://mozilla.github.io/pdf.js/) | Rendering and reading text |
| [pdf-lib](https://pdf-lib.js.org/) + fontkit | Writing PDFs and embedding fonts |
| [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) | Encryption and decryption, in a Web Worker |
| [docx](https://docx.js.org/) / [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | PDF ↔ Word |
| [SheetJS](https://sheetjs.com/) | Excel → PDF |
| [JSZip](https://stuk.github.io/jszip/) | ZIP downloads |
| [Tesseract.js](https://tesseract.projectnaptha.com/) | OCR (loaded from jsDelivr on first use) |

The libraries are kept in `vendor/`. Fonts in `fonts/` are open-licensed (Noto, Liberation, Carlito, Caladea and Dancing Script).

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Page markup and styles (home, tools and editor) |
| `hub.js` | Tool catalog, routing and the single-tool screens |
| `app.js` | Editor: state, rendering, tools, undo, zoom, theme |
| `touch.js` | Touch gestures |
| `textlayer.js` | Reading existing text, edit text, search, OCR |
| `export.js` | Building the final PDF, split, images, compression |
| `tools2.js` | Crop, pages per sheet, grayscale, metadata, Excel → PDF, compare |
| `convert.js` | PDF ↔ Word, PDF → Text (including table detection) |
| `fonts.js` | Font loading, script fallback and right-to-left ordering |
| `forms.js`, `decor.js`, `signature.js`, `secure.js` | Forms; page numbers and watermarks; signatures; passwords |
| `native.js` | Android integration (save, share, open-with, back button) |
| `sw.js` | Service worker for offline use |

## Run locally

Any static file server works:

```bash
python -m http.server 8765
```

Then open http://localhost:8765/.

## Tool pages (SEO)

Each tool has its own indexable page, for example `merge-pdf/index.html`, along with `sitemap.xml`, `robots.txt`, `tool-slugs.js` and the preview images in `og/`. They are all **generated** from `index.html` and `scripts/seo-data.json`:

```bash
npm run pages
```

Run this after any change to `index.html` or `seo-data.json` and commit the output, because GitHub Pages serves the repo as-is. When you add a tool to `hub.js`, add it to `seo-data.json` too. `make_og.py` needs Pillow.

## Deploying

- **Website:** every push to `main` is published by GitHub Pages. Bump `VERSION` in `sw.js` when app files change so returning visitors pick up the update.
- **Android:** `.github/workflows/android.yml` runs on every push.
  - It copies the site into `www/` (`npm run build:web`) and syncs it into the Capacitor project in `android/`.
  - It builds a signed APK and publishes it as the release `android-v1.0.<run number>`.
  - The signing key comes from repository secrets. Keep using the same key, or installed apps can't be updated.

To build the Android project yourself:

```bash
npm install
npm run sync
```

Then open `android/` in Android Studio.

## Privacy

Everything happens on your device. The only network requests are for the app's own files, plus the OCR engine and language data (from jsDelivr) the first time you run OCR.
