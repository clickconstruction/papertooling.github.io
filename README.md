# PDF Tooling

A client-side PDF tool that lets you select pages, compress at 97% quality, and download. All processing happens in your browser—files never leave your device.

## Usage

1. **Drop a PDF** onto the page or click to choose a file.
2. **Stage 1 – Select pages**: Choose which pages to keep and pick a key page for quality comparison.
3. **Stage 2 – Compress**: The app compresses selected pages at 97% JPEG quality.
4. **Stage 3 – Download**: Download the compressed PDF and optionally open the key page before/after in new windows to judge quality.

## Deployment

Static site for GitHub Pages. No build step required. Push to the repo and enable GitHub Pages (source: main branch, root).

## Tech

- [PDF.js](https://mozilla.github.io/pdf.js/) – load and render PDFs
- [pdf-lib](https://pdf-lib.js.org/) – create and modify PDFs
