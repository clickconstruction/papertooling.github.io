# PaperTooling

A PDF stripper: a client-side PDF tool that lets you select pages, compress, and download. All processing happens in your browser—files never leave your device.

## Usage

1. **Choose a PDF** — drop it on the page or click to pick one. Nothing is uploaded.
2. **Pick pages** — every page starts kept. Click a page to cut it (shift-click for a range), or use *Keep all · Keep none · Invert*. Pages are measured and shrunk in the background while you pick.
3. **Download** — two files, with a word on which suits this PDF:
   - **Just these pages** — the kept pages exactly as they are: sharp, selectable, searchable. (`name-pages-1-3_5.pdf`)
   - **Shrink it** — every page re-drawn as a JPEG. Good for scans and phone photos; a PDF that is already text usually gets *bigger* and loses its selectable text, and the app says so. Quality (90–99%, default 97%) and grayscale live here and re-estimate as you change them; *Compare before / after* opens the chosen page side by side. (`name-small.pdf`)

## Deployment

Static site for GitHub Pages. No build step required. Push to the repo and enable GitHub Pages (source: main branch, root).

## Tech

- [PDF.js](https://mozilla.github.io/pdf.js/) – load and render PDFs
- [pdf-lib](https://pdf-lib.js.org/) – create and modify PDFs
