'use strict';

// The "PDF Worker" hub: a home page of tools and a focused page for each one
// (pick files → options → result). Tools reuse the editor's engine behind the scenes, so every
// result can be opened in the full editor.

const ICONS = {
  merge: '<path d="M6 3v5a4 4 0 004 4h4a4 4 0 014 4v5"/><path d="M18 3v5a4 4 0 01-4 4"/><path d="M3 6l3-3 3 3M15 6l3-3 3 3"/>',
  split: '<path d="M12 3v6"/><path d="M12 9c0 4-6 5-6 9v3M12 9c0 4 6 5 6 9v3"/><path d="M3 18l3 3 3-3M15 18l3 3 3-3"/>',
  remove: '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5M9.5 14h6"/>',
  extract: '<path d="M6 2h8l5 5v6M6 2v20h7"/><path d="M14 2v5h5M16 17h6M19 14l3 3-3 3"/>',
  organize: '<rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1"/>',
  rotate: '<path d="M20 4v5h-5"/><path d="M19 9a8 8 0 1 0 1 5"/>',
  compress: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  ocr: '<path d="M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3"/><path d="M7 9h10M7 12h10M7 15h6"/>',
  images: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5-8 8"/>',
  word: '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5M8.5 11l1.5 6 2-4.5 2 4.5 1.5-6"/>',
  text: '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5M9 12h7M9 15h7M9 18h4"/>',
  toImage: '<path d="M6 2h8l5 5v4M6 2v20h5"/><path d="M14 2v5h5"/><rect x="13" y="14" width="9" height="7" rx="1"/><path d="M13 19l3-2.5 2 2 1-1 3 2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  sign: '<path d="M3 16c2 0 3-6 5-6s1 5 3 5 2-3 4-3 2 2 6 2M3 21h18"/>',
  form: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h1M12 8h4M8 12h1M12 12h4M8 16h1M12 16h4"/>',
  comment: '<path d="M4 4h16v12H10l-6 4z"/><path d="M8 8h8M8 12h5"/>',
  numbers: '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5M10 13h5M10 17h5M11.5 11l-1 8M14 11l-1 8"/>',
  watermark: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/>',
  redact: '<rect x="3" y="8" width="18" height="8" rx="1" fill="currentColor"/><path d="M3 4h10M3 20h7M15 20h6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/>',
};

const CATEGORIES = [
  { id: 'organize', name: 'Organize', color: '#ea580c' },
  { id: 'optimize', name: 'Optimize', color: '#16a34a' },
  { id: 'to-pdf', name: 'Convert to PDF', color: '#ca8a04' },
  { id: 'from-pdf', name: 'Convert from PDF', color: '#2563eb' },
  { id: 'edit', name: 'Edit & sign', color: '#7c3aed' },
  { id: 'security', name: 'Security', color: '#475569' },
];

const ACCEPT = {
  // (Tests call app.js helpers lazily: this file loads before app.js.)
  pdf: { attr: 'application/pdf,.pdf', label: 'PDF', test: (f) => isPdfFile(f) },
  pdfimg: { attr: 'application/pdf,.pdf,image/*', label: 'PDF or image', test: (f) => isPdfFile(f) || isImageFile(f) },
  img: { attr: 'image/*', label: 'image', test: (f) => isImageFile(f) },
  docx: { attr: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word (.docx)', test: (f) => /\.docx$/i.test(f.name) },
};

const tv = { tool: null, files: [], sel: new Set(), result: null, carry: null, running: false };

/* ---------------- tool catalog ---------------- */

const TOOLS = [
  {
    id: 'merge', cat: 'organize', icon: 'merge', name: 'Merge PDF', accept: 'pdfimg', multiple: true, kind: 'files',
    desc: 'Combine PDFs and images into one document, in the order you want.',
    cta: 'Merge PDF', next: ['compress', 'page-numbers', 'protect', 'edit'],
    run: async () => {
      await loadQuietly(tv.files.map((f) => f.file));
      if (!state.pages.length) throw new Error('None of the files could be opened.');
      const bytes = await buildFinalPdf(state.pages, {});
      return pdfResult(bytes, 'merged.pdf', 'Your PDFs are merged', `${tv.files.length} files · ${pages(state.pages.length)}`);
    },
  },
  {
    id: 'split', cat: 'organize', icon: 'split', name: 'Split PDF', accept: 'pdf', kind: 'pages',
    desc: 'Split a PDF into separate files: every few pages or custom ranges.',
    cta: 'Split PDF', next: ['merge', 'compress'],
    options: () => `
      <div class="opt-title">Split mode</div>
      <label class="radio"><input type="radio" name="tvSplit" value="every" checked><span>Every <input type="number" id="tvEvery" class="inline-num" min="1" value="1"> page(s)</span></label>
      <label class="radio"><input type="radio" name="tvSplit" value="ranges"><span>Custom ranges</span></label>
      <input id="tvRanges" class="text-input" placeholder="e.g. 1-3, 4-8, 9" spellcheck="false">
      <p class="muted small" id="tvSplitInfo"></p>`,
    onOptions: () => {
      const parts = splitPartsFor(true);
      const map = new Map();
      if (parts) parts.forEach((part, i) => part.forEach((idx) => map.set(state.pages[idx]?.id, i + 1)));
      document.querySelectorAll('#tvMain .pg-card').forEach((card) => {
        const part = map.get(card.dataset.id);
        card.dataset.part = part ? ((part - 1) % 6) + 1 : '';
        card.querySelector('.pg-badge').textContent = part ? `Part ${part}` : '';
      });
      $('tvRun').disabled = !parts;
    },
    run: async () => {
      const parts = splitPartsFor(false);
      if (parts.length === 1) {
        const bytes = await buildFinalPdf(parts[0].map((i) => state.pages[i]), {});
        return pdfResult(bytes, `${state.fileName}-part.pdf`, 'Your PDF is split', pages(parts[0].length));
      }
      const blob = await buildSplitZip(parts);
      return { blob, name: `${state.fileName}-split.zip`, title: 'Your PDF is split', detail: `${parts.length} PDFs in a ZIP file · ${formatBytes(blob.size)}` };
    },
  },
  {
    id: 'remove-pages', cat: 'organize', icon: 'remove', name: 'Remove pages', accept: 'pdf', kind: 'pages', select: 'remove',
    desc: 'Delete pages you don\'t need. Click the pages to remove.',
    cta: 'Remove pages', next: ['compress', 'merge'],
    options: () => '<p class="muted small" id="tvSelInfo">Click pages to mark them for removal.</p>',
    onOptions: () => {
      const n = tv.sel.size;
      $('tvSelInfo').textContent = n ? `${pages(n)} will be removed.` : 'Click pages to mark them for removal.';
      $('tvRun').disabled = !n || n === state.pages.length;
      $('tvRun').textContent = n ? `Remove ${pages(n)}` : 'Remove pages';
    },
    run: async () => {
      const kept = state.pages.filter((p) => !tv.sel.has(p.id));
      const bytes = await buildFinalPdf(kept, {});
      return pdfResult(bytes, `${state.fileName}-edited.pdf`, 'Pages removed', `${pages(kept.length)} left`);
    },
  },
  {
    id: 'extract-pages', cat: 'organize', icon: 'extract', name: 'Extract pages', accept: 'pdf', kind: 'pages', select: 'pick',
    desc: 'Pick pages and save them as a new PDF.',
    cta: 'Extract pages', next: ['merge', 'compress'],
    options: () => `
      <p class="muted small" id="tvSelInfo">Click the pages you want.</p>
      <label class="check"><input type="checkbox" id="tvSeparate"> Save each page as a separate PDF</label>`,
    onOptions: () => {
      const n = tv.sel.size;
      $('tvSelInfo').textContent = n ? `${pages(n)} selected.` : 'Click the pages you want.';
      $('tvRun').disabled = !n;
    },
    run: async () => {
      const chosen = state.pages.filter((p) => tv.sel.has(p.id));
      if ($('tvSeparate').checked && chosen.length > 1) {
        const blob = await buildSplitZip(chosen.map((p) => [state.pages.indexOf(p)]));
        return { blob, name: `${state.fileName}-pages.zip`, title: 'Pages extracted', detail: `${chosen.length} PDFs in a ZIP file · ${formatBytes(blob.size)}` };
      }
      const bytes = await buildFinalPdf(chosen, {});
      return pdfResult(bytes, `${state.fileName}-extract.pdf`, 'Pages extracted', pages(chosen.length));
    },
  },
  {
    id: 'organize', cat: 'organize', icon: 'organize', name: 'Organize pages', accept: 'pdfimg', multiple: true, kind: 'pages', reorder: true,
    desc: 'Drag pages into a new order, rotate or delete them, and add more files.',
    cta: 'Save PDF', next: ['compress', 'page-numbers', 'edit'],
    options: () => '<p class="muted small">Drag pages to reorder. Hover a page to rotate or delete it.</p><button type="button" class="btn" id="tvAddMore">Add more files</button>',
    run: async () => pdfResult(await buildFinalPdf(state.pages, {}), `${state.fileName}-organized.pdf`, 'Your PDF is ready', pages(state.pages.length)),
  },
  {
    id: 'rotate', cat: 'organize', icon: 'rotate', name: 'Rotate PDF', accept: 'pdf', kind: 'pages', rotateOnClick: true,
    desc: 'Turn pages the right way up. Click a page to rotate it.',
    cta: 'Save PDF', next: ['compress', 'merge'],
    options: () => `
      <p class="muted small">Click a page to rotate it clockwise, or rotate every page at once:</p>
      <div class="btn-row"><button type="button" class="btn" id="tvRotL">⟲ All left</button><button type="button" class="btn" id="tvRotR">All right ⟳</button></div>`,
    run: async () => pdfResult(await buildFinalPdf(state.pages, {}), `${state.fileName}-rotated.pdf`, 'Pages rotated', pages(state.pages.length)),
  },
  {
    id: 'compress', cat: 'optimize', icon: 'compress', name: 'Compress PDF', accept: 'pdf', kind: 'single',
    desc: 'Make PDFs smaller by shrinking images, while keeping text sharp.',
    cta: 'Compress PDF', next: ['protect', 'merge', 'pdf-to-jpg'],
    options: () => `
      <div class="opt-title">Compression</div>
      <label class="radio"><input type="radio" name="tvLevel" value="balanced" checked><span><b>Recommended</b> — good quality, smaller file</span></label>
      <label class="radio"><input type="radio" name="tvLevel" value="strong"><span><b>Extreme</b> — smallest file, lower image quality</span></label>`,
    run: async () => {
      const original = state.sources[0].bytes.length;
      const level = document.querySelector('input[name=tvLevel]:checked').value;
      let bytes = await buildFinalPdf(state.pages, { compress: level });
      let detail;
      if (bytes.length >= original * 0.97) {
        bytes = state.sources[0].bytes;
        detail = `This PDF is already well optimized (${formatBytes(original)}).`;
      } else {
        detail = `${formatBytes(original)} → ${formatBytes(bytes.length)} · ${Math.round((1 - bytes.length / original) * 100)}% smaller`;
      }
      return pdfResult(bytes, `${state.fileName}-compressed.pdf`, 'Your PDF is compressed', detail);
    },
  },
  {
    id: 'ocr', cat: 'optimize', icon: 'ocr', name: 'OCR PDF', accept: 'pdfimg', multiple: true, kind: 'single',
    desc: 'Recognize text in scans and photos so the PDF becomes searchable and copyable.',
    cta: 'Make searchable', next: ['pdf-to-word', 'compress', 'edit'],
    options: () => `<label class="stack-field"><span>Document language</span>${languageSelect('tvLang')}</label>
      <label class="check"><input type="checkbox" id="tvOcrAll"> Also redo pages that already have text</label>`,
    run: async () => {
      const targets = $('tvOcrAll').checked ? [...state.pages] : await pagesWithoutText();
      if (targets.length) await runOcr([...new Map(targets.map((p) => [ocrKey(p), p])).values()], $('tvLang').value);
      const lines = state.pages.reduce((n, p) => n + (state.ocr[ocrKey(p)] || []).length, 0);
      const bytes = await buildFinalPdf(state.pages, {});
      const detail = targets.length ? `Recognized ${lines} lines of text on ${pages(targets.length)}` : 'Every page already had searchable text.';
      return pdfResult(bytes, `${state.fileName}-searchable.pdf`, 'Your PDF is searchable', detail);
    },
  },
  {
    id: 'jpg-to-pdf', cat: 'to-pdf', icon: 'images', name: 'Images to PDF', accept: 'img', multiple: true, kind: 'files',
    desc: 'Turn JPG, PNG and other images into a PDF, one image per page.',
    cta: 'Convert to PDF', next: ['compress', 'merge', 'ocr'],
    options: () => `
      <label class="stack-field"><span>Page size</span><select id="tvSize" class="text-input">
        <option value="a4">A4</option><option value="letter">US Letter</option><option value="fit">Same as image</option></select></label>
      <label class="stack-field"><span>Orientation</span><select id="tvOrient" class="text-input">
        <option value="auto">Automatic</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
      <label class="stack-field"><span>Margin</span><select id="tvMargin" class="text-input">
        <option value="0">None</option><option value="20" selected>Small</option><option value="50">Large</option></select></label>`,
    run: async () => {
      const opts = { size: $('tvSize').value, orientation: $('tvOrient').value, margin: Number($('tvMargin').value) };
      await withQuiet(() => addImagePages(tv.files.map((f) => f.file), true, opts));
      state.fileName = tv.files.length === 1 ? tv.files[0].file.name.replace(/\.[^.]+$/, '') : 'images';
      const bytes = await buildFinalPdf(state.pages, {});
      return pdfResult(bytes, `${state.fileName}.pdf`, 'Your images are now a PDF', pages(state.pages.length));
    },
  },
  {
    id: 'word-to-pdf', cat: 'to-pdf', icon: 'word', name: 'Word to PDF', accept: 'docx', kind: 'files',
    desc: 'Convert Word documents (.docx) to PDF, with searchable text.',
    cta: 'Convert to PDF', next: ['compress', 'merge', 'protect'],
    options: () => '<p class="muted small">Pages are laid out in your browser. Fonts that aren\'t installed on this device are replaced with similar ones, so check the result before sharing.</p>',
    run: async () => {
      const file = tv.files[0].file;
      const bytes = await docxToPdf(file);
      const name = file.name.replace(/\.docx$/i, '');
      return pdfResult(bytes, `${name}.pdf`, 'Your document is now a PDF', null, name);
    },
  },
  {
    id: 'pdf-to-jpg', cat: 'from-pdf', icon: 'toImage', name: 'PDF to JPG / PNG', accept: 'pdf', kind: 'single',
    desc: 'Save every page as an image.',
    cta: 'Convert to images', next: ['jpg-to-pdf', 'compress'],
    options: () => `
      <div class="opt-title">Format</div>
      <label class="radio"><input type="radio" name="tvFmt" value="jpeg" checked><span><b>JPG</b> — smaller files</span></label>
      <label class="radio"><input type="radio" name="tvFmt" value="png"><span><b>PNG</b> — sharpest</span></label>
      <label class="stack-field"><span>Quality</span><select id="tvDpi" class="text-input">
        <option value="72">Screen (72 DPI)</option><option value="150" selected>Standard (150 DPI)</option><option value="300">Print (300 DPI)</option></select></label>`,
    run: async () => {
      const files = await renderPagesToImages(state.pages, document.querySelector('input[name=tvFmt]:checked').value, Number($('tvDpi').value));
      if (files.length === 1) return { blob: files[0].blob, name: files[0].name, title: 'Your image is ready', detail: formatBytes(files[0].blob.size) };
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f.blob));
      const blob = await zip.generateAsync({ type: 'blob' });
      return { blob, name: `${state.fileName}-images.zip`, title: 'Your images are ready', detail: `${files.length} images in a ZIP file · ${formatBytes(blob.size)}` };
    },
  },
  {
    id: 'pdf-to-word', cat: 'from-pdf', icon: 'word', name: 'PDF to Word', accept: 'pdf', kind: 'single',
    desc: 'Turn a PDF into an editable Word document (.docx).',
    cta: 'Convert to Word', next: ['pdf-to-text', 'compress'],
    options: () => `
      <p class="muted small">Text, headings and bold/italic styles come across as editable paragraphs. Complex layouts and tables become plain paragraphs, and pages without text are added as pictures.</p>
      <label class="check"><input type="checkbox" id="tvOcr" checked> Recognize text in scanned pages (OCR)</label>
      <label class="stack-field"><span>Scan language</span>${languageSelect('tvLang')}</label>`,
    run: async () => {
      await maybeOcr();
      const blob = await pdfToDocx(state.pages);
      return { blob, name: `${state.fileName}.docx`, title: 'Your Word document is ready', detail: `${pages(state.pages.length)} · ${formatBytes(blob.size)}` };
    },
  },
  {
    id: 'pdf-to-text', cat: 'from-pdf', icon: 'text', name: 'PDF to Text', accept: 'pdf', kind: 'single',
    desc: 'Extract all the text from a PDF into a plain .txt file.',
    cta: 'Extract text', next: ['pdf-to-word'],
    options: () => `
      <label class="check"><input type="checkbox" id="tvOcr" checked> Recognize text in scanned pages (OCR)</label>
      <label class="stack-field"><span>Scan language</span>${languageSelect('tvLang')}</label>`,
    run: async () => {
      await maybeOcr();
      const blob = await pdfToText(state.pages);
      return { blob, name: `${state.fileName}.txt`, title: 'Your text is ready', detail: formatBytes(blob.size) };
    },
  },
  { id: 'edit', cat: 'edit', icon: 'edit', name: 'Edit PDF', accept: 'pdfimg', multiple: true, kind: 'editor', desc: 'Change existing text, add text, images, shapes and more.' },
  { id: 'sign', cat: 'edit', icon: 'sign', name: 'Sign PDF', accept: 'pdf', kind: 'editor', desc: 'Draw or type your signature and place it on the document.', then: () => { setTool('sign'); toast('Click on the page where your signature should go.'); } },
  { id: 'fill-forms', cat: 'edit', icon: 'form', name: 'Fill PDF forms', accept: 'pdf', kind: 'editor', desc: 'Type into form fields, tick boxes and choose options.', then: () => toast(state.sources.some((s) => s.hasForm) ? 'Click a field to fill it in.' : "This PDF has no fillable fields — use the Text tool to type anywhere.") },
  { id: 'annotate', cat: 'edit', icon: 'comment', name: 'Annotate PDF', accept: 'pdf', kind: 'editor', desc: 'Highlight, draw, add comments, shapes and stamps.', then: () => setTool('highlight') },
  { id: 'page-numbers', cat: 'edit', icon: 'numbers', name: 'Add page numbers', accept: 'pdf', kind: 'editor', desc: 'Number pages and add headers or footers.', then: () => openDecorDialog() },
  {
    id: 'watermark', cat: 'edit', icon: 'watermark', name: 'Add watermark', accept: 'pdf', kind: 'editor', desc: 'Stamp text like CONFIDENTIAL or DRAFT across every page.',
    then: () => {
      openDecorDialog();
      $('dNumbers').checked = false;
      $('dWatermark').checked = true;
      if (!$('dWmText').value) $('dWmText').value = 'CONFIDENTIAL';
      previewDecor();
      $('dWmText').select();
    },
  },
  { id: 'redact', cat: 'security', icon: 'redact', name: 'Redact PDF', accept: 'pdf', kind: 'editor', desc: 'Permanently black out sensitive information.', then: () => { setTool('redact'); toast('Drag over what to remove, or use Find (Ctrl+F) → Redact all. It\'s removed for good when you download.'); } },
  {
    id: 'protect', cat: 'security', icon: 'lock', name: 'Protect PDF', accept: 'pdf', kind: 'single',
    desc: 'Add a password so only people who know it can open the file.',
    cta: 'Protect PDF', next: ['compress'],
    options: () => `
      <label class="stack-field"><span>Password</span><input type="password" id="tvPw" class="text-input" autocomplete="new-password"></label>
      <label class="stack-field"><span>Repeat password</span><input type="password" id="tvPw2" class="text-input" autocomplete="new-password"></label>
      <p class="muted small error-text" id="tvPwInfo"></p>
      <div class="opt-title">Allow people who open it to</div>
      <label class="check"><input type="checkbox" id="tvAllowPrint" checked> Print</label>
      <label class="check"><input type="checkbox" id="tvAllowCopy" checked> Copy text</label>
      <label class="check"><input type="checkbox" id="tvAllowEdit"> Edit and fill forms</label>`,
    onOptions: () => {
      const a = $('tvPw').value;
      const b = $('tvPw2').value;
      $('tvPwInfo').textContent = a && b && a !== b ? "Passwords don't match." : '';
      $('tvRun').disabled = !a || a !== b;
    },
    run: async () => {
      const bytes = await buildFinalPdf(state.pages, {});
      const edit = $('tvAllowEdit').checked;
      $('hint').textContent = 'Encrypting…';
      const encrypted = await encryptPdf(bytes, {
        userPassword: $('tvPw').value,
        ownerPassword: randomPassword(),
        permissions: {
          printing: $('tvAllowPrint').checked ? 'highResolution' : undefined,
          copying: $('tvAllowCopy').checked,
          modifying: edit, annotating: edit, fillingForms: edit, documentAssembly: edit,
          contentAccessibility: true,
        },
      });
      return pdfResult(encrypted, `${state.fileName}-protected.pdf`, 'Your PDF is protected', 'Keep the password safe — it can\'t be recovered.', null, false);
    },
  },
  {
    id: 'unlock', cat: 'security', icon: 'unlock', name: 'Unlock PDF', accept: 'pdf', kind: 'single',
    desc: 'Remove the password and restrictions from a PDF you have the password for.',
    cta: 'Unlock PDF', next: ['edit', 'compress'],
    options: () => '<p class="muted small" id="tvUnlockInfo"></p>',
    onOptions: () => {
      const enc = state.sources[0] && state.sources[0].encrypted;
      $('tvUnlockInfo').textContent = enc ? 'Password accepted. The unlocked copy won\'t ask for a password or restrict printing and copying.' : "This PDF isn't password-protected — there's nothing to remove.";
      $('tvRun').disabled = !enc;
    },
    run: async () => pdfResult(state.sources[0].bytes, `${state.fileName}-unlocked.pdf`, 'Your PDF is unlocked', 'No password or restrictions'),
  },
];
const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

/* ---------------- helpers ---------------- */

const pages = (n) => `${n} page${n === 1 ? '' : 's'}`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iconSvg = (name) => `<svg viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;
const catColor = (id) => (CATEGORIES.find((c) => c.id === id) || {}).color || '#2563eb';

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes));
}

function languageSelect(id) {
  const options = [...$('ocrLang').options].map((o) => `<option value="${o.value}">${o.textContent}</option>`).join('');
  return `<select id="${id}" class="text-input">${options}</select>`;
}

async function withQuiet(fn) {
  quietLoad = true;
  try { return await fn(); } finally { quietLoad = false; }
}

// Loads files into the engine as a fresh document, in the given order.
async function loadQuietly(files) {
  dirty = false;
  await withQuiet(async () => {
    resetDocument('document');
    for (const file of files) await openFiles([file], !state.pages.length);
  });
}

function pdfResult(bytes, name, title, detail, fileName, editable = true) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const size = formatBytes(blob.size);
  const full = !detail ? size : detail.includes(size) ? detail : `${detail} · ${size}`;
  return { blob, name, title, detail: full, editable, fileName };
}

async function maybeOcr() {
  if (!$('tvOcr').checked) return;
  const textless = await pagesWithoutText();
  if (textless.length) await runOcr([...new Map(textless.map((p) => [ocrKey(p), p])).values()], $('tvLang').value);
}

function splitPartsFor(quiet) {
  const mode = document.querySelector('input[name=tvSplit]:checked').value;
  const total = state.pages.length;
  const info = $('tvSplitInfo');
  try {
    let parts;
    if (mode === 'ranges') {
      parts = parseRanges($('tvRanges').value, total);
    } else {
      const every = Math.max(1, Math.floor(Number($('tvEvery').value) || 1));
      parts = [];
      for (let i = 0; i < total; i += every) parts.push(Array.from({ length: Math.min(every, total - i) }, (_, k) => i + k));
    }
    info.textContent = `Creates ${parts.length} PDF${parts.length === 1 ? '' : 's'}.`;
    info.classList.remove('error-text');
    return parts;
  } catch (err) {
    info.textContent = err.message;
    info.classList.add('error-text');
    if (quiet) return null;
    throw err;
  }
}

/* ---------------- views & routing ---------------- */

function showView(view) {
  document.body.dataset.view = view;
  $('homeView').hidden = view !== 'home';
  $('toolView').hidden = view !== 'tool';
  if (view === 'editor') {
    document.title = state.pages.length ? `${state.fileName} — PDF Worker` : 'PDF Editor — PDF Worker';
    requestAnimationFrame(() => { renderVisible(); updateCurrent(); });
  } else {
    $('siteScroll').scrollTop = 0;
  }
}

function route() {
  const id = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (tv.running) return;
  if (id === 'edit') {
    showView('editor');
    document.title = 'PDF Editor — PDF Worker';
  } else if (TOOL_BY_ID[id]) {
    showView('tool');
    openTool(TOOL_BY_ID[id]);
  } else {
    showView('home');
    document.title = 'PDF Worker — Free online PDF tools that keep your files private';
  }
}

/* ---------------- home ---------------- */

function renderHome(filter = 'all', query = '') {
  const q = query.trim().toLowerCase();
  const grid = $('homeGrid');
  grid.replaceChildren();
  const tools = TOOLS.filter((t) => (filter === 'all' || t.cat === filter)
    && (!q || `${t.name} ${t.desc}`.toLowerCase().includes(q)));
  for (const t of tools) {
    const a = document.createElement('a');
    a.className = 'tool-card';
    a.href = `#/${t.id}`;
    a.style.setProperty('--tool', catColor(t.cat));
    a.innerHTML = `<span class="tool-icon">${iconSvg(t.icon)}</span><span class="tool-name">${escapeHtml(t.name)}</span><span class="tool-desc">${escapeHtml(t.desc)}</span>`;
    grid.appendChild(a);
  }
  $('homeEmpty').hidden = tools.length > 0;
  document.querySelectorAll('.cat-chip').forEach((c) => c.classList.toggle('active', c.dataset.cat === filter));
}

/* ---------------- tool page ---------------- */

function setStage(stage) {
  $('tvPick').hidden = stage !== 'pick';
  $('tvWork').hidden = stage !== 'work';
  $('tvDone').hidden = stage !== 'done';
}

function openTool(tool) {
  tv.tool = tool;
  tv.files = [];
  tv.sel = new Set();
  tv.result = null;
  document.title = `${tool.name} — PDF Worker`;
  $('toolView').style.setProperty('--tool', catColor(tool.cat));
  $('tvIcon').innerHTML = iconSvg(tool.icon);
  $('tvName').textContent = tool.name;
  $('tvDesc').textContent = tool.desc;
  const accept = ACCEPT[tool.accept];
  $('tvChoose').textContent = `Select ${accept.label} file${tool.multiple ? 's' : ''}`;
  $('tvDropHint').textContent = `or drop ${tool.multiple ? 'them' : 'it'} here`;
  $('tvInput').accept = accept.attr;
  $('tvInput').multiple = !!tool.multiple;
  setStage('pick');
  if (tv.carry) {
    const file = tv.carry;
    tv.carry = null;
    acceptFiles([file]);
  }
}

function hubDrop(files) {
  if (tv.running) return;
  if (document.body.dataset.view === 'tool' && tv.tool && !$('tvPick').hidden) acceptFiles(files);
  else if (document.body.dataset.view === 'tool' && tv.tool && tv.tool.kind === 'files' && tv.tool.multiple && !$('tvWork').hidden) addFileItems(files);
  else if (document.body.dataset.view === 'home') {
    // Dropping files on the home page opens them in the editor.
    location.hash = '#/edit';
    openFiles(files, true);
  }
}

async function acceptFiles(files) {
  const tool = tv.tool;
  const accept = ACCEPT[tool.accept];
  let valid = files.filter(accept.test);
  if (!valid.length) {
    toast(`Please choose ${accept.label} files for ${tool.name}.`);
    return;
  }
  if (!tool.multiple) valid = valid.slice(0, 1);

  if (tool.kind === 'editor') {
    const before = state.pages;
    await openFiles(valid, true);
    if (state.pages === before || !state.pages.length) return; // cancelled or failed
    location.hash = '#/edit';
    if (tool.then) setTimeout(tool.then, 50);
    return;
  }

  if (tool.kind === 'files') {
    tv.files = [];
    await addFileItems(valid);
    renderWork();
    return;
  }

  // single / pages: load into the engine now so the page grid and info are real.
  tv.running = true;
  showProgress(true, 'Opening…');
  try {
    await loadQuietly(valid);
  } finally {
    tv.running = false;
    showProgress(false);
  }
  if (!state.pages.length) return;
  tv.files = valid.map((file) => ({ file }));
  renderWork();
}

async function addFileItems(files) {
  const accept = ACCEPT[tv.tool.accept];
  for (const file of files.filter(accept.test)) {
    const item = { id: uid(), file, thumb: null, info: formatBytes(file.size) };
    tv.files.push(item);
    describeFile(item).then(() => { if (!$('tvWork').hidden) renderFileList(); });
  }
  if (!$('tvWork').hidden) renderFileList();
}

// Thumbnail and page count for a file card.
async function describeFile(item) {
  const { file } = item;
  try {
    if (isImageFile(file)) {
      item.thumb = URL.createObjectURL(file);
    } else if (isPdfFile(file)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksEncrypted(bytes)) { item.info = `${formatBytes(file.size)} · password protected`; item.locked = true; }
      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const scaled = page.getViewport({ scale: 220 / vp.width });
      const c = document.createElement('canvas');
      c.width = Math.ceil(scaled.width);
      c.height = Math.ceil(scaled.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: scaled, intent: 'print' }).promise;
      item.thumb = c.toDataURL('image/jpeg', 0.8);
      item.info = `${pages(doc.numPages)} · ${formatBytes(file.size)}`;
      doc.destroy();
    } else {
      item.info = `${formatBytes(file.size)} · Word document`;
      item.docx = true;
    }
  } catch (err) {
    if (err && err.name === 'PasswordException') item.info = `${formatBytes(file.size)} · password protected`;
  }
}

function renderWork() {
  const tool = tv.tool;
  setStage('work');
  $('tvOptions').innerHTML = tool.options ? tool.options() : '';
  $('tvRun').textContent = tool.cta || 'Continue';
  $('tvRun').disabled = false;
  if (tool.kind === 'files') renderFileList();
  else if (tool.kind === 'pages') renderPageGrid();
  else renderSingle();
  wireOptions();
  if (tool.onOptions) tool.onOptions();
}

function wireOptions() {
  const tool = tv.tool;
  const refresh = () => tool.onOptions && tool.onOptions();
  $('tvOptions').oninput = (e) => {
    if (e.target.id === 'tvRanges') document.querySelector('input[name=tvSplit][value=ranges]').checked = true;
    if (e.target.id === 'tvEvery') document.querySelector('input[name=tvSplit][value=every]').checked = true;
    refresh();
  };
  $('tvOptions').onchange = refresh;
  $('tvOptions').onclick = (e) => {
    const id = e.target.closest('button')?.id;
    if (id === 'tvAddMore') { $('tvInput').dataset.append = '1'; $('tvInput').click(); }
    if (id === 'tvRotL' || id === 'tvRotR') {
      state.pages.forEach((p) => { p.rot = (p.rot + (id === 'tvRotR' ? 90 : 270)) % 360; });
      renderAll();
      renderPageGrid();
    }
  };
}

function renderFileList() {
  const main = $('tvMain');
  main.className = 'tv-main file-grid';
  main.replaceChildren();
  tv.files.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.draggable = tv.files.length > 1;
    card.dataset.id = item.id;
    card.innerHTML = `
      <div class="file-thumb">${item.thumb ? `<img alt="" src="${item.thumb}">` : iconSvg(item.docx ? 'word' : 'text')}</div>
      <div class="file-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
      <div class="file-info">${escapeHtml(item.info)}</div>
      ${tv.files.length > 1 ? `<span class="file-order">${i + 1}</span>` : ''}
      <button type="button" class="file-remove" title="Remove" aria-label="Remove ${escapeHtml(item.file.name)}">&times;</button>`;
    main.appendChild(card);
  });
  if (tv.tool.multiple) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'file-card add-card';
    add.innerHTML = '<span class="add-plus">+</span><span>Add more files</span>';
    add.addEventListener('click', () => { $('tvInput').dataset.append = '1'; $('tvInput').click(); });
    main.appendChild(add);
  }
  $('tvRun').disabled = !tv.files.length;
  if (tv.tool.id === 'merge') $('tvRun').textContent = tv.files.length > 1 ? `Merge ${tv.files.length} files` : 'Merge PDF';
  if (!tv.files.length) setStage('pick');
}

function renderSingle() {
  const main = $('tvMain');
  main.className = 'tv-main single-view';
  const p = state.pages[0];
  const src = state.sources[0];
  main.innerHTML = `
    <div class="single-card">
      <div class="single-thumb"><img alt=""></div>
      <div class="single-meta">
        <div class="file-name">${escapeHtml(tv.files.length > 1 ? `${tv.files.length} files` : tv.files[0].file.name)}</div>
        <div class="file-info">${pages(state.pages.length)}${src ? ` · ${formatBytes(src.bytes.length)}` : ''}${src && src.encrypted ? ' · was password protected' : ''}</div>
        <div class="file-info" id="tvTextInfo"></div>
      </div>
    </div>`;
  if (p) getThumb(p).then((url) => { const img = main.querySelector('img'); if (img) img.src = url; }).catch(() => {});
  if (['ocr', 'pdf-to-word', 'pdf-to-text'].includes(tv.tool.id)) {
    pagesWithoutText().then((list) => {
      const el = $('tvTextInfo');
      if (el) el.textContent = list.length ? `${pages(list.length)} without text (scanned)` : 'All pages have searchable text';
    });
  }
}

function renderPageGrid() {
  const tool = tv.tool;
  const main = $('tvMain');
  main.className = `tv-main page-grid${tool.select === 'remove' ? ' mode-remove' : ''}${tool.select === 'pick' ? ' mode-pick' : ''}`;
  main.replaceChildren();
  state.pages.forEach((p, i) => {
    const { w, h } = pageDims(p);
    const card = document.createElement('div');
    card.className = 'pg-card';
    card.dataset.id = p.id;
    card.draggable = !!tool.reorder;
    card.classList.toggle('selected', tv.sel.has(p.id));
    card.innerHTML = `
      <div class="pg-thumb" style="aspect-ratio:${w}/${h}"><img alt="Page ${i + 1}"></div>
      <div class="pg-num">${i + 1}</div>
      <div class="pg-badge"></div>
      ${tool.reorder ? `<div class="pg-actions">
        <button type="button" data-act="rotl" title="Rotate left">${iconSvg('rotate').replace('<svg', '<svg style="transform:scaleX(-1)"')}</button>
        <button type="button" data-act="rotr" title="Rotate right">${iconSvg('rotate')}</button>
        <button type="button" data-act="del" title="Delete page">&times;</button></div>` : ''}
      ${tool.select ? '<span class="pg-mark"></span>' : ''}`;
    getThumb(p).then((url) => { const img = card.querySelector('img'); if (img) img.src = url; }).catch(() => {});
    main.appendChild(card);
  });
}

// Reorders a file card or page card on a tool page (mouse drag-and-drop or long-press on touch).
function hubMoveItem(dragId, targetId, after) {
  if (!tv.tool || !tv.tool.reorder && tv.tool.kind !== 'files') return;
  const list = tv.tool.kind === 'files' ? tv.files : state.pages;
  const from = list.findIndex((x) => x.id === dragId);
  if (from < 0 || dragId === targetId) return;
  const [moved] = list.splice(from, 1);
  let to = list.findIndex((x) => x.id === targetId);
  if (to < 0) { list.splice(from, 0, moved); return; }
  if (after) to++;
  list.splice(to, 0, moved);
  if (tv.tool.kind === 'files') renderFileList();
  else { renderAll(); renderPageGrid(); }
}

function initToolPage() {
  $('tvChoose').addEventListener('click', () => { delete $('tvInput').dataset.append; $('tvInput').click(); });
  $('tvInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    if ($('tvInput').dataset.append) {
      delete $('tvInput').dataset.append;
      if (tv.tool.kind === 'files') await addFileItems(files);
      else {
        await withQuiet(() => openFiles(files, false));
        renderPageGrid();
      }
    } else {
      acceptFiles(files);
    }
  });
  const drop = $('tvDrop');
  drop.addEventListener('click', (e) => { if (e.target === drop) $('tvChoose').click(); });

  // File cards: remove and drag to reorder.
  const main = $('tvMain');
  main.addEventListener('click', (e) => {
    const tool = tv.tool;
    if (!tool) return;
    const fileCard = e.target.closest('.file-card');
    if (fileCard && e.target.closest('.file-remove')) {
      tv.files = tv.files.filter((f) => f.id !== fileCard.dataset.id);
      renderFileList();
      return;
    }
    const card = e.target.closest('.pg-card');
    if (!card) return;
    const p = findPage(card.dataset.id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'del') {
      if (state.pages.length === 1) { toast('A PDF needs at least one page.'); return; }
      state.pages = state.pages.filter((x) => x !== p);
      renderAll();
      renderPageGrid();
    } else if (act === 'rotl' || act === 'rotr' || tool.rotateOnClick) {
      p.rot = (p.rot + (act === 'rotl' ? 270 : 90)) % 360;
      renderAll();
      renderPageGrid();
    } else if (tool.select) {
      if (tv.sel.has(p.id)) tv.sel.delete(p.id); else tv.sel.add(p.id);
      card.classList.toggle('selected', tv.sel.has(p.id));
      tool.onOptions?.();
    }
  });

  let dragId = null;
  main.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.file-card, .pg-card');
    if (!card) return;
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-pdf-worker', dragId);
    card.classList.add('dragging');
  });
  main.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    main.querySelectorAll('.drop-before, .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    const card = e.target.closest('.file-card:not(.add-card), .pg-card');
    if (!card || card.dataset.id === dragId) return;
    const r = card.getBoundingClientRect();
    card.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });
  main.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const card = e.target.closest('.file-card:not(.add-card), .pg-card');
    main.querySelectorAll('.drop-before, .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    if (card && card.dataset.id !== dragId) {
      const r = card.getBoundingClientRect();
      hubMoveItem(dragId, card.dataset.id, e.clientX >= r.left + r.width / 2);
    }
    dragId = null;
  });
  main.addEventListener('dragend', () => {
    dragId = null;
    main.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging'));
  });

  $('tvReset').addEventListener('click', () => openTool(tv.tool));
  $('tvAgain').addEventListener('click', () => openTool(tv.tool));
  $('tvRun').addEventListener('click', runTool);
  $('tvDownload').addEventListener('click', () => { if (tv.result) saveBlob(tv.result.blob, tv.result.name); });
  $('tvShare').addEventListener('click', () => { if (tv.result && window.shareBlob) window.shareBlob(tv.result.blob, tv.result.name); });
  $('tvEditResult').addEventListener('click', async () => {
    const r = tv.result;
    if (!r || !r.editable) return;
    const file = new File([r.blob], r.name, { type: 'application/pdf' });
    dirty = false;
    await withQuiet(() => openFiles([file], true));
    if (r.fileName) state.fileName = r.fileName;
    location.hash = '#/edit';
  });
  $('tvNext').addEventListener('click', (e) => {
    const link = e.target.closest('[data-next]');
    if (!link || !tv.result) return;
    e.preventDefault();
    tv.carry = new File([tv.result.blob], tv.result.name, { type: tv.result.blob.type });
    location.hash = `#/${link.dataset.next}`;
  });
}

async function runTool() {
  const tool = tv.tool;
  if (!tool || tv.running) return;
  tv.running = true;
  showProgress(true, 'Working…');
  try {
    const result = await tool.run();
    dirty = false;
    tv.result = result;
    showResult(result);
    saveBlob(result.blob, result.name);
  } catch (err) {
    console.error(err);
    toast(err.message ? `Something went wrong: ${err.message}` : 'Something went wrong.');
  } finally {
    tv.running = false;
    showProgress(false);
  }
}

function showResult(result) {
  setStage('done');
  $('tvDoneTitle').textContent = result.title;
  $('tvDoneDetail').textContent = result.detail || '';
  $('tvDownload').textContent = `${NATIVE_APP ? 'Save' : 'Download'} ${result.name.split('.').pop().toUpperCase()}`;
  $('tvEditResult').hidden = !(result.editable && result.blob.type === 'application/pdf');
  const isPdf = result.blob.type === 'application/pdf';
  const next = isPdf ? (tv.tool.next || []).map((id) => TOOL_BY_ID[id]).filter((t) => t && t.accept !== 'img' && t.accept !== 'docx') : [];
  $('tvNextWrap').hidden = !next.length;
  $('tvNext').innerHTML = next.map((t) => `<a href="#/${t.id}" class="next-chip" data-next="${t.id}" style="--tool:${catColor(t.cat)}">${iconSvg(t.icon)}${escapeHtml(t.name)}</a>`).join('');
}

// Mirrors the engine's progress messages (#hint) while a tool page is busy.
function showProgress(on, text) {
  $('tvProgress').hidden = !on;
  if (text) $('tvProgressText').textContent = text;
}

function initHub() {
  // Home: categories, search, tool grid.
  $('homeCats').innerHTML = `<button class="cat-chip active" data-cat="all">All tools</button>${CATEGORIES.map((c) => `<button class="cat-chip" data-cat="${c.id}" style="--tool:${c.color}">${c.name}</button>`).join('')}`;
  let filter = 'all';
  $('homeCats').addEventListener('click', (e) => {
    const chip = e.target.closest('.cat-chip');
    if (!chip) return;
    filter = chip.dataset.cat;
    renderHome(filter, $('homeSearch').value);
  });
  $('homeSearch').addEventListener('input', () => renderHome(filter, $('homeSearch').value));
  renderHome();
  initToolPage();

  new MutationObserver(() => {
    if (!$('tvProgress').hidden && $('hint').textContent) $('tvProgressText').textContent = $('hint').textContent;
  }).observe($('hint'), { childList: true, characterData: true, subtree: true });

  window.addEventListener('hashchange', route);
  route();
}
