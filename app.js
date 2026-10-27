(function() {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js';

  const PDFLib = window.PDFLib;
  const $ = id => document.getElementById(id);
  const yieldToUi = () => new Promise(r => setTimeout(r, 0));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // A small document is shrunk in the background while you pick, so Download shows both sizes at
  // once. A big one (a plan set) is only re-drawn when asked for: re-drawing a hundred sheets takes
  // minutes, and the combined file is usually what was wanted.
  const AUTO_SHRINK_MAX_PAGES = 30;
  const IS_IOS = /AppleWebKit/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  // A shrunk page is drawn at 2x, but a 30x42 sheet at 2x is 26 million pixels. iOS Safari refuses
  // a canvas over 16,777,216 pixels and budgets canvas memory tightly, so it gets half.
  const MAX_RASTER_PIXELS = IS_IOS ? 8e6 : 16e6;
  const THUMB_WIDTH = 150;
  const COVER_WIDTH = 320;  // a file's first page on its card at step 2
  const VIEW_PREF_KEY = 'papertooling.filesView';
  // Above this, combining needs a few hundred MB of free memory; say so, but never refuse.
  const BIG_SET_BYTES = 150 * 1024 * 1024;
  const UNLOCK_LIB_URL = 'https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2.11.1/dist/pdf-lib.min.js';
  // One PDF.js worker for every file: a worker per file is a thread that never goes away.
  const pdfWorker = new pdfjsLib.PDFWorker({ name: 'papertooling' });

  // Job tokens live outside `state` and never reset, so a job started before Start over can never
  // write into the run that follows it. Source ids never repeat for the same reason.
  let runId = 0;        // the background pass: measure pages, pre-shrink a small set
  let shrinkRun = 0;    // the shrink job at Download
  let stapleRun = 0;    // the combining itself
  let nextSourceId = 1;
  let reshrinkTimer = null;
  let dragFrom = null;
  let dragDepth = 0;
  let lastClickedIndex = null;
  let focusedCard = 0;
  let pendingFocus = null;
  let pendingFocusKey = null;   // the page card to focus once the grid is rebuilt
  let pageDrag = null;          // a page drag in step 3: { keys, set }
  let dropAt = null;            // where it would land: { key, side }
  let dropCell = null;
  let menuFor = null;           // the page whose ⋮ menu is open
  let menuClosedFor = null, menuClosedAt = 0;
  let menuPlace = null;         // where it sits: { anchor } or a point in page coordinates { x, y }
  const marked = new Set();     // page keys picked to move together
  // A colour per file, by file id, so it never changes when the files are reordered.
  const FILE_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#be185d', '#854d0e'];
  const thumbCache = new Map();
  const coverCache = new Map(); // source id -> canvas of its first page
  let filesView = readViewPref();

  // Everything about the current run. `sources` are the files in combining order; `pages` is every
  // page of every good file, in that order; a page is cut by its 'sourceId:pageIndex' key, so a cut
  // survives reordering the files, adding more, or removing one.
  let state = freshState();
  function freshState() {
    return {
      sources: [],
      pages: [],
      cut: new Set(),
      selectedIndices: [],
      keyPageIndex: null,
      userOrdered: false,
      order: null,          // the page keys in her order, once she has moved pages by hand
      pinned: new Set(),    // the keys she moved: they keep their places while the files change
      output: null,
      filteredPdfBytes: null,
      compressedPdfBytes: null,
      keyPageIndexInFiltered: null,
      keyPageIndexInCompressed: null,
      pageSizesBefore: new Map(),
      compressedPages: new Map(),
      shrinkStatus: 'pending',
      jpegQuality: 0.97,
      grayscale: false,
      everAdded: false
    };
  }

  const stageDrop = $('stage-drop');
  const stageFiles = $('stage-files');
  const stage1 = $('stage-1');
  const stage2Overlay = $('stage-2-overlay');
  const stage3 = $('stage-3');
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  const filesList = $('files-list');
  const thumbGrid = $('thumb-grid');
  const progressText = $('progress-text');
  const progressFill = $('progress-fill');

  const STAGES = { drop: stageDrop, files: stageFiles, stage1: stage1, stage2: stage2Overlay, stage3: stage3 };
  const NOTE_EL = { drop: 'drop-note', files: 'files-note', stage1: 'stage1-note', stage3: 'stage3-note' };
  let currentStage = 'drop';

  function showStage(name, moveFocus) {
    currentStage = name;
    Object.keys(STAGES).forEach(k => STAGES[k].classList.toggle('hidden', k !== name));
    // The step pills: the overlay is on the way to Download. A done step is a button back to it.
    const order = ['drop', 'files', 'stage1', 'stage3'];
    const at = order.indexOf(name === 'stage2' ? 'stage3' : name);
    document.querySelectorAll('.app-step').forEach(btn => {
      const i = order.indexOf(btn.dataset.step);
      const current = i === at, done = i < at;
      btn.classList.toggle('is-current', current);
      btn.classList.toggle('is-done', done);
      btn.disabled = !done;
      if (current) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
    });
    updateKeepTotals();
    updateFileBar();
    if (moveFocus !== false) {
      const h = name === 'stage2' ? $('progress-title') : STAGES[name].querySelector('h2');
      if (h) { try { h.focus({ preventScroll: true }); } catch (e) {} }
    }
  }

  // "8 files · 48 pages · 45.7 MB" in the bar.
  function updateFileBar() {
    const el = $('app-file');
    el.textContent = '';
    const good = goodSources();
    if (currentStage === 'drop' || !good.length) return;
    const pages = good.reduce((n, s) => n + s.numPages, 0);
    const bytes = good.reduce((n, s) => n + s.size, 0);
    const b = document.createElement('b');
    b.textContent = good.length === 1 ? good[0].fileName : good.length + ' files';
    el.appendChild(b);
    el.appendChild(document.createTextNode(' · ' + pages + (pages === 1 ? ' page' : ' pages') + ' · ' + formatBytes(bytes)));
  }

  function setError(el, msg) {
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }
  // A quiet grey line on the step she is looking at; cleared by the next thing she does.
  function note(msg) {
    const id = NOTE_EL[currentStage === 'stage2' ? 'stage1' : currentStage];
    if (id) $(id).textContent = msg || '';
  }
  function clearNotes() { Object.keys(NOTE_EL).forEach(k => { $(NOTE_EL[k]).textContent = ''; }); }
  function announce(msg) { const a = $('announce'); a.textContent = ''; setTimeout(() => { a.textContent = msg; }, 50); }
  function setProgress(pct) { progressFill.style.width = pct + '%'; $('progress-bar').setAttribute('aria-valuenow', String(Math.round(pct))); }

  // "%PDF-" somewhere in the first KB: some writers put junk before it, and PDF.js copes.
  function isPdfData(buf) {
    const view = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024));
    for (let i = 0; i + 4 < view.length; i++) {
      if (view[i] === 0x25 && view[i + 1] === 0x50 && view[i + 2] === 0x44 && view[i + 3] === 0x46 && view[i + 4] === 0x2D) return true;
    }
    return false;
  }

  // ---- Sources: the files -----------------------------------------------------------------

  function goodSources() { return state.sources.filter(s => !s.loading && !s.error); }
  function sourceById(id) { return state.sources.find(s => s.id === id); }
  function pageKey(pg) { return pg.s + ':' + pg.p; }
  function keyAt(index) { return pageKey(state.pages[index]); }
  function stripExt(name) { return name.replace(/\.pdf$/i, '') || 'document'; }
  // "C1.1" before "C2.0" before "C10.0": digits compare as numbers.
  function naturalCompare(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
  function looksLikePdf(f) { return f.type === 'application/pdf' || f.type === 'application/x-pdf' || /\.pdf$/i.test(f.name); }
  function sortSourcesByName() { state.sources.sort((a, b) => naturalCompare(a.fileName, b.fileName)); }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    const pdfs = [], skipped = [];
    files.forEach(f => (looksLikePdf(f) ? pdfs : skipped).push(f));
    const dupes = [];
    const fresh = pdfs.filter(f => {
      const dupe = state.sources.some(s => s.fileName === f.name && s.size === f.size);
      if (dupe) dupes.push(f.name);
      return !dupe;
    });
    const notes = [];
    if (skipped.length) notes.push('Skipped ' + (skipped.length === 1 ? 'a file that is not a PDF: ' : skipped.length + ' files that are not PDFs: ') + skipped.map(f => f.name).join(', '));
    if (dupes.length) notes.push('Already in the list: ' + dupes.join(', '));
    clearNotes();
    const fromDropZone = currentStage === 'drop';
    if (!fresh.length) {
      if (fromDropZone) setError($('drop-error'), notes.join(' · ') || 'Please choose PDF files.');
      else note(notes.join(' · ') || 'No new PDF in that drop.');
      return;
    }
    setError($('drop-error'), '');
    const myState = state;
    const firstBatch = !state.everAdded;
    state.everAdded = true;
    const batch = fresh.map(f => ({ id: nextSourceId++, fileName: f.name, name: stripExt(f.name), size: f.size, file: f, bytes: null, pdfDoc: null, libDoc: null, numPages: 0, aspect: 0, encrypted: false, unlocked: false, libError: null, error: null, loading: true, removed: false }));
    // Order: the whole list sorts by name, the way sheet sets are named to sort (A0, C0.0, C1.1,
    // E0.01), unless she has set the order by hand; then a new batch goes to the end.
    state.sources.push(...batch);
    if (state.userOrdered) {
      if (state.sources.length > batch.length) notes.push('Added at the end, since you had set the order by hand. Sort A → Z puts everything in name order.');
    } else {
      sortSourcesByName();
    }
    // One PDF dropped to start goes straight to its pages, as a stripper should; the Files step
    // is a click away for adding more. Decided once it is open, in case more arrive meanwhile.
    const maybeStraight = firstBatch && batch.length === 1 && fromDropZone;
    if (maybeStraight) {
      $('drop-status').textContent = 'Opening ' + batch[0].fileName + '…';
    } else {
      stopJobs();
      showStage('files');
      renderFilesList();
    }
    for (const src of batch) {
      if (state !== myState) return;
      if (src.removed) continue;
      await loadSource(src);
      if (state !== myState) return;
      if (currentStage === 'files') renderFilesList();
    }
    $('drop-status').textContent = '';
    const alive = batch.filter(s => !s.removed);
    if (!alive.length) { renderFilesList(); return; }
    if (maybeStraight && currentStage === 'drop' && state.sources.length === 1 && !alive[0].error) {
      startPicking();
    } else if (currentStage !== 'files') {
      showStage('files');
      renderFilesList();
    } else {
      renderFilesList();
    }
    if (notes.length) note(notes.join(' · '));
  }

  async function loadSource(src) {
    try {
      const buf = await new Response(src.file).arrayBuffer();
      if (!buf.byteLength) throw new Error('The file is empty.');
      if (!isPdfData(buf)) throw new Error('Not a PDF, or a damaged one.');
      src.bytes = new Uint8Array(buf);
      // PDF.js takes its own copy: it hands the bytes to its worker.
      src.pdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0), worker: pdfWorker }).promise;
      if (src.removed) { destroySource(src); return; }
      src.numPages = src.pdfDoc.numPages;
      // The first sheet's shape sizes the placeholders: a plan set is landscape, a spec is portrait.
      try { const v = (await src.pdfDoc.getPage(1)).getViewport({ scale: 1 }); src.aspect = v.width / v.height; } catch (e) { src.aspect = 8.5 / 11; }
      // pdf-lib's copy is what the combining uses; it also tells us whether the file is secured.
      ensureLibDoc(src).catch(() => {});
    } catch (e) {
      const kind = e && e.name;
      src.error = kind === 'PasswordException' ? 'Needs a password to open.'
        : kind === 'InvalidPDFException' ? 'Damaged PDF: it cannot be opened.'
        : (e && e.message) || 'Could not open this PDF.';
    } finally {
      src.loading = false;
      src.file = null;
    }
  }

  function destroySource(src) {
    src.removed = true;
    try { if (src.pdfDoc) src.pdfDoc.destroy(); } catch (e) {}
    src.pdfDoc = null;
    src.libDoc = null;
    src.bytes = null;
    coverCache.delete(src.id);
  }

  // pdf-lib's copy of a file is what the combining uses. Two things can go wrong with it.
  // A secured PDF (an owner password: "printing not allowed") opens fine, but pages copied out
  // of it keep their encryption and show blank, so it is unlocked first, by a second library
  // fetched only when a secured file turns up. And a PDF with a damaged object inside can parse
  // to fewer pages than PDF.js shows, which would copy the wrong pages: such a file is never
  // copied, its pages are re-drawn as pictures instead.
  let unlockLib = null;
  function loadUnlockLib() {
    if (!unlockLib) {
      unlockLib = new Promise((resolve, reject) => {
        const orig = window.PDFLib;
        const s = document.createElement('script');
        s.src = UNLOCK_LIB_URL;
        s.onload = () => {
          const lib = window.PDFLib;
          window.PDFLib = orig;
          if (lib && lib !== orig && lib.PDFDocument) resolve(lib); else reject(new Error('The unlocking library did not load.'));
        };
        s.onerror = () => { unlockLib = null; reject(new Error('The unlocking library did not load.')); };
        document.head.appendChild(s);
      });
    }
    return unlockLib;
  }
  async function unlockBytes(bytes) {
    const lib = await loadUnlockLib();
    const doc = await lib.PDFDocument.load(bytes, { password: '' });
    return doc.save();
  }
  async function loadLibDoc(src) {
    const opts = { ignoreEncryption: true, updateMetadata: false };
    let doc = await PDFLib.PDFDocument.load(src.bytes, opts);
    if (doc.isEncrypted) {
      try {
        const plain = await unlockBytes(src.bytes);
        const unlocked = await PDFLib.PDFDocument.load(plain, opts);
        if (!unlocked.isEncrypted) { doc = unlocked; src.unlocked = true; }
      } catch (e) { /* it stays secured, and Download says so */ }
      src.encrypted = doc.isEncrypted;
    }
    if (doc.getPageCount() !== src.numPages) {
      throw new Error('a damaged page inside: only ' + doc.getPageCount() + ' of its ' + src.numPages + ' pages could be copied');
    }
    return doc;
  }
  function ensureLibDoc(src) {
    if (!src.libDoc) {
      src.libDoc = loadLibDoc(src)
        .catch(e => { src.libError = (e && e.message) || 'its pages cannot be copied'; throw e; })
        .finally(() => {
          src.bytes = null; // pdf-lib holds its own parsed copy from here on
          if (currentStage === 'files') renderFilesList();
          else if (currentStage === 'stage1') refreshGroupHeaders();
        });
    }
    return src.libDoc;
  }
  function sourceFlags(src) {
    return (src.unlocked ? ' · unlocked' : src.encrypted ? ' · secured' : '') + (src.libError ? ' · re-drawn as pictures' : '');
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---- The files, in order ---------------------------------------------------------------------
  // Step 2 shows the files two ways: a card per file with its first page drawn (the default), or
  // a compact list. The choice is remembered in this browser.
  function readViewPref() {
    try { return localStorage.getItem(VIEW_PREF_KEY) === 'list' ? 'list' : 'cards'; } catch (e) { return 'cards'; }
  }
  function applyFilesView() {
    filesList.className = filesView === 'list' ? 'files-list' : 'files-grid';
    document.querySelectorAll('.view-switch button').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === filesView ? 'true' : 'false'));
  }
  function setFilesView(view) {
    if (view === filesView) return;
    filesView = view;
    try { localStorage.setItem(VIEW_PREF_KEY, view); } catch (e) {}
    applyFilesView();
    renderFilesList();
    announce(view === 'list' ? 'Files shown as a list.' : 'Files shown as thumbnails.');
  }

  function fileMetaText(src) { return src.loading ? 'Opening…' : src.error ? src.error : groupMeta(src); }

  function fileControls(src, i) {
    const cards = filesView !== 'list';
    const ctl = el('div', 'file-controls');
    const up = el('button', null, cards ? '←' : '↑');
    up.type = 'button'; up.dataset.act = 'up';
    up.title = cards ? 'Move earlier' : 'Move up';
    up.setAttribute('aria-label', 'Move ' + src.fileName + (cards ? ' earlier' : ' up'));
    up.disabled = i === 0 || !!src.error;
    const down = el('button', null, cards ? '→' : '↓');
    down.type = 'button'; down.dataset.act = 'down';
    down.title = cards ? 'Move later' : 'Move down';
    down.setAttribute('aria-label', 'Move ' + src.fileName + (cards ? ' later' : ' down'));
    down.disabled = i === state.sources.length - 1 || !!src.error;
    const rm = el('button', null, '×');
    rm.type = 'button'; rm.dataset.act = 'remove'; rm.title = 'Remove';
    rm.setAttribute('aria-label', 'Remove ' + src.fileName);
    up.addEventListener('click', () => moveSource(i, i - 1, 'up'));
    down.addEventListener('click', () => moveSource(i, i + 1, 'down'));
    rm.addEventListener('click', () => removeSource(i));
    ctl.appendChild(up); ctl.appendChild(down); ctl.appendChild(rm);
    return ctl;
  }

  function wireDrag(item, i) {
    item.addEventListener('dragstart', e => {
      dragFrom = i;
      try { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
      item.classList.add('is-dragging');
    });
    item.addEventListener('dragover', e => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('is-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('is-over'));
    item.addEventListener('drop', e => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.stopPropagation();
      const from = dragFrom;
      dragFrom = null;
      moveSource(from, i, '');
    });
    item.addEventListener('dragend', () => { dragFrom = null; renderFilesList(); });
  }

  function buildFileRow(src, i) {
    const row = el('div', 'file-item file-row' + (src.error ? ' is-error' : ''));
    const handle = el('span', 'file-handle', '⋮');
    handle.title = 'Drag to reorder';
    handle.setAttribute('aria-hidden', 'true');
    row.appendChild(handle);
    row.appendChild(el('span', 'file-num', String(i + 1)));
    const name = el('span', 'file-name', src.fileName);
    name.title = src.fileName;
    row.appendChild(name);
    const metaEl = el('span', 'file-meta', fileMetaText(src));
    if (src.libError) metaEl.title = 'This file has ' + src.libError + '.';
    row.appendChild(metaEl);
    row.appendChild(fileControls(src, i));
    return row;
  }

  function buildFileCard(src, i) {
    const card = el('div', 'file-item file-card' + (src.error ? ' is-error' : '') + (src.numPages > 1 ? ' is-stack' : ''));
    card.dataset.sid = String(src.id);
    const cover = el('div', 'file-cover');
    if (!src.loading && !src.error) cover.title = 'Drag to reorder';
    const cached = coverCache.get(src.id);
    if (cached) {
      cover.appendChild(cached);
    } else {
      // Wide sheets are limited by the card's width, tall ones by the cover's height.
      const aspect = src.aspect || 8.5 / 11;
      const ph = el('div', 'thumb-placeholder ' + (aspect >= 1.18 ? 'is-wide' : 'is-tall'), src.loading ? 'Opening…' : src.error ? 'Could not open' : 'Page 1…');
      ph.style.aspectRatio = String(aspect);
      cover.appendChild(ph);
      if (!src.loading && !src.error) { if (coverObserver) coverObserver.observe(card); else coverQueue.push(card); }
    }
    card.appendChild(cover);
    const body = el('div', 'file-body');
    const badge = el('span', 'file-badge');
    badge.appendChild(el('span', 'visually-hidden', 'File '));
    badge.appendChild(document.createTextNode(String(i + 1)));
    body.appendChild(badge);
    const name = el('div', 'file-name', src.fileName);
    name.title = src.fileName;
    body.appendChild(name);
    const metaEl = el('div', 'file-meta', fileMetaText(src).replace(/(\d) (pages?|[KMG]?B)\b/g, '$1 $2'));
    if (src.libError) metaEl.title = 'This file has ' + src.libError + '.';
    body.appendChild(metaEl);
    card.appendChild(body);
    card.appendChild(fileControls(src, i));
    return card;
  }

  // Covers are drawn as the cards scroll into view, one at a time, like the page thumbnails.
  const coverQueue = [];
  const coverPending = new Set();
  let coverBusy = false;
  const coverObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) { coverObserver.unobserve(en.target); coverQueue.push(en.target); } });
    drainCovers();
  }, { rootMargin: '500px 0px' }) : null;

  async function drainCovers() {
    if (coverBusy) return;
    coverBusy = true;
    try {
      while (coverQueue.length) {
        const card = coverQueue.shift();
        const sid = parseInt(card.dataset.sid, 10);
        if (!card.isConnected || coverCache.has(sid) || coverPending.has(sid)) continue;
        const src = sourceById(sid);
        if (!src || !src.pdfDoc) continue;
        coverPending.add(sid);
        let canvas = null;
        try { canvas = await renderThumbnail(src, 1, COVER_WIDTH); } catch (e) { canvas = null; }
        coverPending.delete(sid);
        // The list may have been rebuilt meanwhile: find the card that shows this file now.
        const ph = filesList.querySelector('.file-card[data-sid="' + sid + '"] .thumb-placeholder');
        if (canvas && sourceById(sid) === src) {
          coverCache.set(sid, canvas);
          if (ph) ph.replaceWith(canvas);
        } else if (ph && !canvas) {
          ph.textContent = 'Could not draw';
        }
      }
    } finally {
      coverBusy = false;
    }
  }

  function renderFilesList() {
    if (dragFrom !== null) return; // never rebuild under a drag; dragend rebuilds
    // Where focus was: the same button on the same file again after the rebuild.
    let keep = pendingFocus;
    pendingFocus = null;
    const ae = document.activeElement;
    if (!keep && ae && filesList.contains(ae)) {
      const item = ae.closest('.file-item');
      keep = { index: item ? parseInt(item.dataset.index, 10) : 0, act: ae.dataset.act || '' };
    }
    const cards = filesView !== 'list';
    if (coverObserver) coverObserver.disconnect();
    coverQueue.length = 0;
    filesList.innerHTML = '';
    state.sources.forEach((src, i) => {
      const item = cards ? buildFileCard(src, i) : buildFileRow(src, i);
      item.dataset.index = String(i);
      item.draggable = !src.loading && !src.error;
      wireDrag(item, i);
      filesList.appendChild(item);
    });
    if (cards && !coverObserver) drainCovers();
    if (keep) focusRowButton(keep.index, keep.act);
    const good = goodSources();
    const loading = state.sources.some(s => s.loading);
    const pages = good.reduce((n, s) => n + s.numPages, 0);
    const bytes = good.reduce((n, s) => n + s.size, 0);
    const total = $('files-total');
    total.textContent = '';
    if (state.sources.length) {
      const b = el('b', null, (good.length === 1 ? '1 file' : good.length + ' files') + ' · ' + pages + (pages === 1 ? ' page' : ' pages') + ' · ' + formatBytes(bytes));
      total.appendChild(b);
      if (loading) total.appendChild(document.createTextNode(' · still opening…'));
      const bad = state.sources.filter(s => !s.loading && s.error).length;
      if (bad) total.appendChild(document.createTextNode(' · ' + bad + (bad === 1 ? ' file could not be opened and is left out' : ' files could not be opened and are left out')));
    }
    const warns = [];
    const damaged = good.filter(s => s.libError);
    if (damaged.length) warns.push((damaged.length === 1 ? damaged[0].fileName + ' has ' + damaged[0].libError : damaged.length + ' files have damaged pages inside') + '. ' + (damaged.length === 1 ? 'Its' : 'Their') + ' pages will be re-drawn as pictures instead of copied as they are, so their text will not be selectable.');
    const locked = good.filter(s => s.encrypted && !s.unlocked);
    if (locked.length) warns.push((locked.length === 1 ? locked[0].fileName + ' is secured and could not be unlocked.' : locked.length + ' files are secured and could not be unlocked.') + ' Pages copied from it may show blank; Shrink it re-draws them and works.');
    if (bytes > BIG_SET_BYTES) warns.push('A big set. Combining it needs a few hundred MB of free memory and takes a while, but it all still happens here in this tab.');
    $('files-warn').textContent = warns.join(' ');
    const btn = $('btn-continue-files');
    btn.disabled = loading || !good.length;
    btn.textContent = loading ? 'Opening…' : !good.length ? 'No PDF to continue with' : 'Continue — ' + pages + (pages === 1 ? ' page' : ' pages');
    $('btn-sort-files').disabled = state.sources.length < 2;
    updateFileBar();
  }

  function focusRowButton(index, act) {
    const items = filesList.querySelectorAll('.file-item');
    if (!items.length) { $('btn-add-files').focus(); return; }
    const item = items[Math.max(0, Math.min(index, items.length - 1))];
    let btn = act ? item.querySelector('button[data-act="' + act + '"]') : null;
    if (!btn || btn.disabled) btn = Array.from(item.querySelectorAll('button')).find(b => !b.disabled);
    (btn || $('btn-add-files')).focus();
  }

  function moveSource(from, to, act) {
    if (to < 0 || to >= state.sources.length || from === to) return;
    const [s] = state.sources.splice(from, 1);
    state.sources.splice(to, 0, s);
    state.userOrdered = true;
    pendingFocus = { index: to, act: act };
    renderFilesList();
  }

  function removeSource(i) {
    const [src] = state.sources.splice(i, 1);
    if (src) destroySource(src);
    if (!state.sources.length) { startOver(true); return; }
    pendingFocus = { index: Math.min(i, state.sources.length - 1), act: 'remove' };
    renderFilesList();
  }

  function sortSources() {
    clearNotes();
    state.userOrdered = false;
    sortSourcesByName();
    renderFilesList();
  }

  function stopJobs() {
    runId++;
    shrinkRun++;
    stapleRun++;
    if (reshrinkTimer) { clearTimeout(reshrinkTimer); reshrinkTimer = null; }
  }

  // ---- Pages: pick the ones to keep ---------------------------------------------------------

  function startPicking() {
    clearNotes();
    marked.clear();
    setError($('stage1-error'), '');
    buildPages();
    buildThumbCards();
    updateStage1State();
    showStage('stage1');
    runBackgroundWork();
  }

  // The pages start in file order. Once she has moved pages by hand, the moved ones ("pinned")
  // keep their places and the rest follow file order around them: a page dragged to the front is
  // still at the front after the files are reordered, added to or one is removed.
  function buildPages() {
    const natural = [];
    goodSources().forEach(src => { for (let p = 0; p < src.numPages; p++) natural.push({ s: src.id, p }); });
    const have = new Map(natural.map(pg => [pageKey(pg), pg]));
    state.pinned.forEach(k => { if (!have.has(k)) state.pinned.delete(k); });
    marked.forEach(k => { if (!have.has(k)) marked.delete(k); });
    if (state.pinned.size) {
      const pages = natural.filter(pg => !state.pinned.has(pageKey(pg)));
      (state.order || []).forEach((k, i) => { if (state.pinned.has(k)) pages.splice(Math.min(i, pages.length), 0, have.get(k)); });
      const placed = new Set(pages.map(pageKey));
      natural.forEach(pg => { if (!placed.has(pageKey(pg))) pages.push(pg); });
      state.pages = pages;
      state.order = pages.map(pageKey);
    } else {
      state.pages = natural;
      state.order = null;
    }
    // The kept list is rebuilt from the cuts by updateStage1State; until then nothing may read it.
    state.selectedIndices = [];
    state.keyPageIndex = null;
    lastClickedIndex = null;
    focusedCard = 0;
  }

  async function renderThumbnail(src, pageNum, maxWidth) {
    const page = await src.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const scale = maxWidth / viewport.width;
    const scaledViewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(scaledViewport.width));
    canvas.height = Math.max(1, Math.round(scaledViewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    return canvas;
  }

  // Thumbnails are drawn as they scroll into view, one at a time: a plan set is a hundred big
  // sheets, and drawing them all at once would hold the tab for minutes.
  const thumbQueue = [];
  let thumbBusy = false;
  const thumbObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) { thumbObserver.unobserve(en.target); thumbQueue.push(en.target); }
    });
    drainThumbs();
  }, { rootMargin: '500px 0px' }) : null;

  async function drainThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      while (thumbQueue.length) {
        const card = thumbQueue.shift();
        if (!card.isConnected) continue;
        const pg = state.pages[parseInt(card.dataset.index, 10)];
        const ph = card.querySelector('.thumb-placeholder');
        if (!pg || !ph || card.dataset.key !== pageKey(pg)) continue;
        const src = sourceById(pg.s);
        if (!src || !src.pdfDoc) continue;
        try {
          const canvas = await renderThumbnail(src, pg.p + 1, THUMB_WIDTH);
          thumbCache.set(pageKey(pg), canvas);
          if (card.isConnected) ph.replaceWith(canvas);
        } catch (e) {
          ph.textContent = 'Could not draw';
        }
      }
    } finally {
      thumbBusy = false;
    }
  }

  function thumbsIdle(run) {
    return (async () => { while ((thumbQueue.length || thumbBusy) && runId === run) await sleep(60); })();
  }

  function groupMeta(src) { return src.numPages + (src.numPages === 1 ? ' page' : ' pages') + ' · ' + formatBytes(src.size) + sourceFlags(src); }

  function fileColor(src) { return FILE_COLORS[(src.id - 1) % FILE_COLORS.length]; }
  function fileDot(src) {
    const d = el('i', 'file-dot');
    d.style.setProperty('--dot', fileColor(src));
    d.setAttribute('aria-hidden', 'true');
    return d;
  }

  function buildGroupHeader(src) {
    const h = el('div', 'thumb-group');
    h.dataset.source = String(src.id);
    h.appendChild(fileDot(src));
    h.appendChild(el('span', 'thumb-group-name', src.fileName));
    h.appendChild(el('span', 'thumb-group-meta', groupMeta(src)));
    const actions = el('div', 'thumb-group-actions');
    const keep = el('button', 'btn btn-secondary', 'Keep all'); keep.type = 'button'; keep.setAttribute('aria-label', 'Keep all pages of ' + src.fileName);
    const cut = el('button', 'btn btn-secondary', 'Cut all'); cut.type = 'button'; cut.setAttribute('aria-label', 'Cut all pages of ' + src.fileName);
    keep.addEventListener('click', () => setGroup(src.id, true));
    cut.addEventListener('click', () => setGroup(src.id, false));
    actions.appendChild(keep); actions.appendChild(cut);
    h.appendChild(actions);
    return h;
  }

  function refreshGroupHeaders() {
    document.querySelectorAll('#thumb-grid .thumb-group, #file-legend .thumb-group').forEach(h => {
      const src = sourceById(parseInt(h.dataset.source, 10));
      if (src) h.querySelector('.thumb-group-meta').textContent = groupMeta(src);
    });
  }

  function buildThumbCards() {
    thumbGrid.innerHTML = '';
    thumbQueue.length = 0;
    if (thumbObserver) thumbObserver.disconnect();
    closePageMenu(false);
    const many = goodSources().length > 1;
    const custom = !!state.order;
    // In file order each file heads its own pages. Once pages are mixed, the files are listed
    // above the grid instead, and every card says which file it is from.
    const legend = $('file-legend');
    legend.innerHTML = '';
    legend.classList.toggle('hidden', !(many && custom));
    if (many && custom) goodSources().forEach(src => legend.appendChild(buildGroupHeader(src)));
    $('btn-sort-pages').disabled = !custom;
    if (pendingFocusKey !== null) { const at = indexOfKey(pendingFocusKey); if (at >= 0) focusedCard = at; }
    focusedCard = Math.max(0, Math.min(focusedCard, state.pages.length - 1));
    let lastSid = null;
    state.pages.forEach((pg, i) => {
      const src = sourceById(pg.s);
      if (many && !custom && pg.s !== lastSid) { thumbGrid.appendChild(buildGroupHeader(src)); lastSid = pg.s; }
      const pageNum = i + 1;
      const key = pageKey(pg);
      const cell = el('div', 'thumb-cell');
      cell.dataset.index = String(i);
      cell.dataset.key = key;
      cell.draggable = true;
      wirePageDrag(cell, i);
      const card = el('div', 'thumb-card');
      card.dataset.index = String(i);
      card.dataset.key = key;
      card.tabIndex = i === focusedCard ? 0 : -1;
      card.setAttribute('role', 'checkbox');
      card.setAttribute('aria-label', 'Keep page ' + pageNum + (many ? ' (' + src.fileName + ', page ' + (pg.p + 1) + ')' : ''));
      card.title = many ? src.fileName + ' · page ' + (pg.p + 1) + ' of ' + src.numPages : '';
      card.addEventListener('click', e => { if (e.metaKey || e.ctrlKey) toggleMark(i); else onCardActivate(i, e.shiftKey); });
      card.addEventListener('keydown', e => onCardKey(e, i));
      card.addEventListener('focus', () => setFocusedCard(i));
      card.addEventListener('contextmenu', e => { e.preventDefault(); openPageMenu(i, { x: e.clientX, y: e.clientY }); });
      const cached = thumbCache.get(key);
      if (cached) {
        card.appendChild(cached);
      } else {
        const placeholder = el('div', 'thumb-placeholder', 'Page ' + pageNum + '…');
        if (src.aspect) placeholder.style.aspectRatio = String(src.aspect);
        card.appendChild(placeholder);
        if (thumbObserver) thumbObserver.observe(card); else thumbQueue.push(card);
      }
      if (many) {
        const tag = el('div', 'thumb-file');
        tag.appendChild(fileDot(src));
        tag.appendChild(el('span', null, src.name));
        tag.title = src.fileName;
        card.appendChild(tag);
      }
      const controls = el('div', 'thumb-controls');
      const numSpan = el('span', 'page-num', String(pageNum));
      if (many) { const sm = el('small', null, ' · p' + (pg.p + 1)); numSpan.appendChild(sm); }
      controls.appendChild(numSpan);
      const sizeSpan = el('span', 'page-size', '…');
      sizeSpan.dataset.pageSize = key;
      const known = state.pageSizesBefore.get(key);
      if (known !== undefined) sizeSpan.textContent = formatBytes(known);
      else if (src.libError) sizeSpan.textContent = '—';
      controls.appendChild(sizeSpan);
      card.appendChild(controls);
      cell.appendChild(card);
      // The menu sits beside the checkbox, not inside it: a checkbox's insides are not read out.
      const menuBtn = el('button', 'thumb-menu-btn', '⋮');
      menuBtn.type = 'button';
      menuBtn.tabIndex = -1;
      menuBtn.title = 'Move this page';
      menuBtn.setAttribute('aria-label', 'Move page ' + pageNum);
      menuBtn.setAttribute('aria-haspopup', 'menu');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.addEventListener('click', () => {
        if (menuClosedFor === i && Date.now() - menuClosedAt < 400) { menuClosedFor = null; return; } // the click that closed it
        openPageMenu(i, { anchor: menuBtn });
      });
      cell.appendChild(menuBtn);
      thumbGrid.appendChild(cell);
    });
    if (!thumbObserver) drainThumbs();
    refreshMarks();
    if (pendingFocusKey !== null) {
      pendingFocusKey = null;
      const c = thumbGrid.querySelectorAll('.thumb-card')[focusedCard];
      if (c) c.focus();
    }
  }

  // One Tab stop for the whole grid; the arrow keys move between pages.
  function setFocusedCard(i) {
    if (i === focusedCard) return;
    const cards = thumbGrid.querySelectorAll('.thumb-card');
    if (cards[focusedCard]) cards[focusedCard].tabIndex = -1;
    focusedCard = i;
    if (cards[i]) cards[i].tabIndex = 0;
  }
  function onCardKey(e, i) {
    const arrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (e.altKey && (arrow || e.key === 'Home' || e.key === 'End')) {
      // Alt+arrows move the page itself; Alt+Home / Alt+End take it to the front or the end.
      e.preventDefault();
      pageAction(i, e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 'earlier' : arrow ? 'later' : e.key === 'Home' ? 'front' : 'end');
      return;
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      openPageMenu(i, { anchor: e.currentTarget });
      return;
    }
    if ((e.key === ' ' || e.key === 'Enter') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleMark(i); return; }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onCardActivate(i, e.shiftKey); return; }
    const cards = thumbGrid.querySelectorAll('.thumb-card');
    if (!cards.length) return;
    let cols = 1;
    const cells = thumbGrid.querySelectorAll('.thumb-cell');
    if (cells.length > 1) { const top0 = cells[0].offsetTop; for (let k = 1; k < cells.length && cells[k].offsetTop === top0; k++) cols++; }
    let to = null;
    if (e.key === 'ArrowRight') to = i + 1;
    else if (e.key === 'ArrowLeft') to = i - 1;
    else if (e.key === 'ArrowDown') to = i + cols;
    else if (e.key === 'ArrowUp') to = i - cols;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = cards.length - 1;
    if (to === null) return;
    e.preventDefault();
    to = Math.max(0, Math.min(cards.length - 1, to));
    setFocusedCard(to);
    cards[to].focus();
  }

  // ---- Pages: put them in order -------------------------------------------------------------
  // Drag a page where it should go, or use its ⋮ menu (right-click, or M on the keyboard).
  // Several pages picked with ⌘/Ctrl-click move together, in their order, as a block.

  function indexOfKey(key) { return state.pages.findIndex(pg => pageKey(pg) === key); }
  function markedKeys() { return state.pages.map(pageKey).filter(k => marked.has(k)); }

  // What an action on page `index` moves: the whole selection, when that page is in it.
  function movingKeysFor(index) {
    const key = keyAt(index);
    return marked.has(key) && marked.size > 1 ? markedKeys() : [key];
  }

  // Take `keys` out of the list and put them back, in their order, at `at` (an index into the
  // list without them). A moved page is pinned: it keeps its place while the files change.
  function movePages(keys, at, where) {
    const moving = new Set(keys);
    const taken = state.pages.filter(pg => moving.has(pageKey(pg)));
    if (!taken.length) return;
    const rest = state.pages.filter(pg => !moving.has(pageKey(pg)));
    at = Math.max(0, Math.min(rest.length, at));
    const pages = rest.slice(0, at).concat(taken, rest.slice(at));
    if (pages.every((pg, i) => pg === state.pages[i])) return;
    state.pages = pages;
    state.order = pages.map(pageKey);
    taken.forEach(pg => state.pinned.add(pageKey(pg)));
    pendingFocusKey = pageKey(taken[0]);
    rebuildGrid();
    const n = taken.length;
    announce((n === 1 ? 'Page moved to ' : n + ' pages moved to ') + (where || 'position ' + (indexOfKey(pageKey(taken[0])) + 1) + ' of ' + state.pages.length) + '.');
  }

  // The grid, the kept list and the background pass all go by position: start them over.
  function rebuildGrid() {
    buildThumbCards();
    updateStage1State();
    runBackgroundWork();
  }

  function pageAction(index, act) {
    if (act === 'mark') { toggleMark(index); return; }
    const keys = movingKeysFor(index);
    const idx = keys.map(indexOfKey);
    const first = Math.min.apply(null, idx), last = Math.max.apply(null, idx);
    if (act === 'front') movePages(keys, 0, 'the front');
    else if (act === 'end') movePages(keys, state.pages.length, 'the end');
    else if (act === 'earlier') movePages(keys, first - 1);
    else if (act === 'later') movePages(keys, last + 2 - keys.length);
  }

  function sortPagesByFile() {
    if (!state.order) return;
    state.pinned.clear();
    state.order = null;
    buildPages();
    rebuildGrid();
    announce('Pages are back in file order.');
  }

  function toggleMark(index) {
    const key = keyAt(index);
    if (marked.has(key)) marked.delete(key); else marked.add(key);
    refreshMarks();
    announce('Page ' + (index + 1) + (marked.has(key) ? ' selected to move' : ' no longer selected') + ' · ' + marked.size + ' selected.');
  }
  function clearMarks() { marked.clear(); refreshMarks(); }

  function refreshMarks() {
    const order = markedKeys();
    thumbGrid.querySelectorAll('.thumb-card').forEach(card => {
      const at = order.indexOf(card.dataset.key);
      card.classList.toggle('is-marked', at !== -1);
      let b = card.querySelector('.mark-badge');
      if (at === -1) { if (b) b.remove(); return; }
      if (!b) { b = el('span', 'mark-badge'); b.setAttribute('aria-hidden', 'true'); card.appendChild(b); }
      b.textContent = String(at + 1);
    });
    const bar = $('move-bar');
    bar.classList.toggle('hidden', !order.length);
    const t = $('move-bar-text');
    t.textContent = '';
    if (order.length) {
      t.appendChild(el('b', null, order.length + (order.length === 1 ? ' page' : ' pages')));
      t.appendChild(document.createTextNode(' selected to move together'));
    }
  }

  // The ⋮ menu: one element, shown by the page it was opened for.
  const pageMenu = $('page-menu');
  function openPageMenu(index, where) {
    closePageMenu(false);
    menuFor = index;
    const keys = movingKeysFor(index);
    const idx = keys.map(indexOfKey);
    const first = Math.min.apply(null, idx), last = Math.max.apply(null, idx);
    const n = state.pages.length, k = keys.length;
    $('page-menu-title').textContent = k > 1 ? k + ' selected pages' : 'Page ' + (index + 1) + ' of ' + n;
    const items = Array.from(pageMenu.querySelectorAll('button'));
    items.forEach(b => {
      const a = b.dataset.act;
      if (a === 'front') b.disabled = first === 0 && last === k - 1;
      else if (a === 'earlier') b.disabled = first === 0;
      else if (a === 'end') b.disabled = last === n - 1 && first === n - k;
      else if (a === 'later') b.disabled = last === n - 1;
      else if (a === 'mark') b.textContent = marked.has(keyAt(index)) ? 'Deselect this page' : 'Select to move together';
    });
    menuPlace = where.anchor ? { anchor: where.anchor } : { x: where.x + window.scrollX, y: where.y + window.scrollY };
    if (where.anchor && where.anchor.classList.contains('thumb-menu-btn')) where.anchor.setAttribute('aria-expanded', 'true');
    pageMenu.classList.remove('hidden');
    placeMenu();
    const firstItem = items.find(b => !b.disabled);
    if (firstItem) firstItem.focus();
  }
  // Below its ⋮ (above it when there is no room), or at the pointer; it follows its page when the
  // page scrolls, and stays inside the window.
  function placeMenu() {
    if (menuFor === null || !menuPlace) return;
    if (menuPlace.anchor && !menuPlace.anchor.isConnected) { closePageMenu(false); return; }
    const mw = pageMenu.offsetWidth, mh = pageMenu.offsetHeight;
    let x, y;
    if (menuPlace.anchor) {
      const r = menuPlace.anchor.getBoundingClientRect();
      x = r.right - mw; y = r.bottom + 4;
      if (y + mh > window.innerHeight - 8 && r.top - mh - 4 >= 8) y = r.top - mh - 4;
    } else {
      x = menuPlace.x - window.scrollX; y = menuPlace.y - window.scrollY;
    }
    pageMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
    pageMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';
  }
  function closePageMenu(refocus) {
    if (menuFor === null) return;
    const i = menuFor;
    menuFor = null;
    menuClosedFor = i; menuClosedAt = Date.now();
    if (menuPlace && menuPlace.anchor && menuPlace.anchor.classList.contains('thumb-menu-btn')) menuPlace.anchor.setAttribute('aria-expanded', 'false');
    menuPlace = null;
    pageMenu.classList.add('hidden');
    if (refocus) { const c = thumbGrid.querySelectorAll('.thumb-card')[i]; if (c) { setFocusedCard(i); c.focus(); } }
  }
  pageMenu.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled || menuFor === null) return;
    const i = menuFor;
    closePageMenu(b.dataset.act === 'mark');
    pageAction(i, b.dataset.act);
  });
  pageMenu.addEventListener('keydown', e => {
    const items = Array.from(pageMenu.querySelectorAll('button')).filter(b => !b.disabled);
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closePageMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') closePageMenu(true); // Tab goes on from the page's card
  });
  document.addEventListener('pointerdown', e => { if (menuFor !== null && !pageMenu.contains(e.target)) closePageMenu(false); });
  window.addEventListener('resize', placeMenu);
  window.addEventListener('scroll', placeMenu, true);

  // Dragging a page: the bar shows which side of the page under the pointer it will land on.
  function wirePageDrag(cell, i) {
    cell.addEventListener('dragstart', e => {
      const keys = movingKeysFor(i);
      pageDrag = { keys: keys, set: new Set(keys) };
      dropAt = null;
      try { e.dataTransfer.setData('text/plain', 'pages'); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
      if (keys.length > 1 && e.dataTransfer && e.dataTransfer.setDragImage) {
        const ghost = el('div', 'drag-ghost', keys.length + ' pages');
        document.body.appendChild(ghost);
        try { e.dataTransfer.setDragImage(ghost, 24, 20); } catch (err) {}
        setTimeout(() => ghost.remove(), 0);
      }
      setTimeout(() => { if (pageDrag) thumbGrid.querySelectorAll('.thumb-cell').forEach(c => c.classList.toggle('is-dragging', pageDrag.set.has(c.dataset.key))); }, 0);
    });
    cell.addEventListener('dragover', e => {
      if (!pageDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (pageDrag.set.has(cell.dataset.key)) { setDropAt(null, null); return; }
      const r = cell.getBoundingClientRect();
      setDropAt({ key: cell.dataset.key, side: e.clientX < r.left + r.width / 2 ? 'before' : 'after' }, cell);
    });
    cell.addEventListener('drop', e => {
      if (!pageDrag) return;
      e.preventDefault();
      e.stopPropagation();
      finishPageDrag(false);
    });
    cell.addEventListener('dragend', () => finishPageDrag(true));
  }
  thumbGrid.addEventListener('dragover', e => { if (!pageDrag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  thumbGrid.addEventListener('dragleave', e => { if (pageDrag && !thumbGrid.contains(e.relatedTarget)) setDropAt(null, null); });
  thumbGrid.addEventListener('drop', e => { if (!pageDrag) return; e.preventDefault(); finishPageDrag(false); });

  function setDropAt(target, cell) {
    if (dropCell && dropCell !== cell) dropCell.classList.remove('is-over-before', 'is-over-after');
    dropAt = target;
    dropCell = target ? cell : null;
    if (cell) {
      cell.classList.toggle('is-over-before', !!target && target.side === 'before');
      cell.classList.toggle('is-over-after', !!target && target.side === 'after');
    }
  }
  function finishPageDrag(cancelled) {
    const drag = pageDrag, target = dropAt;
    pageDrag = null;
    setDropAt(null, null);
    thumbGrid.querySelectorAll('.thumb-cell.is-dragging').forEach(c => c.classList.remove('is-dragging'));
    if (!drag || cancelled || !target) return;
    const rest = state.pages.map(pageKey).filter(k => !drag.set.has(k));
    const at = rest.indexOf(target.key);
    if (at === -1) return;
    movePages(drag.keys, at + (target.side === 'after' ? 1 : 0));
  }

  // A page is a card you click: every page starts kept, a click cuts it (or keeps it again),
  // shift-click does the same to the whole range since the last click.
  function isKept(index) { return !state.cut.has(keyAt(index)); }
  function setKept(index, on) { const k = keyAt(index); if (on) state.cut.delete(k); else state.cut.add(k); }

  function onCardActivate(index, shiftKey) {
    const on = !isKept(index);
    if (shiftKey && lastClickedIndex !== null) {
      const a = Math.min(lastClickedIndex, index), b = Math.max(lastClickedIndex, index);
      for (let i = a; i <= b; i++) setKept(i, on);
    } else {
      setKept(index, on);
    }
    lastClickedIndex = index;
    updateStage1State();
  }

  function setGroup(sid, on) {
    state.pages.forEach((pg, i) => { if (pg.s === sid) setKept(i, on); });
    updateStage1State();
  }

  function updateStage1State() {
    state.selectedIndices = [];
    state.pages.forEach((pg, i) => { if (!state.cut.has(pageKey(pg))) state.selectedIndices.push(i); });
    // The page the before / after comparison opens on: the first kept page.
    state.keyPageIndex = state.selectedIndices.length ? state.selectedIndices[0] : null;
    thumbGrid.querySelectorAll('.thumb-card').forEach(card => {
      const on = isKept(parseInt(card.dataset.index, 10));
      card.classList.toggle('selected', on);
      card.classList.toggle('cut', !on);
      card.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const n = state.selectedIndices.length;
    const btn = $('btn-continue-1');
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? 'Keep at least one page' : 'Continue — ' + n + (n === 1 ? ' page' : ' pages');
    updateKeepTotals();
  }

  // "Keeping 9 of 12 pages · about 1.8 MB" in the bar. Pages share fonts and images, so their
  // separate sizes add up to more than the file; the estimate shows only once it means something.
  function updateKeepTotals() {
    const elKeep = $('app-keep');
    elKeep.textContent = '';
    if (!state.pages.length || currentStage !== 'stage1') return;
    let sum = 0, known = true, keptN = 0;
    state.pages.forEach(pg => {
      const key = pageKey(pg);
      if (state.cut.has(key)) return;
      keptN++;
      const s = state.pageSizesBefore.get(key);
      if (s === undefined) known = false; else sum += s;
    });
    elKeep.appendChild(document.createTextNode('Keeping '));
    elKeep.appendChild(el('b', null, keptN + ' of ' + state.pages.length));
    const total = goodSources().reduce((n, s) => n + s.size, 0);
    const all = keptN === state.pages.length;
    let tail = ' pages';
    if (keptN && !all && known && sum < total * 0.9) tail += ' · about ' + formatBytes(sum);
    elKeep.appendChild(document.createTextNode(tail));
  }

  // ---- Background work while you pick: measure each page, and shrink a small document --------

  async function measurePage(pg) {
    const lib = await ensureLibDoc(sourceById(pg.s));
    const tempDoc = await PDFLib.PDFDocument.create();
    const [copied] = await tempDoc.copyPages(lib, [pg.p]);
    tempDoc.addPage(copied);
    const bytes = await tempDoc.save();
    return bytes.length;
  }

  // A shrunk page is only good for the settings it was drawn with.
  function settingsKey() { return state.jpegQuality + '|' + (state.grayscale ? 'g' : 'c'); }
  function currentSettings() { return { quality: state.jpegQuality, grayscale: state.grayscale, key: settingsKey() }; }
  function isFreshKey(key) { const cp = state.compressedPages.get(key); return !!cp && cp.key === settingsKey(); }

  // Draw one page as a JPEG with the settings given (captured by the caller, so a slider moved
  // while the page is drawing cannot mislabel it). The picture goes back onto a page of the
  // ORIGINAL size: a sharper picture, not a bigger sheet.
  async function compressPage(index, settings) {
    const pg = state.pages[index];
    const src = sourceById(pg.s);
    if (!src || !src.pdfDoc) throw new Error('The file is gone.');
    const page = await src.pdfDoc.getPage(pg.p + 1);
    const base = page.getViewport({ scale: 1 });
    let scale = 2;
    const area = base.width * base.height;
    if (area * scale * scale > MAX_RASTER_PIXELS) scale = Math.sqrt(MAX_RASTER_PIXELS / area);
    for (let attempt = 0; attempt < 2; attempt++) {
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (settings.grayscale) {
        // Desaturate in place with a blend mode: works everywhere, and needs no second canvas.
        ctx.globalCompositeOperation = 'saturation';
        ctx.fillStyle = '#808080';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
      }
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', settings.quality));
      canvas.width = canvas.height = 0;
      if (blob && blob.size > 0) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { bytes, pageSize: { width: base.width, height: base.height }, size: bytes.length, key: settings.key };
      }
      scale /= 2; // the canvas was too big for this browser: try half the size
    }
    throw new Error('Could not draw this page.');
  }

  function updatePageSizeDisplay(key) {
    const sizeEl = thumbGrid.querySelector('[data-page-size="' + key + '"]');
    if (sizeEl) { const s = state.pageSizesBefore.get(key); sizeEl.textContent = s !== undefined ? formatBytes(s) : '…'; }
    updateKeepTotals();
  }

  async function runBackgroundWork() {
    const run = ++runId;
    const myState = state;
    const n = state.pages.length;
    const autoShrink = n <= AUTO_SHRINK_MAX_PAGES;
    for (let i = 0; i < n; i++) {
      if (runId !== run || state !== myState) return;
      const pg = state.pages[i];
      const key = pageKey(pg);
      const src = sourceById(pg.s);
      if (!src) continue;
      const needMeasure = !state.pageSizesBefore.has(key) && !src.libError;
      const needShrink = autoShrink && !isFreshKey(key);
      if (!needMeasure && !needShrink) continue;
      // The thumbnails she is looking at come first.
      await thumbsIdle(run);
      if (runId !== run) return;
      if (needMeasure) {
        try { const size = await measurePage(pg); if (runId !== run) return; state.pageSizesBefore.set(key, size); updatePageSizeDisplay(key); }
        catch (e) { if (runId !== run) return; const sizeEl = thumbGrid.querySelector('[data-page-size="' + key + '"]'); if (sizeEl && src.libError) sizeEl.textContent = '—'; }
        await yieldToUi();
      }
      if (needShrink) {
        if (runId !== run) return;
        try { const result = await compressPage(i, currentSettings()); if (runId !== run) return; state.compressedPages.set(key, result); } catch (e) {}
        await yieldToUi();
      }
    }
  }

  // ---- Combining and download ----------------------------------------------------------------

  // The kept pages grouped by file, in combining order: [{ src, local: [page indexes], from }],
  // `from` being where the group starts in the output.
  function keptGroups(indices) {
    const groups = [];
    let at = 0;
    indices.forEach(i => {
      const pg = state.pages[i];
      const last = groups[groups.length - 1];
      if (last && last.src.id === pg.s) last.local.push(pg.p); else groups.push({ src: sourceById(pg.s), local: [pg.p], from: at });
      at++;
    });
    return groups;
  }

  // Bookmarks, one per run of pages from the same file, so a reader of the combined set jumps
  // straight to "Civil Plans C2.0 thru C4.1". A file whose pages were moved apart gets a bookmark
  // per run, each saying which of its pages it holds. pdf-lib has no outline API, so the few
  // dictionaries are written by hand.
  function outlineTitle(g, runs) {
    if (runs < 2) return g.src.name;
    const p = g.local.map(x => x + 1);
    const contiguous = p.every((x, i) => i === 0 || x === p[i - 1] + 1);
    const which = p.length === 1 ? 'p. ' + p[0] : contiguous ? 'pp. ' + p[0] + '–' + p[p.length - 1] : 'pp. ' + p.slice(0, 4).join(', ') + (p.length > 4 ? '…' : '');
    return g.src.name + ' (' + which + ')';
  }
  function addOutline(doc, groups) {
    if (groups.length < 2) return;
    const ctx = doc.context;
    const pages = doc.getPages();
    const outlinesRef = ctx.nextRef();
    const refs = groups.map(() => ctx.nextRef());
    const runs = new Map();
    groups.forEach(g => runs.set(g.src.id, (runs.get(g.src.id) || 0) + 1));
    groups.forEach((g, i) => {
      const item = ctx.obj({
        Title: PDFLib.PDFHexString.fromText(outlineTitle(g, runs.get(g.src.id))),
        Parent: outlinesRef,
        Dest: [pages[g.from].ref, 'Fit']
      });
      if (i > 0) item.set(PDFLib.PDFName.of('Prev'), refs[i - 1]);
      if (i < groups.length - 1) item.set(PDFLib.PDFName.of('Next'), refs[i + 1]);
      ctx.assign(refs[i], item);
    });
    ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: groups.length }));
    doc.catalog.set(PDFLib.PDFName.of('Outlines'), outlinesRef);
  }

  // The plain file: every kept page copied as it is, a file at a time. A file whose pages cannot
  // be copied (damaged inside) has its pages re-drawn as pictures instead, and Download says which.
  async function buildPlain(run) {
    const indices = state.selectedIndices.slice();
    const groups = keptGroups(indices);
    const sources = Array.from(new Set(groups.map(g => g.src)));
    const total = indices.length;
    const newDoc = await PDFLib.PDFDocument.create();
    const base = outputBaseFor(goodSources());
    newDoc.setTitle(base);
    const redrawn = [];
    let done = 0;
    for (const g of groups) {
      if (run !== stapleRun) return null;
      progressText.textContent = (groups.length > 1 ? 'Adding ' + g.src.fileName : 'Copying ' + total + (total === 1 ? ' page' : ' pages')) + '…';
      await yieldToUi();
      let copied = false;
      if (!g.src.libError) {
        try {
          const lib = await ensureLibDoc(g.src);
          const pages = await newDoc.copyPages(lib, g.local);
          pages.forEach(p => newDoc.addPage(p));
          copied = true;
        } catch (e) {
          if (!g.src.libError) g.src.libError = 'a structure this tool could not read for copying';
        }
      }
      if (!copied) {
        for (let j = 0; j < g.local.length; j++) {
          if (run !== stapleRun) return null;
          progressText.textContent = 'Re-drawing ' + g.src.fileName + ' · page ' + (j + 1) + ' of ' + g.local.length + '…';
          await yieldToUi();
          const cp = await compressPage(indices[g.from + j], { quality: 0.95, grayscale: false, key: 'plain' });
          const img = await newDoc.embedJpg(cp.bytes);
          const p = newDoc.addPage([cp.pageSize.width, cp.pageSize.height]);
          p.drawImage(img, { x: 0, y: 0, width: cp.pageSize.width, height: cp.pageSize.height });
        }
        redrawn.push({ src: g.src, count: g.local.length });
      }
      done += g.local.length;
      setProgress((done / total) * 90);
    }
    addOutline(newDoc, groups);
    progressText.textContent = 'Saving…';
    await yieldToUi();
    const bytes = await newDoc.save();
    if (run !== stapleRun) return null;
    setProgress(100);
    return { base, bytes, n: total, totalPages: state.pages.length, fileCount: sources.length, combine: goodSources().length > 1, indices, redrawn };
  }

  async function assembleCompressedPdf(selectedIndices) {
    const newDoc = await PDFLib.PDFDocument.create();
    newDoc.setTitle(state.output ? state.output.base : outputBaseFor(goodSources()));
    state.keyPageIndexInCompressed = selectedIndices.indexOf(state.keyPageIndex);
    for (const idx of selectedIndices) {
      const cp = state.compressedPages.get(keyAt(idx));
      const img = await newDoc.embedJpg(cp.bytes);
      const pdfPage = newDoc.addPage([cp.pageSize.width, cp.pageSize.height]);
      pdfPage.drawImage(img, { x: 0, y: 0, width: cp.pageSize.width, height: cp.pageSize.height });
    }
    addOutline(newDoc, keptGroups(selectedIndices));
    state.compressedPdfBytes = await newDoc.save();
  }

  async function assembleAndContinue() {
    stopJobs();
    const run = ++stapleRun;
    showStage('stage2');
    $('progress-title').textContent = goodSources().length > 1 ? 'Combining the pages' : 'Copying the pages';
    progressText.textContent = 'Preparing…';
    setProgress(0);
    await yieldToUi();
    // Every kept file's pdf-lib copy must be in: one may still be opening, or being unlocked.
    const keptSources = Array.from(new Set(state.selectedIndices.map(i => state.pages[i].s))).map(sourceById);
    await Promise.all(keptSources.map(s => ensureLibDoc(s).catch(() => null)));
    if (run !== stapleRun) return;
    const output = await buildPlain(run);
    if (!output || run !== stapleRun) return;
    state.output = output;
    state.filteredPdfBytes = output.bytes;
    state.keyPageIndexInFiltered = state.selectedIndices.indexOf(state.keyPageIndex);
    const allFresh = state.selectedIndices.every(i => isFreshKey(keyAt(i)));
    if (allFresh) {
      await assembleCompressedPdf(state.selectedIndices);
      if (run !== stapleRun) return;
      state.shrinkStatus = 'done';
    } else {
      state.shrinkStatus = 'pending';
      state.compressedPdfBytes = null;
    }
    renderDownloadStage();
    showStage('stage3');
    announce((output.combine ? 'Combined PDF ready: ' : 'Ready: ') + output.n + ' pages, ' + formatBytes(output.bytes.length) + '.');
    // Shrinking starts on its own for a small set.
    if (!allFresh && state.selectedIndices.length <= AUTO_SHRINK_MAX_PAGES) runShrink();
  }

  // "1-3_5_8-9" for a file name; a long list becomes a count.
  function pageRangeLabel(indices, totalPages) {
    if (indices.length === totalPages) return 'all-pages';
    const parts = [];
    let a = null, b = null;
    indices.forEach(i => {
      const n = i + 1;
      if (a === null) { a = b = n; } else if (n === b + 1) { b = n; } else { parts.push(a === b ? String(a) : a + '-' + b); a = b = n; }
    });
    if (a !== null) parts.push(a === b ? String(a) : a + '-' + b);
    const label = parts.join('_');
    return label.length <= 30 ? 'pages-' + label : indices.length + '-pages';
  }

  // What the files have in common, up to a whole word: "CBA TX San Antonio" from eight sheet sets.
  function commonPrefix(names) {
    if (!names.length) return '';
    let p = names[0];
    for (const n of names.slice(1)) {
      let i = 0;
      while (i < p.length && i < n.length && p[i].toLowerCase() === n[i].toLowerCase()) i++;
      p = p.slice(0, i);
    }
    const endsOnWord = names.every(n => n.length === p.length || /[\s_\-.]/.test(n[p.length]));
    if (!endsOnWord) { const m = p.match(/^(.*)[\s_\-.]/); p = m ? m[1] : ''; }
    p = p.replace(/[\s_\-.]+$/, '');
    return p.length >= 3 ? p : '';
  }

  function outputBaseFor(sources) {
    if (sources.length === 1) return sources[0].name;
    const p = commonPrefix(sources.map(s => s.name));
    return p ? p + '-combined' : 'combined';
  }
  // Several files: "<prefix>-combined.pdf", or "<prefix>-combined-61-pages.pdf" after cuts. One
  // file keeps the page list in its name, the stripper's way: "name-pages-1-3_5.pdf".
  function plainFileName() {
    const o = state.output;
    if (!o) return 'combined.pdf';
    if (o.combine) return o.base + (o.n === o.totalPages ? '' : '-' + o.n + '-pages') + '.pdf';
    return o.base + '-' + pageRangeLabel(o.indices, o.totalPages) + '.pdf';
  }
  function shrinkFileName(shrinkWins) { return (state.output ? state.output.base : 'combined') + (shrinkWins ? '-small' : '-pictures') + '.pdf'; }

  // Step 4: two downloads, and an honest word on which one suits THIS set. Shrinking re-draws
  // each page as a JPEG: good for scans and photos, bad for a PDF that is already text or lines.
  function renderDownloadStage() {
    const o = state.output;
    const n = state.selectedIndices.length;
    const orig = state.filteredPdfBytes.length;
    const tagPages = $('tag-pages'), tagShrink = $('tag-shrink'), sizeShrink = $('size-shrink');
    const btnPages = $('btn-download-pages'), btnShrink = $('btn-download');
    $('title-pages').textContent = o.combine ? 'One combined PDF' : 'Just these pages';
    $('sub-pages').textContent = o.combine ? n + (n === 1 ? ' page' : ' pages') + ' from ' + o.fileCount + (o.fileCount === 1 ? ' file' : ' files') + ', with a bookmark for each file' : '';
    $('desc-pages').textContent = o.combine
      ? 'The pages exactly as they are — text stays sharp, selectable and searchable. Nothing is re-drawn.'
      : 'The pages exactly as they are — text stays sharp, selectable and searchable. Nothing is re-drawn.';
    $('size-pages').textContent = formatBytes(orig);
    btnPages.textContent = 'Download ' + plainFileName();
    // An honest word under the plain file when some of it had to be re-drawn, or stays locked.
    const warns = [];
    if (o.redrawn.length) {
      const list = o.redrawn.map(r => r.count + (r.count === 1 ? ' page' : ' pages') + ' from ' + r.src.fileName).join(', ');
      const redrawnPages = o.redrawn.reduce((t, r) => t + r.count, 0);
      warns.push(list + (redrawnPages === 1 ? ' was' : ' were') + ' re-drawn as pictures, because ' + (o.redrawn.length === 1 ? 'that file has ' + o.redrawn[0].src.libError : 'those files have damaged pages inside') + '. Everything else is copied as it is.');
    }
    const securedKept = state.selectedIndices.filter(i => { const s = sourceById(state.pages[i].s); return s && s.encrypted && !s.unlocked; }).length;
    if (securedKept) warns.push((securedKept === n ? 'These pages come' : securedKept + ' of these pages come') + ' from a secured PDF that could not be unlocked. Copying keeps the lock on them, and some viewers show such pages blank: open the download and check. Shrink it re-draws every page, so it always works.');
    const warn = $('pages-warn');
    warn.classList.toggle('hidden', !warns.length);
    warn.textContent = warns.join(' ');
    const st = state.shrinkStatus;
    const done = st === 'done';
    tagPages.classList.remove('is-bad', 'is-quiet');
    tagShrink.classList.remove('is-bad');
    sizeShrink.classList.remove('is-bad');
    $('btn-shrink-estimate').classList.toggle('hidden', done || st === 'working');
    $('btn-shrink-estimate').textContent = st === 'failed' ? 'Try again' : 'Estimate the shrunk size';
    $('shrink-controls').classList.toggle('hidden', !done && st !== 'working');
    $('compare-row').classList.toggle('hidden', !done);
    btnShrink.classList.toggle('hidden', !done);
    btnShrink.disabled = !done;
    $('btn-compare').disabled = !done;
    $('compare-page').disabled = !done;
    sizeShrink.classList.toggle('is-quiet', !done);
    let shrinkWins = false;
    if (done) {
      const comp = state.compressedPdfBytes.length;
      sizeShrink.textContent = formatBytes(comp);
      shrinkWins = comp < orig * 0.95;
      const ratio = orig > 0 ? comp / orig : 1;
      if (shrinkWins) {
        tagShrink.textContent = 'Best for this set · ' + Math.round((1 - ratio) * 100) + '% smaller';
        tagPages.textContent = 'Untouched';
        tagPages.classList.add('is-quiet');
      } else {
        tagPages.textContent = 'Best for this set';
        tagShrink.textContent = ratio >= 1.5 ? 'Not worth it here · ' + (ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)) + '× bigger' : ratio > 1.05 ? 'Not worth it here · bigger' : 'Not worth it here · about the same';
      }
      tagShrink.classList.toggle('is-bad', !shrinkWins);
      sizeShrink.classList.toggle('is-bad', !shrinkWins);
      btnShrink.textContent = (shrinkWins ? 'Download ' : 'Download anyway · ') + shrinkFileName(shrinkWins);
    } else {
      tagPages.textContent = 'Ready';
      if (st === 'working') {
        tagShrink.textContent = 'Re-drawing ' + n + (n === 1 ? ' page' : ' pages');
        if (!/^Working/.test(sizeShrink.textContent)) sizeShrink.textContent = 'Working…';
      } else if (st === 'failed') {
        tagShrink.textContent = 'Could not shrink this set';
        sizeShrink.textContent = '—';
      } else {
        tagShrink.textContent = 'Need it smaller for email?';
        sizeShrink.textContent = n + (n === 1 ? ' page' : ' pages') + ' to re-draw · takes a while';
      }
    }
    $('opt-pages').classList.toggle('is-best', !shrinkWins);
    $('opt-shrink').classList.toggle('is-best', shrinkWins);
    btnPages.classList.toggle('btn-secondary', shrinkWins);
    btnShrink.classList.toggle('btn-secondary', !shrinkWins);
    const select = $('compare-page');
    const current = state.keyPageIndex;
    select.innerHTML = '';
    state.selectedIndices.forEach(i => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = 'page ' + (i + 1);
      if (i === current) opt.selected = true;
      select.appendChild(opt);
    });
    setComparePage(parseInt(select.value, 10));
  }

  function setComparePage(index) {
    state.keyPageIndex = index;
    state.keyPageIndexInFiltered = state.selectedIndices.indexOf(index);
    state.keyPageIndexInCompressed = state.selectedIndices.indexOf(index);
  }

  // Shrinking at Download: re-draw every kept page that is not already drawn at the current
  // settings, then put them together. Runs on its own for a small set; a big one waits for the
  // Estimate button. Any change of settings, step or page list starts it over or stops it.
  function scheduleReshrink() {
    if (currentStage !== 'stage3' || state.shrinkStatus === 'pending') return; // settings apply when it is estimated
    if (reshrinkTimer) clearTimeout(reshrinkTimer);
    reshrinkTimer = setTimeout(() => { reshrinkTimer = null; runShrink(); }, 400);
  }
  async function runShrink() {
    if (currentStage !== 'stage3') return;
    const run = ++shrinkRun;
    const myState = state;
    state.shrinkStatus = 'working';
    renderDownloadStage();
    const indices = state.selectedIndices.slice();
    const sizeEl = $('size-shrink');
    try {
      // Draw until every kept page matches the settings as they stand NOW: the slider may move
      // while a page is drawing, and a finished result must never mix qualities.
      let pass = 0;
      do {
        for (let j = 0; j < indices.length; j++) {
          if (run !== shrinkRun || state !== myState) return;
          if (isFreshKey(keyAt(indices[j]))) continue;
          sizeEl.textContent = 'Working… page ' + (j + 1) + ' of ' + indices.length;
          await yieldToUi();
          const result = await compressPage(indices[j], currentSettings());
          if (run !== shrinkRun || state !== myState) return;
          state.compressedPages.set(keyAt(indices[j]), result);
        }
        pass++;
      } while (pass < 10 && !indices.every(i => isFreshKey(keyAt(i))));
      sizeEl.textContent = 'Working… putting it together';
      await yieldToUi();
      await assembleCompressedPdf(indices);
      if (run !== shrinkRun || state !== myState) return;
      state.shrinkStatus = 'done';
      renderDownloadStage();
      const comp = state.compressedPdfBytes.length, orig = state.filteredPdfBytes.length;
      announce('Shrunk size: ' + formatBytes(comp) + ', ' + (comp < orig * 0.95 ? 'smaller than the original.' : 'not smaller than the original.'));
    } catch (err) {
      if (run !== shrinkRun || state !== myState) return;
      state.shrinkStatus = 'failed';
      renderDownloadStage();
    }
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Save a file: the share sheet on an iPhone or iPad (where a download lands in Files with no
  // word from the app), a plain download everywhere else.
  async function saveFile(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (IS_IOS && navigator.canShare) {
      try {
        const file = new File([blob], name, { type: 'application/pdf' });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // The before / after window must be opened in the click itself, or a browser blocks it.
  function openKeyPagePdfs() {
    if (!state.filteredPdfBytes || !state.compressedPdfBytes) return;
    const w = window.open('', 'key-compare', 'width=1200,height=800');
    if (!w) { note('The browser blocked the compare window. Allow pop-ups for this page and try again.'); return; }
    try { w.document.write('<!DOCTYPE html><title>Before / after</title><p style="font-family:sans-serif;padding:1rem">Preparing the two pages…</p>'); } catch (e) {}
    (async () => {
      const filteredDoc = await PDFLib.PDFDocument.load(state.filteredPdfBytes);
      const compressedDoc = await PDFLib.PDFDocument.load(state.compressedPdfBytes);
      const beforeDoc = await PDFLib.PDFDocument.create();
      const afterDoc = await PDFLib.PDFDocument.create();
      const beforePages = await beforeDoc.copyPages(filteredDoc, [state.keyPageIndexInFiltered]);
      const afterPages = await afterDoc.copyPages(compressedDoc, [state.keyPageIndexInCompressed]);
      beforePages.forEach(p => beforeDoc.addPage(p));
      afterPages.forEach(p => afterDoc.addPage(p));
      const beforeUrl = URL.createObjectURL(new Blob([await beforeDoc.save()], { type: 'application/pdf' }));
      const afterUrl = URL.createObjectURL(new Blob([await afterDoc.save()], { type: 'application/pdf' }));
      const html = '<!DOCTYPE html><html><head><title>Key Page: Before vs After</title><style>body{font-family:sans-serif;margin:0;padding:1rem;display:flex;gap:1rem;align-items:flex-start;min-height:100vh;box-sizing:border-box}body>*{box-sizing:border-box}.panel{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center}.panel h2{margin:0 0 0.5rem;font-size:1rem;color:#333}object{width:100%;min-height:80vh;border:1px solid #ddd;border-radius:4px}</style></head><body><div class="panel"><h2>Before compression</h2><object data="' + beforeUrl + '" type="application/pdf"></object></div><div class="panel"><h2>After compression</h2><object data="' + afterUrl + '" type="application/pdf"></object></div></body></html>';
      w.location.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    })().catch(() => { try { w.close(); } catch (e) {} note('Could not open the comparison.'); });
  }

  function startOver(silent) {
    if (!silent && state.sources.length && !window.confirm('Start over? The files and your page picks are cleared.')) return;
    stopJobs();
    state.sources.forEach(destroySource);
    state = freshState();
    state.jpegQuality = parseInt(qualitySlider.value, 10) / 100;
    state.grayscale = $('grayscale-checkbox').checked;
    lastClickedIndex = null;
    dragFrom = null;
    dragDepth = 0;
    pendingFocus = null;
    focusedCard = 0;
    thumbCache.clear();
    thumbQueue.length = 0;
    if (thumbObserver) thumbObserver.disconnect();
    coverCache.clear();
    coverQueue.length = 0;
    if (coverObserver) coverObserver.disconnect();
    marked.clear();
    pageDrag = null;
    pendingFocusKey = null;
    closePageMenu(false);
    thumbGrid.innerHTML = '';
    $('file-legend').innerHTML = '';
    $('move-bar').classList.add('hidden');
    filesList.innerHTML = '';
    $('files-total').textContent = '';
    $('files-warn').textContent = '';
    $('drop-status').textContent = '';
    clearNotes();
    setError($('drop-error'), '');
    setError($('files-error'), '');
    setError($('stage1-error'), '');
    showStage('drop');
    dropZone.focus({ preventScroll: true });
  }

  function backToFiles() {
    stopJobs();
    clearNotes();
    renderFilesList();
    showStage('files');
  }
  function backToPages() {
    stopJobs();
    clearNotes();
    showStage('stage1');
    runBackgroundWork();
  }

  // ---- Wiring ----------------------------------------------------------------------------------

  const qualitySlider = $('quality-slider');
  const qualityValue = $('quality-value');
  function updateQualityDisplay() {
    const val = qualitySlider.value;
    state.jpegQuality = parseInt(val, 10) / 100;
    qualityValue.textContent = val;
  }
  qualitySlider.addEventListener('input', () => { updateQualityDisplay(); scheduleReshrink(); });
  $('grayscale-checkbox').addEventListener('change', () => { state.grayscale = $('grayscale-checkbox').checked; scheduleReshrink(); });
  updateQualityDisplay();
  showStage('drop', false);

  function hasFiles(e) { return Array.from((e.dataTransfer && e.dataTransfer.types) || []).indexOf('Files') !== -1; }

  dropZone.addEventListener('click', () => { fileInput.click(); });
  dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  dropZone.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    addFiles(e.dataTransfer && e.dataTransfer.files);
  });

  // The Files step is a drop target too: drop more PDFs anywhere on the list. (A counter, because
  // dragenter / dragleave fire for every child on the way across.)
  stageFiles.addEventListener('dragenter', e => { if (dragFrom !== null || !hasFiles(e)) return; e.preventDefault(); dragDepth++; stageFiles.classList.add('dragover'); });
  stageFiles.addEventListener('dragover', e => { if (dragFrom !== null || !hasFiles(e)) return; e.preventDefault(); });
  stageFiles.addEventListener('dragleave', () => { if (dragDepth > 0) dragDepth--; if (!dragDepth) stageFiles.classList.remove('dragover'); });
  stageFiles.addEventListener('drop', e => {
    dragDepth = 0;
    stageFiles.classList.remove('dragover');
    if (dragFrom !== null || !hasFiles(e)) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  // A PDF dropped anywhere else on the page must not replace the app with that PDF, which is
  // the browser's default. Past step 1 it simply joins the list; not while the pages are being
  // combined.
  document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (dragFrom !== null || pageDrag !== null || currentStage === 'stage2' || dropZone.contains(e.target) || stageFiles.contains(e.target)) return;
    addFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (files && files.length) addFiles(files);
    fileInput.value = '';
  });

  // A done step in the bar is a way back to it.
  document.querySelectorAll('.app-step').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('is-done')) return;
      const step = btn.dataset.step;
      if (step === 'drop') { stopJobs(); clearNotes(); showStage('drop'); }
      else if (step === 'files') backToFiles();
      else if (step === 'stage1') backToPages();
    });
  });

  $('btn-add-files').addEventListener('click', () => { fileInput.click(); });
  $('btn-add-files-pages').addEventListener('click', () => { fileInput.click(); });
  $('btn-sort-files').addEventListener('click', sortSources);
  document.querySelectorAll('.view-switch button').forEach(b => b.addEventListener('click', () => setFilesView(b.dataset.view)));
  applyFilesView();
  $('btn-start-over-files').addEventListener('click', () => startOver(false));
  $('btn-continue-files').addEventListener('click', startPicking);

  $('btn-select-all').addEventListener('click', () => { state.cut.clear(); updateStage1State(); });
  $('btn-deselect-all').addEventListener('click', () => { state.pages.forEach(pg => state.cut.add(pageKey(pg))); updateStage1State(); });
  $('btn-invert').addEventListener('click', () => { state.pages.forEach((pg, i) => setKept(i, !isKept(i))); updateStage1State(); });
  $('btn-sort-pages').addEventListener('click', sortPagesByFile);
  $('btn-move-front').addEventListener('click', () => movePages(markedKeys(), 0, 'the front'));
  $('btn-move-end').addEventListener('click', () => movePages(markedKeys(), state.pages.length, 'the end'));
  $('btn-move-clear').addEventListener('click', clearMarks);
  $('btn-back-1').addEventListener('click', backToFiles);
  $('btn-continue-1').addEventListener('click', () => {
    setError($('stage1-error'), '');
    assembleAndContinue().catch(err => {
      setError($('stage1-error'), 'Could not put the pages together: ' + ((err && err.message) || 'unknown error') + '.');
      showStage('stage1');
      runBackgroundWork();
    });
  });
  $('btn-download').addEventListener('click', () => {
    if (!state.compressedPdfBytes || !state.filteredPdfBytes) return;
    saveFile(state.compressedPdfBytes, shrinkFileName(state.compressedPdfBytes.length < state.filteredPdfBytes.length * 0.95));
  });
  $('btn-download-pages').addEventListener('click', () => {
    if (!state.filteredPdfBytes) return;
    saveFile(state.filteredPdfBytes, plainFileName());
  });
  $('btn-shrink-estimate').addEventListener('click', () => { runShrink(); });
  $('compare-page').addEventListener('change', e => setComparePage(parseInt(e.target.value, 10)));
  $('btn-compare').addEventListener('click', openKeyPagePdfs);
  $('btn-back-3').addEventListener('click', backToPages);
  $('btn-start-over').addEventListener('click', () => startOver(false));
})();
