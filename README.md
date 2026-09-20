# PaperTooling

A PDF stripper: a client-side PDF tool that lets you select pages, compress, and download. All processing happens in your browser—files never leave your device.

## Usage

1. **Drop a PDF** onto the page or click to choose a file.
2. **Set options** (before upload): Choose quality preserved (90–99%, higher = larger files) and optionally enable grayscale for smaller output.
3. **Stage 1 – Select pages**: Choose which pages to keep and pick a key page for quality comparison. Compression runs in the background; each thumbnail shows before/after size as it completes.
4. **Stage 2 – Compress** (if needed): If you continue before background compression finishes, remaining pages compress on demand.
5. **Stage 3 – Download**: Download the compressed PDF and optionally compare the key page before/after in side-by-side windows.

## Features

- **Quality slider**: 90–99% JPEG quality (default 97%)
- **Grayscale option**: Convert to grayscale for smaller files (typically 20–40% reduction on text/scanned docs)
- **Background compression**: Starts as soon as you upload; per-page before/after sizes appear on thumbnails
- **Key page comparison**: Open before/after views in a new window

## Deployment

Static site for GitHub Pages. No build step required. Push to the repo and enable GitHub Pages (source: main branch, root).

## Tech

- [PDF.js](https://mozilla.github.io/pdf.js/) – load and render PDFs
- [pdf-lib](https://pdf-lib.js.org/) – create and modify PDFs
