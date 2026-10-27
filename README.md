# PaperTooling

Combine PDFs, cut the pages you don't need, shrink the file. A client-side PDF tool: everything happens in your browser tab and files never leave your device. There is no size cap; sets of several hundred MB work on a desktop, and the practical limit is the browser tab's memory (roughly half a gigabyte of PDFs).

## Usage

1. **Choose PDFs** — drop one or several on the page, or click (or press Enter) to pick them. Nothing is uploaded. One PDF goes straight to its pages (the stripper); several go to the next step. A PDF dropped anywhere on the page later joins the list.
2. **Put in order** — the pages are combined in this order. The list sorts by name the way sheet sets are named to sort (A0, C0.0, C1.1, E0.01), and files added later sort in too, unless you have moved a row by hand, in which case new files go to the end and *Sort A → Z* restores name order. Drag a row or use the arrows, remove one, *Add PDFs*. Each row shows pages and size, with a total underneath. A secured PDF (owner password) is unlocked on the way in; a PDF with a damaged page inside is marked *re-drawn as pictures* (see below).
3. **Pick pages** — every page starts kept. Click a page to cut it (shift-click, or Shift+Enter, for a range; arrow keys move between pages), or use *Keep all · Keep none · Invert*; with several files, each file's group has its own *Keep all · Cut all*. Thumbnails draw as they scroll into view, and pages are measured in the background. *Add PDFs* here takes you back a step with the new files in the list; your cuts are kept.
4. **Download** — two files, with a word on which suits this set:
   - **One combined PDF** (or **Just these pages** for a single file) — the kept pages exactly as they are: sharp, selectable, searchable, with a bookmark per source file. Named `<common prefix>-combined.pdf` for several files (`CBA TX San Antonio-combined.pdf`, or `…-combined-61-pages.pdf` after cuts), `name-pages-1-3_5.pdf` for one.
   - **Shrink it** — every page re-drawn as a JPEG on a page of the original size. Good for scans and phone photos; a PDF that is already text or drawn lines usually gets *bigger*, and the app says so. Up to 30 pages it is prepared while you pick; a bigger set has an *Estimate the shrunk size* button, because re-drawing a hundred sheets takes minutes and the combined file is usually what was wanted. Quality (90–99%, default 97%) and grayscale re-estimate as you change them; *Compare before / after* opens the chosen page side by side. Named `…-small.pdf` when it is smaller, `…-pictures.pdf` when it is not.

## Notes

- **Secured PDFs.** pdf-lib cannot decrypt, and pages copied out of a secured file keep their encryption and show blank. So when a secured file turns up, the [@cantoo/pdf-lib](https://www.npmjs.com/package/@cantoo/pdf-lib) fork is fetched (only then), unlocks the file with the empty user password, and its plain bytes go to pdf-lib. A file that needs a real password cannot be opened. If unlocking fails, Download says so and *Shrink it* still works.
- **Damaged PDFs.** When pdf-lib parses fewer pages than PDF.js shows, copying by page number would get the pages wrong. That file is never copied: its pages are re-drawn as pictures inside the combined file, Download names the file, and everything else is copied as it is.
- **Large sheets.** A shrunk page is drawn at 2x, capped at 16 million pixels (8 million on an iPhone or iPad), so a 30x42 sheet does not exhaust memory. On iOS the downloads go through the share sheet.
- **Keyboard and screen readers.** Every step works from the keyboard: the drop zone is a button, the file list keeps focus on the row you moved, the page grid is one Tab stop with arrow keys inside, and the step bar's finished steps are buttons back to them.

## Deployment

Static site for GitHub Pages. No build step required. Push to the repo and enable GitHub Pages (source: main branch, root).

## Tech

- [PDF.js](https://mozilla.github.io/pdf.js/) 3.11.174 – open and render PDFs (one shared worker for every file)
- [pdf-lib](https://pdf-lib.js.org/) 1.17.1 – copy pages, write PDFs
- [@cantoo/pdf-lib](https://www.npmjs.com/package/@cantoo/pdf-lib) 2.11.1 – loaded on demand to unlock secured PDFs
