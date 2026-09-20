(function() {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js';

  const PDFLib = window.PDFLib;
  const $ = id => document.getElementById(id);

  let state = {
    pdfDoc: null,
    pdfBytes: null,
    numPages: 0,
    selectedIndices: [],
    keyPageIndex: null,
    filteredPdfBytes: null,
    compressedPdfBytes: null,
    keyPageIndexInFiltered: null,
    keyPageIndexInCompressed: null,
    fileName: 'document.pdf',
    pageSizesBefore: [],
    pageSizesAfter: [],
    compressedPages: [],
    runId: 0,
    jpegQuality: 0.97,
    grayscale: false
  };

  let kept = new Set();
  let lastClickedIndex = null;

  const stageDrop = $('stage-drop');
  const stage1 = $('stage-1');
  const stage2Overlay = $('stage-2-overlay');
  const stage3 = $('stage-3');
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  const thumbGrid = $('thumb-grid');
  const progressText = $('progress-text');
  const progressFill = $('progress-fill');

  function showStage(name) {
    stageDrop.classList.toggle('hidden', name !== 'drop');
    stage1.classList.toggle('hidden', name !== 'stage1');
    stage2Overlay.classList.toggle('hidden', name !== 'stage2');
    stage3.classList.toggle('hidden', name !== 'stage3');
    // The step pills: stage 2 is the brief "compressing" overlay on the way to step 3.
    const order = ['drop', 'stage1', 'stage3'];
    const at = order.indexOf(name === 'stage2' ? 'stage3' : name);
    document.querySelectorAll('.app-step').forEach(el => {
      const i = order.indexOf(el.dataset.step);
      el.classList.toggle('is-current', i === at);
      el.classList.toggle('is-done', i < at);
    });
    updateKeepTotals();
    const fileEl = $('app-file');
    if (fileEl) {
      fileEl.textContent = '';
      if (name !== 'drop' && state.pdfBytes) {
        const b = document.createElement('b');
        b.textContent = state.fileName + '.pdf';
        fileEl.appendChild(b);
        fileEl.appendChild(document.createTextNode(' \u00b7 ' + state.numPages + (state.numPages === 1 ? ' page' : ' pages') + ' \u00b7 ' + formatBytes(state.pdfBytes.length)));
      }
    }
  }

  function setError(el, msg) {
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function isPdfData(data) {
    if (!data || data.byteLength < 5) return false;
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    return view[0] === 0x25 && view[1] === 0x50 && view[2] === 0x44 && view[3] === 0x46 && view[4] === 0x2D;
  }

  async function loadPdf(file) {
    const arrayBuffer = await file.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      throw new Error('File is empty.');
    }
    if (!isPdfData(arrayBuffer)) {
      throw new Error('File does not appear to be a valid PDF. It may be corrupted or not a PDF file.');
    }
    state.pdfBytes = new Uint8Array(arrayBuffer);
    state.fileName = file.name.replace(/\.pdf$/i, '') || 'document';
    const dataCopy = arrayBuffer.slice(0);
    const loadingTask = pdfjsLib.getDocument({ data: dataCopy });
    state.pdfDoc = await loadingTask.promise;
    state.numPages = state.pdfDoc.numPages;
    return state.pdfDoc;
  }

  async function renderThumbnail(pageNum, maxWidth) {
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const scale = maxWidth / viewport.width;
    const scaledViewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    return canvas;
  }

  // A page is a card you click: every page starts kept, a click cuts it (or keeps it again),
  // shift-click does the same to the whole range since the last click.
  function setKept(index, on) { if (on) kept.add(index); else kept.delete(index); }

  function onCardActivate(index, shiftKey) {
    const on = !kept.has(index);
    if (shiftKey && lastClickedIndex !== null) {
      const a = Math.min(lastClickedIndex, index), b = Math.max(lastClickedIndex, index);
      for (let i = a; i <= b; i++) setKept(i, on);
    } else {
      setKept(index, on);
    }
    lastClickedIndex = index;
    updateStage1State();
  }

  function buildThumbCards() {
    thumbGrid.innerHTML = '';
    kept = new Set();
    lastClickedIndex = null;
    for (let i = 0; i < state.numPages; i++) {
      const pageNum = i + 1;
      kept.add(i);
      const card = document.createElement('div');
      card.className = 'thumb-card';
      card.dataset.index = String(i);
      card.tabIndex = 0;
      card.setAttribute('role', 'checkbox');
      card.setAttribute('aria-label', 'Keep page ' + pageNum);
      card.addEventListener('click', e => onCardActivate(i, e.shiftKey));
      card.addEventListener('keydown', e => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onCardActivate(i, e.shiftKey); }
      });
      const placeholder = document.createElement('div');
      placeholder.className = 'thumb-placeholder';
      placeholder.textContent = 'Page ' + pageNum + '\u2026';
      card.appendChild(placeholder);
      const controls = document.createElement('div');
      controls.className = 'thumb-controls';
      const numSpan = document.createElement('span');
      numSpan.className = 'page-num';
      numSpan.textContent = String(pageNum);
      controls.appendChild(numSpan);
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'page-size';
      sizeSpan.dataset.pageSize = String(i);
      sizeSpan.textContent = '\u2026';
      controls.appendChild(sizeSpan);
      card.appendChild(controls);
      thumbGrid.appendChild(card);
      renderThumbnail(pageNum, 150).then(canvas => {
        placeholder.replaceWith(canvas);
      }).catch(() => {
        placeholder.textContent = 'Error';
      });
    }
  }

  function updateStage1State() {
    state.selectedIndices = Array.from(kept).sort((a, b) => a - b);
    // The page the before / after comparison opens on: the first kept page.
    state.keyPageIndex = state.selectedIndices.length ? state.selectedIndices[0] : null;
    thumbGrid.querySelectorAll('.thumb-card').forEach(card => {
      const on = kept.has(parseInt(card.dataset.index, 10));
      card.classList.toggle('selected', on);
      card.classList.toggle('cut', !on);
      card.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const n = state.selectedIndices.length;
    const btn = $('btn-continue-1');
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? 'Keep at least one page' : 'Continue \u2014 ' + n + (n === 1 ? ' page' : ' pages');
    updateKeepTotals();
  }

  // "Keeping 9 of 12 pages · 1.8 MB" in the bar; the size firms up as pages are measured.
  function updateKeepTotals() {
    const el = $('app-keep');
    if (!el) return;
    el.textContent = '';
    if (!state.numPages || stage1.classList.contains('hidden')) return;
    let sum = 0, known = true;
    state.selectedIndices.forEach(i => { if (state.pageSizesBefore[i] === undefined) known = false; else sum += state.pageSizesBefore[i]; });
    const b = document.createElement('b');
    b.textContent = state.selectedIndices.length + ' of ' + state.numPages;
    el.appendChild(document.createTextNode('Keeping '));
    el.appendChild(b);
    // Pages share fonts and images, so their separate sizes add up to more than the file;
    // the estimate never exceeds the file itself, and the real number arrives at Download.
    const total = state.pdfBytes ? state.pdfBytes.length : sum;
    const est = state.selectedIndices.length === state.numPages ? total : Math.min(sum, total);
    el.appendChild(document.createTextNode(' pages' + (state.selectedIndices.length && known ? ' \u00b7 about ' + formatBytes(est) : '')));
  }

  async function doFilter() {
    const srcDoc = await PDFLib.PDFDocument.load(state.pdfBytes);
    const newDoc = await PDFLib.PDFDocument.create();
    const copied = await newDoc.copyPages(srcDoc, state.selectedIndices);
    copied.forEach(p => newDoc.addPage(p));
    state.filteredPdfBytes = await newDoc.save();
    state.keyPageIndexInFiltered = state.selectedIndices.indexOf(state.keyPageIndex);
  }

  async function getPageSizeBefore(index) {
    const srcDoc = await PDFLib.PDFDocument.load(state.pdfBytes);
    const tempDoc = await PDFLib.PDFDocument.create();
    const copied = await tempDoc.copyPages(srcDoc, [index]);
    copied.forEach(p => tempDoc.addPage(p));
    const bytes = await tempDoc.save();
    return bytes.length;
  }

  // A shrunk page is only good for the settings it was drawn with.
  function settingsKey() { return state.jpegQuality + '|' + (state.grayscale ? 'g' : 'c'); }
  function isFresh(index) { const cp = state.compressedPages[index]; return !!cp && cp.key === settingsKey(); }

  async function compressPage(index) {
    const page = await state.pdfDoc.getPage(index + 1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    let outputCanvas = canvas;
    if (state.grayscale) {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.filter = 'grayscale(100%)';
      tempCtx.drawImage(canvas, 0, 0);
      outputCanvas = tempCanvas;
    }
    const jpegDataUri = outputCanvas.toDataURL('image/jpeg', state.jpegQuality);
    const blob = await (await fetch(jpegDataUri)).blob();
    const size = blob.size;
    return { dataUri: jpegDataUri, viewport: { width: viewport.width, height: viewport.height }, size, key: settingsKey() };
  }

  function updatePageSizeDisplay(index) {
    const el = thumbGrid.querySelector('[data-page-size="' + index + '"]');
    if (!el) return;
    const before = state.pageSizesBefore[index];
    el.textContent = before !== undefined ? formatBytes(before) : '\u2026';
    updateKeepTotals();
  }

  function updateBackgroundStatus(done, total) {
    const el = $('background-status');
    if (done >= total) {
      el.classList.add('hidden');
      el.textContent = '';
    } else {
      el.classList.remove('hidden');
      el.textContent = 'Measuring pages in the background: ' + done + ' of ' + total;
    }
  }

  async function runBackgroundCompression() {
    const n = state.numPages;
    const startRunId = state.runId;
    state.pageSizesBefore = new Array(n);
    state.pageSizesAfter = new Array(n);
    state.compressedPages = new Array(n);
    updateBackgroundStatus(0, n);
    for (let i = 0; i < n; i++) {
      if (state.runId !== startRunId) return;
      try {
        const beforeSize = await getPageSizeBefore(i);
        if (state.runId !== startRunId) return;
        state.pageSizesBefore[i] = beforeSize;
        updatePageSizeDisplay(i);
        await new Promise(r => setTimeout(r, 0));
        const result = await compressPage(i);
        if (state.runId !== startRunId) return;
        state.compressedPages[i] = result;
        state.pageSizesAfter[i] = result.size;
        updatePageSizeDisplay(i);
        updateBackgroundStatus(i + 1, n);
        await new Promise(r => setTimeout(r, 0));
      } catch (e) {
        if (state.runId !== startRunId) return;
        updatePageSizeDisplay(i);
        updateBackgroundStatus(i + 1, n);
      }
    }
  }

  async function assembleCompressedPdf(selectedIndices) {
    const newDoc = await PDFLib.PDFDocument.create();
    state.keyPageIndexInCompressed = selectedIndices.indexOf(state.keyPageIndex);
    for (const idx of selectedIndices) {
      const cp = state.compressedPages[idx];
      const img = await newDoc.embedJpg(cp.dataUri);
      const pdfPage = newDoc.addPage([cp.viewport.width, cp.viewport.height]);
      pdfPage.drawImage(img, { x: 0, y: 0, width: cp.viewport.width, height: cp.viewport.height });
    }
    state.compressedPdfBytes = await newDoc.save();
  }

  async function assembleAndContinue() {
    await doFilter();
    const selectedIndices = state.selectedIndices;
    const missing = selectedIndices.filter(i => !isFresh(i));
    if (missing.length > 0) {
      showStage('stage2');
      const total = missing.length;
      for (let j = 0; j < total; j++) {
        const idx = missing[j];
        progressText.textContent = 'Measuring page ' + (j + 1) + ' of ' + total + '...';
        progressFill.style.width = (((j + 1) / total) * 100) + '%';
        await new Promise(r => setTimeout(r, 0));
        if (state.pageSizesBefore[idx] === undefined) {
          try {
            state.pageSizesBefore[idx] = await getPageSizeBefore(idx);
          } catch (e) {}
        }
        const result = await compressPage(idx);
        state.compressedPages[idx] = result;
        state.pageSizesAfter[idx] = result.size;
        updatePageSizeDisplay(idx);
      }
    }
    await assembleCompressedPdf(selectedIndices);
    renderDownloadStage();
    showStage('stage3');
  }

  // "1-3_5_8-9" for a file name; a long list becomes a count.
  function pageRangeLabel(indices) {
    if (indices.length === state.numPages) return 'all-pages';
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

  // Step 3: two downloads, and an honest word on which one suits THIS PDF. Shrinking re-draws
  // each page as a JPEG: good for scans and photos, bad for a PDF that is already text.
  function renderDownloadStage() {
    const orig = state.filteredPdfBytes.length;
    const comp = state.compressedPdfBytes.length;
    const shrinkWins = comp < orig * 0.95;
    $('size-pages').textContent = formatBytes(orig);
    $('size-shrink').textContent = formatBytes(comp);
    const tagPages = $('tag-pages'), tagShrink = $('tag-shrink');
    const ratio = orig > 0 ? comp / orig : 1;
    if (shrinkWins) {
      tagShrink.textContent = 'Best for this PDF \u00b7 ' + Math.round((1 - ratio) * 100) + '% smaller';
      tagPages.textContent = 'Untouched';
    } else {
      tagPages.textContent = 'Best for this PDF';
      tagShrink.textContent = ratio >= 1.5 ? 'Not worth it here \u00b7 ' + (ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)) + '\u00d7 bigger' : ratio > 1.05 ? 'Not worth it here \u00b7 bigger' : 'Not worth it here \u00b7 about the same';
    }
    tagShrink.classList.toggle('is-bad', !shrinkWins);
    tagPages.classList.toggle('is-quiet', shrinkWins);
    $('opt-pages').classList.toggle('is-best', !shrinkWins);
    $('opt-shrink').classList.toggle('is-best', shrinkWins);
    $('size-shrink').classList.toggle('is-bad', !shrinkWins);
    $('btn-download-pages').classList.toggle('btn-secondary', shrinkWins);
    $('btn-download').classList.toggle('btn-secondary', !shrinkWins);
    const label = pageRangeLabel(state.selectedIndices);
    $('btn-download-pages').textContent = 'Download ' + state.fileName + '-' + label + '.pdf';
    $('btn-download').textContent = (shrinkWins ? 'Download ' : 'Download anyway \u00b7 ') + state.fileName + '-small.pdf';
    const select = $('compare-page');
    const current = state.keyPageIndex;
    select.innerHTML = '';
    state.selectedIndices.forEach(i => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = 'page ' + (i + 1);
      if (i === current) o.selected = true;
      select.appendChild(o);
    });
    setComparePage(parseInt(select.value, 10));
  }

  function setComparePage(index) {
    state.keyPageIndex = index;
    state.keyPageIndexInFiltered = state.selectedIndices.indexOf(index);
    state.keyPageIndexInCompressed = state.selectedIndices.indexOf(index);
  }

  // Quality or grayscale changed at step 3: re-draw the kept pages with the new settings.
  let reshrinkTimer = null;
  let reshrinkRun = 0;
  function scheduleReshrink() {
    if (stage3.classList.contains('hidden')) return;
    if (reshrinkTimer) clearTimeout(reshrinkTimer);
    reshrinkTimer = setTimeout(reshrink, 400);
  }
  async function reshrink() {
    const run = ++reshrinkRun;
    state.runId = Date.now(); // stops any background pass still drawing at the old settings
    const indices = state.selectedIndices.slice();
    const sizeEl = $('size-shrink');
    $('btn-download').disabled = true;
    $('btn-compare').disabled = true;
    try {
      for (let j = 0; j < indices.length; j++) {
        if (run !== reshrinkRun) return;
        if (isFresh(indices[j])) continue;
        sizeEl.textContent = 'Working\u2026 page ' + (j + 1) + ' of ' + indices.length;
        await new Promise(r => setTimeout(r, 0));
        const result = await compressPage(indices[j]);
        if (run !== reshrinkRun) return;
        state.compressedPages[indices[j]] = result;
        state.pageSizesAfter[indices[j]] = result.size;
      }
      await assembleCompressedPdf(indices);
      if (run !== reshrinkRun) return;
      renderDownloadStage();
    } catch (err) {
      sizeEl.textContent = 'Could not shrink this PDF.';
    } finally {
      if (run === reshrinkRun) { $('btn-download').disabled = false; $('btn-compare').disabled = false; }
    }
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function openKeyPagePdfs() {
    if (!state.filteredPdfBytes || !state.compressedPdfBytes) return;
    (async () => {
      const filteredDoc = await PDFLib.PDFDocument.load(state.filteredPdfBytes);
      const compressedDoc = await PDFLib.PDFDocument.load(state.compressedPdfBytes);
      const beforeDoc = await PDFLib.PDFDocument.create();
      const afterDoc = await PDFLib.PDFDocument.create();
      const beforePages = await beforeDoc.copyPages(filteredDoc, [state.keyPageIndexInFiltered]);
      const afterPages = await afterDoc.copyPages(compressedDoc, [state.keyPageIndexInCompressed]);
      beforePages.forEach(p => beforeDoc.addPage(p));
      afterPages.forEach(p => afterDoc.addPage(p));
      const beforeBytes = await beforeDoc.save();
      const afterBytes = await afterDoc.save();
      const beforeBlob = new Blob([beforeBytes], { type: 'application/pdf' });
      const afterBlob = new Blob([afterBytes], { type: 'application/pdf' });
      const beforeUrl = URL.createObjectURL(beforeBlob);
      const afterUrl = URL.createObjectURL(afterBlob);
      const html = '<!DOCTYPE html><html><head><title>Key Page: Before vs After</title><style>body{font-family:sans-serif;margin:0;padding:1rem;display:flex;gap:1rem;align-items:flex-start;min-height:100vh;box-sizing:border-box}body>*{box-sizing:border-box}.panel{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center}.panel h2{margin:0 0 0.5rem;font-size:1rem;color:#333}object{width:100%;min-height:80vh;border:1px solid #ddd;border-radius:4px}</style></head><body><div class="panel"><h2>Before compression</h2><object data="' + beforeUrl + '" type="application/pdf"></object></div><div class="panel"><h2>After compression</h2><object data="' + afterUrl + '" type="application/pdf"></object></div></body></html>';
      const htmlBlob = new Blob([html], { type: 'text/html' });
      const htmlUrl = URL.createObjectURL(htmlBlob);
      window.open(htmlUrl, 'key-compare', 'width=1200,height=800');
    })();
  }

  const qualitySlider = $('quality-slider');
  const qualityValue = $('quality-value');
  function updateQualityDisplay() {
    const val = qualitySlider.value;
    state.jpegQuality = parseInt(val, 10) / 100;
    qualityValue.textContent = val;
    const headerQuality = $('header-quality');
    if (headerQuality) headerQuality.textContent = val;
  }
  qualitySlider.addEventListener('input', () => { updateQualityDisplay(); scheduleReshrink(); });
  $('grayscale-checkbox').addEventListener('change', () => { state.grayscale = $('grayscale-checkbox').checked; scheduleReshrink(); });
  updateQualityDisplay();
  showStage('drop');

  dropZone.addEventListener('click', () => { fileInput.click(); });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  async function handlePdfFile(file) {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.type === 'application/x-pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) {
      setError($('drop-error'), 'Please choose a PDF file (or a file with .pdf extension).');
      return;
    }
    fileInput.value = '';
    setError($('drop-error'), '');
    setError($('stage1-error'), '');
        state.runId = Date.now();
        state.jpegQuality = parseInt($('quality-slider').value, 10) / 100;
        state.grayscale = $('grayscale-checkbox').checked;
        try {
          await loadPdf(file);
      buildThumbCards();
      showStage('stage1');
      updateStage1State();
      runBackgroundCompression();
    } catch (err) {
      setError($('drop-error'), err.message || 'Failed to load PDF. It may be encrypted or corrupted.');
    }
  }

  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) await handlePdfFile(file);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handlePdfFile(file);
  });

  $('btn-select-all').addEventListener('click', () => {
    for (let i = 0; i < state.numPages; i++) kept.add(i);
    updateStage1State();
  });
  $('btn-deselect-all').addEventListener('click', () => {
    kept.clear();
    updateStage1State();
  });
  $('btn-invert').addEventListener('click', () => {
    for (let i = 0; i < state.numPages; i++) setKept(i, !kept.has(i));
    updateStage1State();
  });
  $('btn-back-1').addEventListener('click', () => { showStage('drop'); });
  $('btn-continue-1').addEventListener('click', () => {
    setError($('stage1-error'), '');
    assembleAndContinue().catch(err => {
      setError($('stage1-error'), err.message || 'Compression failed.');
      showStage('stage1');
    });
  });
  $('btn-download').addEventListener('click', () => {
    const blob = new Blob([state.compressedPdfBytes], { type: 'application/pdf' });
    downloadBlob(blob, state.fileName + '-small.pdf');
  });
  $('btn-download-pages').addEventListener('click', () => {
    const blob = new Blob([state.filteredPdfBytes], { type: 'application/pdf' });
    downloadBlob(blob, state.fileName + '-' + pageRangeLabel(state.selectedIndices) + '.pdf');
  });
  $('compare-page').addEventListener('change', e => setComparePage(parseInt(e.target.value, 10)));
  $('btn-compare').addEventListener('click', openKeyPagePdfs);
  $('btn-back-3').addEventListener('click', () => { showStage('stage1'); });
  $('btn-start-over').addEventListener('click', () => {
    state = { pdfDoc: null, pdfBytes: null, numPages: 0, selectedIndices: [], keyPageIndex: null, filteredPdfBytes: null, compressedPdfBytes: null, keyPageIndexInFiltered: null, keyPageIndexInCompressed: null, fileName: 'document.pdf', pageSizesBefore: [], pageSizesAfter: [], compressedPages: [], runId: 0, jpegQuality: parseInt(qualitySlider.value, 10) / 100, grayscale: $('grayscale-checkbox').checked };
    kept = new Set();
    lastClickedIndex = null;
    showStage('drop');
  });
})();
