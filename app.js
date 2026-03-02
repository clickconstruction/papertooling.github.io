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

  const stageDrop = $('stage-drop');
  const stage1 = $('stage-1');
  const stage2Overlay = $('stage-2-overlay');
  const stage3 = $('stage-3');
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  const thumbGrid = $('thumb-grid');
  const progressText = $('progress-text');
  const progressFill = $('progress-fill');
  const resultSummary = $('result-summary');

  function showStage(name) {
    stageDrop.classList.toggle('hidden', name !== 'drop');
    stage1.classList.toggle('hidden', name !== 'stage1');
    stage2Overlay.classList.toggle('hidden', name !== 'stage2');
    stage3.classList.toggle('hidden', name !== 'stage3');
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

  function buildThumbCards() {
    thumbGrid.innerHTML = '';
    for (let i = 0; i < state.numPages; i++) {
      const pageNum = i + 1;
      const card = document.createElement('div');
      card.className = 'thumb-card';
      card.dataset.index = String(i);
      const placeholder = document.createElement('div');
      placeholder.className = 'thumb-placeholder';
      placeholder.textContent = 'Page ' + pageNum + '\u2026';
      card.appendChild(placeholder);
      const controls = document.createElement('div');
      controls.className = 'thumb-controls';
      const keepLabel = document.createElement('label');
      const keepCb = document.createElement('input');
      keepCb.type = 'checkbox';
      keepCb.dataset.index = String(i);
      keepCb.addEventListener('change', updateStage1State);
      keepLabel.appendChild(keepCb);
      keepLabel.appendChild(document.createTextNode(' Keep page ' + pageNum));
      controls.appendChild(keepLabel);
      const keyLabel = document.createElement('label');
      const keyRadio = document.createElement('input');
      keyRadio.type = 'radio';
      keyRadio.name = 'key-page';
      keyRadio.dataset.index = String(i);
      keyRadio.addEventListener('change', updateStage1State);
      keyLabel.appendChild(keyRadio);
      keyLabel.appendChild(document.createTextNode(' Key page'));
      controls.appendChild(keyLabel);
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'page-size';
      sizeSpan.dataset.pageSize = String(i);
      sizeSpan.textContent = 'Analyzing\u2026';
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
    const checkboxes = thumbGrid.querySelectorAll('input[type="checkbox"]');
    const radios = thumbGrid.querySelectorAll('input[name="key-page"]');
    state.selectedIndices = [];
    checkboxes.forEach((cb, i) => {
      if (cb.checked) state.selectedIndices.push(i);
    });
    const checkedRadio = thumbGrid.querySelector('input[name="key-page"]:checked');
    state.keyPageIndex = checkedRadio ? parseInt(checkedRadio.dataset.index, 10) : null;
    if (state.keyPageIndex !== null && !state.selectedIndices.includes(state.keyPageIndex)) {
      state.keyPageIndex = null;
      checkedRadio.checked = false;
    }
    if (state.selectedIndices.length > 0 && state.keyPageIndex === null) {
      state.keyPageIndex = state.selectedIndices[0];
      const radioToCheck = thumbGrid.querySelector('input[name="key-page"][data-index="' + state.keyPageIndex + '"]');
      if (radioToCheck) radioToCheck.checked = true;
    }
    radios.forEach(r => {
      const idx = parseInt(r.dataset.index, 10);
      r.disabled = !state.selectedIndices.includes(idx);
    });
    thumbGrid.querySelectorAll('.thumb-card').forEach(card => {
      const idx = parseInt(card.dataset.index, 10);
      card.classList.toggle('selected', state.selectedIndices.includes(idx));
      card.classList.toggle('key-page', state.keyPageIndex === idx);
    });
    const canContinue = state.selectedIndices.length > 0 && state.keyPageIndex !== null;
    $('btn-continue-1').disabled = !canContinue;
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
    return { dataUri: jpegDataUri, viewport: { width: viewport.width, height: viewport.height }, size };
  }

  function updatePageSizeDisplay(index) {
    const el = thumbGrid.querySelector('[data-page-size="' + index + '"]');
    if (!el) return;
    const before = state.pageSizesBefore[index];
    const after = state.pageSizesAfter[index];
    if (before !== undefined && after !== undefined) {
      el.textContent = formatBytes(before) + ' \u2192 ' + formatBytes(after);
    } else if (before !== undefined) {
      el.textContent = formatBytes(before) + ' \u2192 \u2026';
    } else {
      el.textContent = 'Analyzing\u2026';
    }
  }

  function updateBackgroundStatus(done, total) {
    const el = $('background-status');
    if (done >= total) {
      el.classList.add('hidden');
      el.textContent = '';
    } else {
      el.classList.remove('hidden');
      el.textContent = 'Compressing in background: ' + done + '/' + total + ' pages';
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
    const missing = selectedIndices.filter(i => !state.compressedPages[i]);
    if (missing.length === 0) {
      await assembleCompressedPdf(selectedIndices);
      const origSize = state.filteredPdfBytes.length;
      const compSize = state.compressedPdfBytes.length;
      const pct = origSize > 0 ? Math.round((1 - compSize / origSize) * 100) : 0;
      resultSummary.innerHTML = '<p><strong>Original (filtered):</strong> ' + formatBytes(origSize) + '</p><p><strong>Compressed:</strong> ' + formatBytes(compSize) + '</p><p><strong>Reduction:</strong> ' + pct + '%</p>';
      showStage('stage3');
      return;
    }
    showStage('stage2');
    const total = missing.length;
    for (let j = 0; j < total; j++) {
      const idx = missing[j];
      progressText.textContent = 'Compressing remaining page ' + (j + 1) + ' of ' + total + '...';
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
    await assembleCompressedPdf(selectedIndices);
    const origSize = state.filteredPdfBytes.length;
    const compSize = state.compressedPdfBytes.length;
    const pct = origSize > 0 ? Math.round((1 - compSize / origSize) * 100) : 0;
    resultSummary.innerHTML = '<p><strong>Original (filtered):</strong> ' + formatBytes(origSize) + '</p><p><strong>Compressed:</strong> ' + formatBytes(compSize) + '</p><p><strong>Reduction:</strong> ' + pct + '%</p>';
    showStage('stage3');
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
  qualitySlider.addEventListener('input', updateQualityDisplay);
  updateQualityDisplay();

  dropZone.addEventListener('click', (e) => {
    if (e.target.closest('.quality-control') || e.target.closest('.grayscale-option')) return;
    fileInput.click();
  });
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
    thumbGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
    const first = thumbGrid.querySelector('input[type="radio"]');
    if (first && !thumbGrid.querySelector('input[name="key-page"]:checked')) first.checked = true;
    updateStage1State();
  });
  $('btn-deselect-all').addEventListener('click', () => {
    thumbGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    thumbGrid.querySelectorAll('input[name="key-page"]').forEach(r => { r.checked = false; });
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
    downloadBlob(blob, state.fileName + '-compressed.pdf');
  });
  $('btn-compare').addEventListener('click', openKeyPagePdfs);
  $('btn-start-over').addEventListener('click', () => {
    state = { pdfDoc: null, pdfBytes: null, numPages: 0, selectedIndices: [], keyPageIndex: null, filteredPdfBytes: null, compressedPdfBytes: null, keyPageIndexInFiltered: null, keyPageIndexInCompressed: null, fileName: 'document.pdf', pageSizesBefore: [], pageSizesAfter: [], compressedPages: [], runId: 0, jpegQuality: 0.97, grayscale: false };
    showStage('drop');
  });
})();
