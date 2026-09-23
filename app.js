'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const {
  PDFDocument, rgb, degrees, BlendMode, LineCapStyle,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix,
} = PDFLib;

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const viewer = $('viewer');
const pagesEl = $('pages');
const thumbsEl = $('thumbs');

let uidCounter = 0;
const uid = () => Date.now().toString(36) + (uidCounter++).toString(36);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const isTyping = (el) => !!(el && el.closest && el.closest('input, textarea, select, [contenteditable]'));

const TOOL_HINTS = {
  select: 'Click to select. Drag to move, drag the corner to resize, double-click text to edit. Arrows nudge · Ctrl+C/V copy & paste · Ctrl+D duplicate.',
  edittext: 'Click a line of text in the PDF to change it, or drag across text to select and copy it. Deleting an edited line brings the original back.',
  text: 'Click on a page to add text. Click outside or press Esc to finish.',
  draw: 'Drag on a page to draw freehand.',
  highlight: 'Drag over an area to highlight it.',
  shape: 'Drag to draw. Hold Shift for straight lines at 45° steps.',
  whiteout: 'Drag over content to cover it with white. To remove text for good, use Redact or the privacy option when downloading.',
  redact: 'Drag over anything that must be removed. On download, redacted pages become images, so the hidden content is gone for good.',
  note: 'Click to pin a comment. Other PDF viewers show it as a sticky note.',
  stamp: 'Pick a stamp in the toolbar, then click where it goes.',
  image: 'Click on a page where the image should go. You can also paste an image with Ctrl+V.',
  sign: 'Click on a page where your signature should go.',
};
const RECT_KINDS = { highlight: 'highlight', whiteout: 'whiteout', redact: 'redact' };
const NOTE_SIZE = 22;

const STAMPS = {
  approved: { label: 'APPROVED', color: '#15803d' },
  draft: { label: 'DRAFT', color: '#475569' },
  confidential: { label: 'CONFIDENTIAL', color: '#b91c1c' },
  rejected: { label: 'REJECTED', color: '#b91c1c' },
  paid: { label: 'PAID', color: '#1d4ed8' },
  received: { label: 'RECEIVED', color: '#7c3aed', date: true },
  date: { label: '', color: '#1d4ed8', date: true },
  custom: { label: '', color: '#b91c1c' },
};

/*
 * Coordinates: every annotation lives in the page's "base frame" — PDF points,
 * origin top-left, y down, as the page appears with its own /Rotate applied.
 * Extra rotation done in this editor (page.rot) is applied on top via an SVG
 * transform on screen and via /Rotate on export, so annotations rotate with the page.
 */
const state = {
  sources: [],      // { bytes, pdf (pdf.js doc), name, hasForm }
  pages: [],        // { id, src, index, baseW, baseH, rot0, rot, annots: [] }
  images: {},       // id -> { dataUrl, kind: 'png'|'jpg', w, h }
  forms: {},        // form answers changed by the user (see forms.js)
  formDefaults: {}, // answers already in the file
  formOptions: {},  // choice field options, for export
  decor: null,      // page numbers, headers, watermark (see decor.js)
  ocr: {},          // recognized text lines for scanned pages (see textlayer.js)
  tool: 'select',
  colors: { text: '#111827', draw: '#e11d48', highlight: '#facc15', shape: '#2563eb', note: '#fde047', sign: '#1e3a8a' },
  sizes: { text: 16, draw: 3, shape: 2 },
  textStyle: { font: 'sans', bold: false, italic: false },
  shapeKind: 'rect',
  stampKind: 'approved',
  zoom: 1.25,
  selected: null,   // { pageId, annotId }
  current: 0,
  pageSel: new Set(), // pages ticked in the sidebar
  fileName: 'document',
};

const undoStack = [];
const redoStack = [];
let dirty = false;
let drag = null;
let editing = null;
let noteEditing = null;
let pendingPlace = null;
let styleSnap = null;
let clip = null;
let pickAnchor = null;
let quietLoad = false; // tool pages load files without the editor's toasts and confirmations

/* ---------------- helpers ---------------- */

const findPage = (id) => state.pages.find((p) => p.id === id);
const findAnnot = (p, id) => (p ? p.annots.find((a) => a.id === id) : undefined);
const pageElOf = (id) => pagesEl.querySelector(`.page[data-id="${id}"]`);
function selectedAnnot() {
  const s = state.selected;
  return s ? findAnnot(findPage(s.pageId), s.annotId) || null : null;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
  return el;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

function busy(on, msg) {
  document.body.classList.toggle('busy', on);
  $('hint').textContent = on ? msg : (state.pages.length ? TOOL_HINTS[state.tool] : '');
}

const MODALS = ['pwModal', 'sigModal', 'dlModal', 'splitModal', 'decorModal', 'imgModal', 'ocrModal', 'keysModal'];
const inEditor = () => document.body.dataset.view === 'editor';
function openModal(id) {
  $(id).hidden = false;
}
function closeModal(id) {
  $(id).hidden = true;
}
const openModalId = () => MODALS.find((id) => !$(id).hidden);
// Some dialogs need to undo things when dismissed.
function dismissModal(id) {
  if (id === 'pwModal') { if (pwDismiss) pwDismiss(); else closeModal(id); }
  else if (id === 'sigModal') closeSignature();
  else if (id === 'decorModal') closeDecor(false);
  else closeModal(id);
}

// Fingers need bigger targets than a mouse pointer.
const COARSE = window.matchMedia('(pointer: coarse)').matches;
const HANDLE_PX = COARSE ? 24 : 10;
const HIT_PX = COARSE ? 26 : 12;

const measureCtx = document.createElement('canvas').getContext('2d');
// Text annotations using the PDF's original font fall back to a similar family when needed.
const effectiveFamily = (a) => (a.font === 'original' ? a.fallback || 'sans' : a.font);
const fontCss = (a) => `${a.italic ? 'italic ' : ''}${a.bold ? 700 : 400} ${a.size}px ${cssFontStack(effectiveFamily(a))}`;
const origScreenText = (info, text) => [...text].map((ch) => info.screenFor.get(ch) ?? ch).join('');
function textWidth(text, a) {
  const info = a.type === 'text' ? origFontState(a) : null;
  if (info && info.family) {
    measureCtx.font = `${a.size}px "${info.family}"`;
    return measureCtx.measureText(origScreenText(info, text)).width;
  }
  measureCtx.font = fontCss(a);
  return measureCtx.measureText(text).width;
}

const pageDims = (p) => (p.rot % 180 ? { w: p.baseH, h: p.baseW } : { w: p.baseW, h: p.baseH });
function dispSize(p) {
  const { w, h } = pageDims(p);
  return { w: w * state.zoom, h: h * state.zoom };
}

// Maps base frame (y down) -> displayed page after the editor's extra rotation.
function rotMatrix(rot, w, h) {
  switch (rot) {
    case 90: return [0, 1, -1, 0, h, 0];
    case 180: return [-1, 0, 0, -1, w, h];
    case 270: return [0, -1, 1, 0, 0, w];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

function inkPath(points) {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
}

// Where a line's shaft ends and its arrowhead triangle sits (tip, left, right).
function lineGeometry(a) {
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  if (!a.arrow) return { end: [a.x2, a.y2], head: null };
  const hl = Math.min(len, Math.max(10, a.width * 4));
  const hw = hl * 0.5;
  const bx = a.x2 - ux * hl;
  const by = a.y2 - uy * hl;
  return {
    end: [a.x2 - ux * hl * 0.6, a.y2 - uy * hl * 0.6],
    head: [[a.x2, a.y2], [bx - uy * hw, by + ux * hw], [bx + uy * hw, by - ux * hw]],
  };
}

// Text sizes and baselines for a stamp box, shared by screen and export.
function stampLayout(a) {
  const two = !!(a.label && a.sub);
  const main = a.label || a.sub;
  const border = Math.max(1.5, a.h * 0.06);
  const room = Math.max(1, a.w - a.h * 0.45);
  const perPt = (text, bold) => Math.max(0.01, textWidth(text, { font: 'sans', bold, size: 100 }) / 100);
  const size = Math.min(a.h * (two ? 0.4 : 0.52), room / perPt(main, true));
  const subSize = two ? Math.min(a.h * 0.22, room / perPt(a.sub, false)) : 0;
  return {
    two, main, size, subSize, border,
    mainBaseline: two ? a.y + a.h * 0.52 : a.y + a.h / 2 + size * 0.36,
    subBaseline: a.y + a.h * 0.83,
  };
}

function makeStamp() {
  const preset = STAMPS[state.stampKind] || STAMPS.approved;
  const today = todayText();
  let label = preset.label;
  let sub = preset.date ? today : '';
  if (state.stampKind === 'date') { label = today; sub = ''; }
  if (state.stampKind === 'custom') {
    label = $('stampText').value.trim();
    if (!label) {
      toast('Type the stamp text in the toolbar first.');
      $('stampText').focus();
      return null;
    }
  }
  const h = sub ? 58 : 44;
  const probe = { font: 'sans', bold: true, size: 100 };
  const w = Math.max(
    (textWidth(label, probe) / 100) * h * (sub ? 0.4 : 0.52),
    sub ? (textWidth(sub, { ...probe, bold: false }) / 100) * h * 0.22 : 0,
  ) + h * 0.8;
  return { id: uid(), type: 'stamp', x: 0, y: 0, w, h, label, sub, color: preset.color };
}

function annotBounds(a) {
  switch (a.type) {
    case 'text': {
      const lines = a.text.split('\n');
      const w = Math.max(...lines.map((l) => textWidth(l, a)), a.size * 0.5);
      return { x: a.x, y: a.y, w, h: lines.length * a.size * 1.2 };
    }
    case 'ink': {
      const xs = a.points.map((p) => p[0]);
      const ys = a.points.map((p) => p[1]);
      const pad = a.width / 2;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
    }
    case 'line': {
      const pad = a.arrow ? Math.max(10, a.width * 4) * 0.5 : a.width / 2;
      const x = Math.min(a.x1, a.x2) - pad;
      const y = Math.min(a.y1, a.y2) - pad;
      return { x, y, w: Math.abs(a.x2 - a.x1) + pad * 2, h: Math.abs(a.y2 - a.y1) + pad * 2 };
    }
    case 'note':
      return { x: a.x, y: a.y, w: NOTE_SIZE, h: NOTE_SIZE };
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

function translateAnnot(a, orig, dx, dy) {
  if (a.type === 'ink') a.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
  else if (a.type === 'line') Object.assign(a, { x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy });
  else { a.x = orig.x + dx; a.y = orig.y + dy; }
}

function basePoint(svg, e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const r = pt.matrixTransform(svg.querySelector('g.root').getScreenCTM().inverse());
  return { x: r.x, y: r.y };
}

// Base-frame point -> position inside the page element (pixels).
function pagePoint(el, x, y) {
  const pt = el.querySelector('svg.overlay').createSVGPoint();
  pt.x = x;
  pt.y = y;
  return pt.matrixTransform(el.querySelector('g.root').getCTM());
}

// Center of the visible part of a page, in its base frame.
function visibleCenter(p) {
  const el = pageElOf(p.id);
  const r = el.getBoundingClientRect();
  const v = viewer.getBoundingClientRect();
  const clientX = (Math.max(r.left, v.left) + Math.min(r.right, v.right)) / 2;
  const clientY = (Math.max(r.top, v.top) + Math.min(r.bottom, v.bottom)) / 2;
  const pt = basePoint(el.querySelector('svg.overlay'), { clientX, clientY });
  return { x: clamp(pt.x, 0, p.baseW), y: clamp(pt.y, 0, p.baseH) };
}

/* ---------------- history ---------------- */

const snapshot = () => JSON.stringify({ pages: state.pages, forms: state.forms, decor: state.decor });

function pushHistory(snap = snapshot()) {
  undoStack.push(snap);
  if (undoStack.length > 150) undoStack.shift();
  redoStack.length = 0;
  dirty = true;
  updateUI();
}

function restore(snap) {
  const s = JSON.parse(snap);
  state.pages = s.pages;
  state.forms = s.forms || {};
  state.decor = s.decor || null;
  state.selected = null;
  dirty = true;
  renderAll();
}

function undo() {
  finishEdit();
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

function redo() {
  finishEdit();
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

/* ---------------- opening files ---------------- */

const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImageFile = (f) => f.type.startsWith('image/');

function resetDocument(fileName) {
  finishEdit();
  if (!$('searchbar').hidden) closeSearch();
  state.sources.forEach((s) => s.pdf.destroy());
  Object.assign(state, {
    sources: [], pages: [], images: {}, forms: {}, formDefaults: {}, formOptions: {}, decor: null, ocr: {},
    selected: null, current: 0, pageSel: new Set(), fileName,
  });
  undoStack.length = 0;
  redoStack.length = 0;
  thumbCache.clear();
  widgetCache.clear();
  lineCache.clear();
  origFonts.clear();
  inspectDocs.clear();
  imageElements.clear();
  noTextHinted.clear();
  clip = null;
  pagesEl.replaceChildren();
  dirty = false;
}

// Opens or appends any mix of PDFs and images. `replace` starts a new document.
async function openFiles(files, replace) {
  const pdfs = files.filter(isPdfFile);
  const images = files.filter((f) => !isPdfFile(f) && isImageFile(f));
  if (!pdfs.length && !images.length) {
    toast('Choose PDF or image files.');
    return;
  }
  if (replace && dirty && state.pages.length && !confirm('Open a new file? Your unsaved edits in the editor will be lost.')) return;
  if (pdfs.length) {
    const opened = await loadPdfFiles(replace ? pdfs.slice(0, 1) : pdfs, replace);
    if (opened) replace = false;
    if (pdfs.length > 1 && state.pages.length) await loadPdfFiles(pdfs.slice(1), false);
  }
  if (images.length) await addImagePages(images, replace);
}

async function loadPdfFiles(files, replace) {
  busy(true, 'Opening…');
  try {
    const loaded = [];
    for (const file of files) {
      let bytes = new Uint8Array(await file.arrayBuffer());
      let encrypted = false;
      try {
        const unlocked = await unlockBytes(bytes, file.name);
        if (!unlocked) continue; // password prompt cancelled
        ({ bytes, encrypted } = unlocked);
      } catch (err) {
        console.warn(err);
        toast(`"${file.name}" is protected in a way this app can't open.`);
        continue;
      }
      let pdf;
      try {
        // pdf.js takes ownership of the buffer it is given, so hand it a copy.
        pdf = await pdfjsLib.getDocument({
          data: bytes.slice(),
          fontExtraProperties: true, // keeps character mappings so edits can reuse the PDF's fonts
          cMapUrl: `${PDFJS_CDN}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${PDFJS_CDN}standard_fonts/`,
        }).promise;
      } catch (err) {
        toast(err && err.name === 'PasswordException'
          ? `"${file.name}" is password-protected and can't be opened.`
          : `"${file.name}" doesn't look like a valid PDF.`);
        continue;
      }
      let hasForm = false;
      try { hasForm = !!(await pdf.getFieldObjects()); } catch { /* no form */ }
      const pages = [];
      for (let i = 0; i < pdf.numPages; i++) {
        const page = await pdf.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        pages.push({ id: uid(), index: i, baseW: vp.width, baseH: vp.height, rot0: page.rotate % 360, rot: 0, annots: [] });
      }
      loaded.push({ file, bytes, pdf, pages, hasForm, encrypted });
    }
    if (!loaded.length) return false;

    if (replace) resetDocument(loaded[0].file.name.replace(/\.pdf$/i, '') || 'document');
    else pushHistory();

    const firstNew = state.pages.length;
    for (const l of loaded) {
      const src = state.sources.push({ bytes: l.bytes, pdf: l.pdf, name: l.file.name, hasForm: l.hasForm, encrypted: l.encrypted }) - 1;
      for (const pg of l.pages) state.pages.push({ ...pg, src });
    }
    renderAll();
    if (replace) {
      autoFit();
      viewer.scrollTop = 0;
      if (loaded[0].hasForm && !quietLoad) toast('This PDF has fillable fields — click a field to fill it in.');
    } else if (!quietLoad) {
      scrollToPage(state.pages[firstNew].id);
      const n = state.pages.length - firstNew;
      toast(`Added ${n} page${n === 1 ? '' : 's'}.`);
    }
    return true;
  } finally {
    busy(false);
  }
}

const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89] };

// Each image becomes a page with the image centered. Options: size 'letter' | 'a4' | 'fit'
// (page matches the image), orientation 'auto' | 'portrait' | 'landscape', margin in points.
async function addImagePages(files, replace, { size = 'letter', orientation = 'auto', margin = 24 } = {}) {
  busy(true, 'Adding images…');
  try {
    if (replace) resetDocument(files[0].name.replace(/\.[^.]+$/, '') || 'images');
    const pages = [];
    for (const file of files) {
      try {
        const imageId = await importImageFile(file);
        const im = state.images[imageId];
        let W;
        let H;
        if (size === 'fit') {
          // Keep the image's pixel size at 96 DPI, capped to a reasonable page size.
          const k = Math.min(0.75, 1440 / Math.max(im.w, im.h));
          W = im.w * k + margin * 2;
          H = im.h * k + margin * 2;
        } else {
          const [a, b] = PAGE_SIZES[size] || PAGE_SIZES.letter;
          const landscape = orientation === 'landscape' || (orientation === 'auto' && im.w > im.h);
          W = landscape ? b : a;
          H = landscape ? a : b;
        }
        const s = Math.min((W - margin * 2) / im.w, (H - margin * 2) / im.h);
        const w = im.w * s;
        const h = im.h * s;
        pages.push({
          id: uid(), src: null, index: 0, baseW: W, baseH: H, rot0: 0, rot: 0,
          annots: [{ id: uid(), type: 'image', imageId, x: (W - w) / 2, y: (H - h) / 2, w, h }],
        });
      } catch {
        toast(`"${file.name}" couldn't be read as an image.`);
      }
    }
    if (!pages.length) { renderAll(); return; }
    if (!replace) pushHistory();
    const first = state.pages.length;
    state.pages.push(...pages);
    dirty = true;
    renderAll();
    if (replace) autoFit();
    if (!replace && !quietLoad) scrollToPage(state.pages[first].id);
    if (!quietLoad) toast(`Added ${pages.length} image page${pages.length === 1 ? '' : 's'}.`);
  } finally {
    busy(false);
  }
}

function addBlankPage() {
  finishEdit();
  const ref = state.pages[state.current];
  const { w, h } = ref ? pageDims(ref) : { w: 612, h: 792 }; // US Letter
  const page = { id: uid(), src: null, index: 0, baseW: w, baseH: h, rot0: 0, rot: 0, annots: [] };
  if (state.pages.length) pushHistory();
  else state.fileName = 'untitled';
  const first = !state.pages.length;
  state.pages.splice(state.pages.length ? state.current + 1 : 0, 0, page);
  dirty = true;
  renderAll();
  if (first) autoFit();
  scrollToPage(page.id);
}

/* ---------------- rendering ---------------- */

function renderAll() {
  const existing = new Map([...pagesEl.children].map((el) => [el.dataset.id, el]));
  for (const p of state.pages) {
    let el = existing.get(p.id);
    if (el) existing.delete(p.id);
    else el = createPageEl(p);
    sizePageEl(el, p);
    pagesEl.appendChild(el);
    renderOverlay(p);
    buildFormLayer(el, p);
  }
  for (const el of existing.values()) el.remove();

  const ids = new Set(state.pages.map((p) => p.id));
  for (const id of state.pageSel) if (!ids.has(id)) state.pageSel.delete(id);
  if (state.selected && !selectedAnnot()) state.selected = null;
  state.current = clamp(state.current, 0, Math.max(0, state.pages.length - 1));
  renderThumbs();
  updateUI();
  if (!$('searchbar').hidden && search.query.trim()) runSearch(search.query);
  requestAnimationFrame(() => { renderVisible(); updateCurrent(); });
}

function createPageEl(p) {
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.id = p.id;
  const svg = svgEl('svg', { class: 'overlay', 'data-id': p.id });
  svg.append(svgEl('g', { class: 'decor' }), svgEl('g', { class: 'root' }));
  el.append(document.createElement('canvas'), svg);
  return el;
}

function sizePageEl(el, p) {
  const { w, h } = dispSize(p);
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  const svg = el.querySelector('svg.overlay');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const m = rotMatrix(p.rot, p.baseW, p.baseH).map((v) => v * state.zoom);
  svg.querySelector('g.root').setAttribute('transform', `matrix(${m.join(' ')})`);
  svg.querySelector('g.decor').setAttribute('transform', `scale(${state.zoom})`);
  sizeTextLayer(el, p);
}

function renderVisible() {
  const vr = viewer.getBoundingClientRect();
  const keep = Math.max(3000, vr.height * 4);
  for (const el of pagesEl.children) {
    const r = el.getBoundingClientRect();
    if (r.bottom > vr.top - 1200 && r.top < vr.bottom + 1200) {
      renderCanvas(el);
    } else if (el.dataset.rendered && (r.bottom < vr.top - keep || r.top > vr.bottom + keep)) {
      // Free the pixels of pages far off screen; long documents would otherwise pile up memory.
      const canvas = el.querySelector('canvas');
      renderTasks.get(el)?.cancel();
      canvas.width = canvas.height = 0;
      el.dataset.rendered = '';
    }
  }
}

const renderTasks = new WeakMap();
async function renderCanvas(el) {
  const p = findPage(el.dataset.id);
  if (!p) return;
  const key = `${p.rot}|${state.zoom}`;
  if (el.dataset.rendered === key) return;
  el.dataset.rendered = key;

  const canvas = el.querySelector('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (p.src === null) {
    const { w, h } = dispSize(p);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    buildTextLayer(el, p); // image pages get one after OCR
    return;
  }
  try {
    const source = state.sources[p.src];
    const page = await source.pdf.getPage(p.index + 1);
    if (el.dataset.rendered !== key) return;
    const vp = page.getViewport({ scale: state.zoom * dpr, rotation: (p.rot0 + p.rot) % 360 });
    // Render offscreen, then swap in, so the old image stays visible meanwhile.
    const off = document.createElement('canvas');
    off.width = Math.ceil(vp.width);
    off.height = Math.ceil(vp.height);
    const prev = renderTasks.get(el);
    if (prev) prev.cancel();
    const task = page.render({
      canvasContext: off.getContext('2d'),
      viewport: vp,
      // Form fields are drawn as live inputs instead (forms.js).
      annotationMode: source.hasForm ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE,
    });
    renderTasks.set(el, task);
    await task.promise;
    if (el.dataset.rendered !== key) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(off, 0, 0);
    buildTextLayer(el, p);
  } catch (err) {
    if (!err || err.name !== 'RenderingCancelledException') console.error(err);
    if (el.dataset.rendered === key) el.dataset.rendered = '';
  }
}

function renderOverlay(p) {
  const el = pageElOf(p.id);
  const index = state.pages.indexOf(p);
  if (el) {
    const g = el.querySelector('g.root');
    g.replaceChildren();
    for (const a of p.annots) {
      if (editing && editing.annotId === a.id) {
        if (a.cover) g.appendChild(coverEl(a.cover));
        continue;
      }
      g.appendChild(annotEl(a));
    }
    drawSearchHits(g, p);
    const sel = state.selected;
    if (sel && sel.pageId === p.id) {
      const a = findAnnot(p, sel.annotId);
      if (a) drawSelection(g, a);
    }
    renderDecor(el.querySelector('g.decor'), p, index, state.pages.length);
  }
  renderThumbOverlay(p);
}

const coverEl = (c) => svgEl('rect', { class: 'cover', x: c.x, y: c.y, width: c.w, height: c.h, fill: c.fill });

function annotEl(a) {
  const wrap = svgEl('g', { 'data-aid': a.id, class: `annot annot-${a.type}` });
  switch (a.type) {
    case 'text': {
      if (a.cover) wrap.appendChild(coverEl(a.cover));
      // Preview with the PDF's own font when it's loaded and has every character.
      const info = origFontState(a);
      const useOrig = !!(info && info.family);
      const t = svgEl('text', {
        'font-size': a.size,
        fill: a.color,
        'font-family': useOrig ? `"${info.family}", ${cssFontStack(effectiveFamily(a))}` : cssFontStack(effectiveFamily(a)),
        'font-weight': a.bold && !useOrig ? 700 : 400,
        'font-style': a.italic && !useOrig ? 'italic' : 'normal',
      });
      a.text.split('\n').forEach((line, i) => {
        const ts = svgEl('tspan', { x: a.x, y: a.y + a.size * (0.8 + 1.2 * i) });
        ts.textContent = (useOrig ? origScreenText(info, line) : line) || ' ';
        t.appendChild(ts);
      });
      wrap.appendChild(t);
      break;
    }
    case 'ink': {
      const d = inkPath(a.points);
      wrap.append(
        svgEl('path', { d, class: 'hit', fill: 'none', 'stroke-width': Math.max(a.width + 8, HIT_PX / state.zoom) }),
        svgEl('path', { d, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      );
      break;
    }
    case 'rect': {
      const base = { x: a.x, y: a.y, width: a.w, height: a.h };
      if (a.kind === 'highlight') {
        wrap.appendChild(svgEl('rect', { ...base, fill: a.color, 'fill-opacity': 0.4, style: 'mix-blend-mode:multiply' }));
      } else if (a.kind === 'whiteout') {
        wrap.appendChild(svgEl('rect', { ...base, fill: a.fill || '#fff' }));
      } else if (a.kind === 'redact') {
        wrap.appendChild(svgEl('rect', { ...base, fill: '#000' }));
      } else if (a.kind === 'ellipse') {
        wrap.appendChild(svgEl('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, fill: 'none', stroke: a.color, 'stroke-width': a.width }));
      } else {
        wrap.appendChild(svgEl('rect', { ...base, fill: 'none', stroke: a.color, 'stroke-width': a.width }));
      }
      break;
    }
    case 'line': {
      const geo = lineGeometry(a);
      wrap.append(
        svgEl('path', { d: `M${a.x1} ${a.y1}L${a.x2} ${a.y2}`, class: 'hit', fill: 'none', 'stroke-width': Math.max(a.width + 10, (HIT_PX + 2) / state.zoom) }),
        svgEl('path', { d: `M${a.x1} ${a.y1}L${geo.end[0]} ${geo.end[1]}`, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round' }),
      );
      if (geo.head) {
        const [t, l, r] = geo.head;
        wrap.appendChild(svgEl('path', { d: `M${t[0]} ${t[1]}L${l[0]} ${l[1]}L${r[0]} ${r[1]}Z`, fill: a.color }));
      }
      break;
    }
    case 'note': {
      const s = NOTE_SIZE;
      wrap.append(
        svgEl('rect', { class: 'note-body', x: a.x + 0.5, y: a.y + 0.5, width: s - 1, height: s - 1, rx: 2.5, fill: a.color, stroke: 'rgba(0,0,0,.4)', 'stroke-width': 1 }),
        svgEl('path', { d: `M${a.x + s * 0.22} ${a.y + s * 0.32}h${s * 0.56}M${a.x + s * 0.22} ${a.y + s * 0.5}h${s * 0.56}M${a.x + s * 0.22} ${a.y + s * 0.68}h${s * 0.38}`, stroke: 'rgba(0,0,0,.55)', 'stroke-width': 1.2, fill: 'none' }),
      );
      const title = svgEl('title');
      title.textContent = a.text;
      wrap.appendChild(title);
      break;
    }
    case 'stamp': {
      const s = stampLayout(a);
      const cx = a.x + a.w / 2;
      const text = (content, y, size, weight) => {
        const t = svgEl('text', { x: cx, y, 'font-size': size, 'font-weight': weight, 'text-anchor': 'middle', fill: a.color, 'font-family': cssFontStack('sans') });
        t.textContent = content;
        return t;
      };
      wrap.setAttribute('opacity', 0.9);
      wrap.appendChild(svgEl('rect', {
        x: a.x + s.border / 2, y: a.y + s.border / 2, width: a.w - s.border, height: a.h - s.border, rx: a.h * 0.14,
        fill: 'rgba(255,255,255,0.001)', stroke: a.color, 'stroke-width': s.border,
      }));
      if (s.main) wrap.appendChild(text(s.main, s.mainBaseline, s.size, 700));
      if (s.two) wrap.appendChild(text(a.sub, s.subBaseline, s.subSize, 400));
      break;
    }
    case 'image': {
      const img = state.images[a.imageId];
      wrap.appendChild(svgEl('image', { href: img ? img.dataUrl : '', x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none' }));
      break;
    }
  }
  return wrap;
}

function drawSelection(g, a) {
  const z = state.zoom;
  const s = HANDLE_PX / z;
  const handle = (x, y, end) => g.appendChild(svgEl('rect', {
    class: end ? 'handle end' : 'handle', 'data-end': end, x: x - s / 2, y: y - s / 2, width: s, height: s, 'stroke-width': 1.5 / z,
  }));
  if (a.type === 'line') {
    handle(a.x1, a.y1, '1');
    handle(a.x2, a.y2, '2');
    return;
  }
  const b = annotBounds(a);
  const pad = 4 / z;
  g.appendChild(svgEl('rect', {
    class: 'sel-box', x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2,
    'stroke-width': 1.5 / z, 'stroke-dasharray': `${5 / z} ${3 / z}`,
  }));
  if (a.type !== 'note') handle(b.x + b.w + pad, b.y + b.h + pad);
}

/* ---------------- thumbnails ---------------- */

const thumbCache = new Map();
function getThumb(p) {
  const key = `${p.src}|${p.index}|${p.rot}|${p.baseW}x${p.baseH}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const job = (async () => {
    const c = document.createElement('canvas');
    if (p.src === null) {
      const { w, h } = pageDims(p);
      c.width = 200;
      c.height = Math.round((h / w) * 200);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      return c.toDataURL();
    }
    const page = await state.sources[p.src].pdf.getPage(p.index + 1);
    const rotation = (p.rot0 + p.rot) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const vp = page.getViewport({ scale: 300 / base.width, rotation });
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise;
    return c.toDataURL('image/jpeg', 0.8);
  })();
  thumbCache.set(key, job);
  job.catch(() => thumbCache.delete(key));
  return job;
}

function renderThumbs() {
  thumbsEl.replaceChildren();
  state.pages.forEach((p, i) => {
    const { w, h } = pageDims(p);
    const item = document.createElement('div');
    item.className = 'thumb';
    item.draggable = true;
    item.dataset.id = p.id;
    item.innerHTML = `
      <label class="thumb-check" title="Select page"><input type="checkbox" aria-label="Select page ${i + 1}"></label>
      <div class="thumb-page" style="width:${Math.min(150, (170 * w) / h)}px;aspect-ratio:${w}/${h}"><img alt=""></div>
      <div class="num">${i + 1}</div>`;
    const svg = svgEl('svg', { class: 'thumb-overlay', viewBox: `0 0 ${w} ${h}` });
    svg.append(svgEl('g', { class: 'decor' }), svgEl('g', { class: 'root', transform: `matrix(${rotMatrix(p.rot, p.baseW, p.baseH).join(' ')})` }));
    item.querySelector('.thumb-page').appendChild(svg);
    const img = item.querySelector('img');
    getThumb(p).then((url) => { img.src = url; }).catch(() => {});
    thumbsEl.appendChild(item);
    renderThumbOverlay(p, svg);
  });
  refreshThumbState();
}

function renderThumbOverlay(p, svg = thumbsEl.querySelector(`.thumb[data-id="${p.id}"] svg`)) {
  if (!svg) return;
  svg.querySelector('g.root').replaceChildren(...p.annots.map(annotEl));
  renderDecor(svg.querySelector('g.decor'), p, state.pages.indexOf(p), state.pages.length);
}

function refreshThumbState() {
  [...thumbsEl.children].forEach((t, i) => {
    const picked = state.pageSel.has(t.dataset.id);
    t.classList.toggle('current', i === state.current);
    t.classList.toggle('picked', picked);
    t.querySelector('input').checked = picked;
  });
  const n = state.pages.length;
  const k = state.pageSel.size;
  $('pageCount').textContent = `${n} page${n === 1 ? '' : 's'}`;
  $('btnPickAll').textContent = k ? 'Clear' : 'Select all';
  $('sideSel').textContent = k ? `Actions apply to ${k} selected page${k === 1 ? '' : 's'}` : (n ? `Actions apply to page ${state.current + 1}` : '');
}

// Pages the sidebar actions apply to: ticked pages, or the current page.
function targetPageIds() {
  if (state.pageSel.size) return state.pages.filter((p) => state.pageSel.has(p.id)).map((p) => p.id);
  const p = state.pages[state.current];
  return p ? [p.id] : [];
}

function pickRange(toId) {
  const a = state.pages.findIndex((p) => p.id === pickAnchor);
  const b = state.pages.findIndex((p) => p.id === toId);
  if (a < 0) { state.pageSel.add(toId); return; }
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.pageSel.add(state.pages[i].id);
}

thumbsEl.addEventListener('click', (e) => {
  const item = e.target.closest('.thumb');
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.closest('.thumb-check')) {
    // A label click is followed by a click on its checkbox; only handle the checkbox's.
    if (!e.target.matches('input')) return;
    if (e.shiftKey && pickAnchor) pickRange(id);
    else if (e.target.checked) state.pageSel.add(id);
    else state.pageSel.delete(id);
    pickAnchor = id;
  } else if (e.ctrlKey || e.metaKey) {
    if (state.pageSel.has(id)) state.pageSel.delete(id); else state.pageSel.add(id);
    pickAnchor = id;
  } else if (e.shiftKey) {
    pickRange(id);
  } else {
    state.pageSel.clear();
    pickAnchor = id;
    scrollToPage(id);
    toggleDrawer(false);
  }
  refreshThumbState();
});

let thumbDragId = null;
const clearDropMarks = () => thumbsEl.querySelectorAll('.drop-before, .drop-after')
  .forEach((el) => el.classList.remove('drop-before', 'drop-after'));

thumbsEl.addEventListener('dragstart', (e) => {
  const item = e.target.closest('.thumb');
  if (!item) return;
  thumbDragId = item.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-pdf-page', thumbDragId);
  item.classList.add('dragging');
});
thumbsEl.addEventListener('dragover', (e) => {
  if (!thumbDragId) return;
  e.preventDefault();
  clearDropMarks();
  const item = e.target.closest('.thumb');
  if (!item || item.dataset.id === thumbDragId) return;
  const r = item.getBoundingClientRect();
  item.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
});
// Moves a dragged page (or all ticked pages, if it's one of them) before/after another page.
function movePagesTo(dragId, targetId, after) {
  const moving = state.pageSel.has(dragId) ? targetPageIds() : [dragId];
  if (!targetId || moving.includes(targetId)) return;
  finishEdit();
  pushHistory();
  const moved = state.pages.filter((p) => moving.includes(p.id));
  state.pages = state.pages.filter((p) => !moving.includes(p.id));
  let to = state.pages.findIndex((p) => p.id === targetId);
  if (after) to++;
  state.pages.splice(to, 0, ...moved);
  state.current = to;
  renderAll();
}

thumbsEl.addEventListener('drop', (e) => {
  if (!thumbDragId) return;
  e.preventDefault();
  const item = e.target.closest('.thumb');
  clearDropMarks();
  if (item) {
    const r = item.getBoundingClientRect();
    movePagesTo(thumbDragId, item.dataset.id, e.clientY >= r.top + r.height / 2);
  }
  thumbDragId = null;
});
thumbsEl.addEventListener('dragend', () => {
  thumbDragId = null;
  clearDropMarks();
  thumbsEl.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
});

/* ---------------- page operations ---------------- */

function rotatePages(ids, delta) {
  if (!ids.length) return;
  finishEdit();
  pushHistory();
  for (const id of ids) {
    const p = findPage(id);
    p.rot = (p.rot + delta + 360) % 360;
  }
  renderAll();
}

function duplicatePages(ids) {
  if (!ids.length) return;
  finishEdit();
  pushHistory();
  const indices = ids.map((id) => state.pages.findIndex((p) => p.id === id)).sort((a, b) => b - a);
  for (const idx of indices) {
    const copy = structuredClone(state.pages[idx]);
    copy.id = uid();
    copy.annots.forEach((a) => { a.id = uid(); });
    state.pages.splice(idx + 1, 0, copy);
  }
  renderAll();
  toast(`Duplicated ${ids.length} page${ids.length === 1 ? '' : 's'}.`);
}

function deletePages(ids) {
  if (!ids.length) return;
  if (ids.length === state.pages.length && !confirm('Delete every page?')) return;
  finishEdit();
  pushHistory();
  const firstIdx = state.pages.findIndex((p) => ids.includes(p.id));
  state.pages = state.pages.filter((p) => !ids.includes(p.id));
  ids.forEach((id) => state.pageSel.delete(id));
  state.current = Math.min(firstIdx, state.pages.length - 1);
  renderAll();
}

function scrollToPage(id) {
  const el = pageElOf(id);
  if (el) viewer.scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' });
}

function updateCurrent() {
  const els = [...pagesEl.children];
  const line = viewer.getBoundingClientRect().top + viewer.clientHeight * 0.35;
  let idx = 0;
  els.forEach((el, i) => { if (el.getBoundingClientRect().top <= line) idx = i; });
  if (idx !== state.current) {
    state.current = idx;
    refreshThumbState();
    thumbsEl.children[idx]?.scrollIntoView({ block: 'nearest' });
  }
  $('pageInfo').textContent = els.length ? `Page ${idx + 1} of ${els.length}` : '';
}

let scrollQueued = false;
viewer.addEventListener('scroll', () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    renderVisible();
    updateCurrent();
  });
});
window.addEventListener('resize', () => renderVisible());

/* ---------------- zoom ---------------- */

// The spot on a page under a screen point, so zooming can keep it under the cursor or fingers.
function zoomAnchor(clientX, clientY) {
  let best = null;
  let bestDist = Infinity;
  for (const el of pagesEl.children) {
    const r = el.getBoundingClientRect();
    const dist = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
    if (dist < bestDist) { best = { el, r }; bestDist = dist; }
    if (dist === 0) break;
  }
  if (!best) return null;
  const { el, r } = best;
  return { id: el.dataset.id, fx: (clientX - r.left) / r.width, fy: (clientY - r.top) / r.height, clientX, clientY };
}

function setZoom(z, anchor) {
  z = clamp(Math.round(z * 100) / 100, 0.25, 4);
  if (z === state.zoom) return;
  finishEdit();
  const vr = viewer.getBoundingClientRect();
  const a = anchor || zoomAnchor(vr.left + vr.width / 2, vr.top + vr.height / 2);
  state.zoom = z;
  renderAll();
  const el = a && pageElOf(a.id);
  if (el) {
    viewer.scrollLeft = el.offsetLeft + a.fx * el.offsetWidth - (a.clientX - vr.left);
    viewer.scrollTop = el.offsetTop + a.fy * el.offsetHeight - (a.clientY - vr.top);
  }
}

function fitWidth() {
  if (!state.pages.length) return;
  const widest = Math.max(...state.pages.map((p) => pageDims(p).w));
  const gutter = viewer.clientWidth < 500 ? 24 : 64;
  setZoom((viewer.clientWidth - gutter) / widest);
}

// Newly opened documents that don't fit the window (e.g. on phones) start at fit-width.
function autoFit() {
  if (!state.pages.length || !viewer.clientWidth) return;
  const widest = Math.max(...state.pages.map((p) => pageDims(p).w));
  if (widest * state.zoom > viewer.clientWidth - 32) fitWidth();
}

viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.pages.length) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), zoomAnchor(e.clientX, e.clientY));
}, { passive: false });

/* ---------------- tools & style controls ---------------- */

function setTool(tool) {
  finishEdit();
  state.tool = tool;
  if (tool !== 'select') setSelected(null);
  if (tool !== 'edittext') window.getSelection()?.removeAllRanges();
  updateUI();
}

function setSelected(sel) {
  const prev = state.selected;
  state.selected = sel;
  if (prev) { const p = findPage(prev.pageId); if (p) renderOverlay(p); }
  if (sel && (!prev || prev.pageId !== sel.pageId)) { const p = findPage(sel.pageId); if (p) renderOverlay(p); }
  updateUI();
}

// Which color/size the style controls edit: the selection, or the active tool's defaults.
function styleTarget() {
  const a = selectedAnnot();
  if (a) {
    const noColor = a.type === 'image' || (a.type === 'rect' && (a.kind === 'whiteout' || a.kind === 'redact'));
    let sizeProp = null;
    if (a.type === 'text') sizeProp = 'size';
    else if (a.type === 'ink' || a.type === 'line' || (a.type === 'rect' && (a.kind === 'outline' || a.kind === 'ellipse'))) sizeProp = 'width';
    return { annot: a, color: noColor ? null : a.color, size: sizeProp ? a[sizeProp] : null, sizeProp, label: a.type === 'text' ? 'Font size' : 'Stroke' };
  }
  const t = state.tool;
  return { annot: null, color: state.colors[t] ?? null, size: state.sizes[t] ?? null, label: t === 'text' ? 'Font size' : 'Stroke' };
}

// Text being typed, selected text, or the text tool's defaults.
function textStyleTarget() {
  if (editing) return findAnnot(findPage(editing.pageId), editing.annotId);
  const a = selectedAnnot();
  if (a && a.type === 'text') return a;
  return state.tool === 'text' ? state.textStyle : null;
}

function updateStyleControls() {
  const t = styleTarget();
  const color = $('color');
  color.disabled = t.color == null;
  if (t.color != null) color.value = t.color;
  $('sizeField').hidden = t.size == null;
  if (t.size != null) {
    if (document.activeElement !== $('size')) $('size').value = Math.round(t.size * 10) / 10;
    $('sizeLabel').textContent = t.label;
  }
  const ts = textStyleTarget();
  $('textStyle').hidden = !ts;
  if (ts) {
    $('fontFamily').value = ts.font || 'sans';
    $('btnBold').setAttribute('aria-pressed', String(!!ts.bold));
    $('btnItalic').setAttribute('aria-pressed', String(!!ts.italic));
  }
  $('shapeKinds').hidden = state.tool !== 'shape';
  document.querySelectorAll('[data-shape]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.shape === state.shapeKind)));
  $('stampOptions').hidden = state.tool !== 'stamp';
  $('stampKind').value = state.stampKind;
  $('stampText').hidden = state.stampKind !== 'custom';
  $('selActions').hidden = !state.selected;
  const hasControls = !$('selActions').hidden || !$('textStyle').hidden || !$('shapeKinds').hidden || !$('stampOptions').hidden
    || !$('color').disabled || !$('sizeField').hidden;
  $('contextbar').classList.toggle('empty', !hasControls);
}

function applyTextStyle(prop, value) {
  const target = textStyleTarget();
  if (!target) return;
  if (target !== state.textStyle) {
    if (editing) editing.styleChanged = true;
    else pushHistory();
    // The original embedded font has a fixed weight and style; switch to its look-alike family.
    if (target.font === 'original' && (prop === 'bold' || prop === 'italic')) target.font = effectiveFamily(target);
    target[prop] = value;
    const p = findPage(editing ? editing.pageId : state.selected.pageId);
    renderOverlay(p);
    if (editing) styleEditor(editing.ta, target);
  } else {
    state.textStyle[prop] = value;
  }
  updateUI();
}

$('color').addEventListener('input', (e) => {
  const t = styleTarget();
  if (t.annot) {
    if (!styleSnap) styleSnap = snapshot();
    t.annot.color = e.target.value;
    renderOverlay(findPage(state.selected.pageId));
  } else if (state.tool in state.colors) {
    state.colors[state.tool] = e.target.value;
  }
});
$('size').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (!(v > 0)) return;
  const t = styleTarget();
  if (t.annot && t.sizeProp) {
    if (!styleSnap) styleSnap = snapshot();
    t.annot[t.sizeProp] = clamp(v, 1, 300);
    renderOverlay(findPage(state.selected.pageId));
  } else if (state.tool in state.sizes) {
    state.sizes[state.tool] = clamp(v, 1, 300);
  }
});
const commitStyle = () => { if (styleSnap) { pushHistory(styleSnap); styleSnap = null; } };
$('color').addEventListener('change', commitStyle);
$('size').addEventListener('change', commitStyle);

$('fontFamily').addEventListener('change', (e) => applyTextStyle('font', e.target.value));
$('btnBold').addEventListener('click', () => applyTextStyle('bold', !textStyleTarget()?.bold));
$('btnItalic').addEventListener('click', () => applyTextStyle('italic', !textStyleTarget()?.italic));
// Keep focus in the text being typed when toggling bold/italic.
for (const id of ['btnBold', 'btnItalic']) $(id).addEventListener('pointerdown', (e) => e.preventDefault());

document.querySelectorAll('[data-shape]').forEach((b) => b.addEventListener('click', () => {
  state.shapeKind = b.dataset.shape;
  updateUI();
}));
$('stampKind').addEventListener('change', (e) => {
  state.stampKind = e.target.value;
  updateUI();
  if (state.stampKind === 'custom') $('stampText').focus();
});

function deleteSelected() {
  const a = selectedAnnot();
  if (!a) return;
  const p = findPage(state.selected.pageId);
  pushHistory();
  p.annots = p.annots.filter((x) => x !== a);
  setSelected(null);
  if (a.cover) toast('Edit removed — the original text is back.');
}

function updateUI() {
  const has = state.pages.length > 0;
  document.body.classList.toggle('has-doc', has);
  $('empty').hidden = has;
  for (const id of ['btnMerge', 'btnBlank', 'btnDownload', 'btnZoomIn', 'btnZoomOut', 'btnFit', 'btnFind']) $(id).disabled = !has;
  $('btnUndo').disabled = !undoStack.length;
  $('btnRedo').disabled = !redoStack.length;
  $('btnDelete').disabled = !state.selected;
  $('btnDuplicate').disabled = !state.selected;
  $('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  document.querySelectorAll('[data-needs-doc]').forEach((b) => { b.disabled = !has; });
  viewer.className = `viewer tool-${state.tool}`;
  if (!document.body.classList.contains('busy')) $('hint').textContent = has ? TOOL_HINTS[state.tool] : '';
  if (!has) $('pageInfo').textContent = '';
  updateStyleControls();
}

/* ---------------- pointer interaction ---------------- */

// Named so the touch layer (touch.js) can replay a finger tap through it.
function onPagePointerDown(e) {
  if (e.button !== 0 || e.target.closest('.text-editor, .form-field, .note-editor')) return;
  const svg = e.target.closest('svg.overlay');
  const hadEditor = !!(editing || noteEditing);
  finishEdit();
  if (hadEditor && (state.tool === 'text' || state.tool === 'note')) { e.preventDefault(); return; }
  if (!svg) return;
  const p = findPage(svg.dataset.id);
  const raw = basePoint(svg, e);
  const pt = { x: clamp(raw.x, 0, p.baseW), y: clamp(raw.y, 0, p.baseH) };
  const hitEl = e.target.closest('[data-aid]');
  const hit = hitEl ? findAnnot(p, hitEl.dataset.aid) : null;
  const handleEl = e.target.closest('.handle');
  const tool = state.tool;
  e.preventDefault();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();

  if (tool === 'select' || (handleEl && selectedAnnot())) {
    const sel = selectedAnnot();
    if (handleEl && sel) {
      const mode = handleEl.dataset.end ? 'endpoint' : 'resize';
      drag = { mode, end: handleEl.dataset.end, svg, p, a: sel, start: pt, orig: structuredClone(sel), ob: annotBounds(sel), snap: snapshot(), moved: false };
    } else if (hit) {
      setSelected({ pageId: p.id, annotId: hit.id });
      drag = { mode: 'move', svg, p, a: hit, start: raw, orig: structuredClone(hit), snap: snapshot(), moved: false };
    } else {
      setSelected(null);
      return;
    }
  } else if (tool === 'text') {
    if (hit && hit.type === 'text') { startEdit(p, hit, false, snapshot()); return; }
    const snap = snapshot();
    const size = state.sizes.text;
    const a = { id: uid(), type: 'text', x: pt.x, y: Math.max(0, pt.y - size * 0.6), text: '', size, color: state.colors.text, ...state.textStyle };
    p.annots.push(a);
    startEdit(p, a, true, snap);
    return;
  } else if (tool === 'draw') {
    const snap = snapshot();
    const a = { id: uid(), type: 'ink', points: [[pt.x, pt.y]], width: state.sizes.draw, color: state.colors.draw };
    p.annots.push(a);
    drag = { mode: 'draw', svg, p, a, snap };
  } else if (tool in RECT_KINDS) {
    const snap = snapshot();
    const a = { id: uid(), type: 'rect', kind: RECT_KINDS[tool], x: pt.x, y: pt.y, w: 0, h: 0 };
    if (tool === 'highlight') a.color = state.colors.highlight;
    p.annots.push(a);
    drag = { mode: 'rect', svg, p, a, start: pt, snap };
  } else if (tool === 'shape') {
    const snap = snapshot();
    const kind = state.shapeKind;
    const common = { id: uid(), width: state.sizes.shape, color: state.colors.shape };
    const a = kind === 'line' || kind === 'arrow'
      ? { ...common, type: 'line', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, arrow: kind === 'arrow' }
      : { ...common, type: 'rect', kind: kind === 'ellipse' ? 'ellipse' : 'outline', x: pt.x, y: pt.y, w: 0, h: 0 };
    p.annots.push(a);
    drag = { mode: a.type === 'line' ? 'line' : 'rect', svg, p, a, start: pt, snap };
  } else if (tool === 'note') {
    if (hit && hit.type === 'note') { startNoteEdit(p, hit, false, snapshot()); return; }
    const snap = snapshot();
    const a = {
      id: uid(), type: 'note', text: '', color: state.colors.note,
      x: clamp(pt.x - NOTE_SIZE / 2, 0, p.baseW - NOTE_SIZE), y: clamp(pt.y - NOTE_SIZE / 2, 0, p.baseH - NOTE_SIZE),
    };
    p.annots.push(a);
    startNoteEdit(p, a, true, snap);
    return;
  } else if (tool === 'stamp') {
    const a = makeStamp();
    if (!a) return;
    a.x = clamp(pt.x - a.w / 2, 0, Math.max(0, p.baseW - a.w));
    a.y = clamp(pt.y - a.h / 2, 0, Math.max(0, p.baseH - a.h));
    pushHistory();
    p.annots.push(a);
    setTool('select');
    setSelected({ pageId: p.id, annotId: a.id });
    return;
  } else if (tool === 'image') {
    pendingPlace = { pageId: p.id, pt };
    $('fileImage').value = '';
    $('fileImage').click();
    return;
  } else if (tool === 'sign') {
    pendingPlace = { pageId: p.id, pt };
    openSignature();
    return;
  } else {
    return;
  }
  try { svg.setPointerCapture(e.pointerId); } catch { /* replayed taps have no live pointer */ }
  renderOverlay(p);
}
pagesEl.addEventListener('pointerdown', onPagePointerDown);

// Shift-drag snaps a line to 45° steps.
function snapAngle(x1, y1, x2, y2) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const angle = Math.round(Math.atan2(y2 - y1, x2 - x1) / (Math.PI / 4)) * (Math.PI / 4);
  return [x1 + Math.cos(angle) * len, y1 + Math.sin(angle) * len];
}

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const { p } = drag;
  const raw = basePoint(drag.svg, e);
  const pt = { x: clamp(raw.x, 0, p.baseW), y: clamp(raw.y, 0, p.baseH) };
  switch (drag.mode) {
    case 'move': {
      const dx = raw.x - drag.start.x;
      const dy = raw.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) * state.zoom < 2) return;
      drag.moved = true;
      translateAnnot(drag.a, drag.orig, dx, dy);
      break;
    }
    case 'resize': {
      const { a, orig, ob } = drag;
      const dx = pt.x - drag.start.x;
      const dy = pt.y - drag.start.y;
      if (a.type === 'rect' || a.type === 'image' || a.type === 'stamp') {
        let w = Math.max(4, orig.w + dx);
        let h = Math.max(4, orig.h + dy);
        if ((a.type === 'image' || a.type === 'stamp') && !e.shiftKey) {
          const ratio = orig.w / orig.h;
          if (w / h > ratio) h = w / ratio; else w = h * ratio;
        }
        a.w = w;
        a.h = h;
      } else if (a.type === 'text') {
        a.size = clamp(orig.size * Math.max(0.05, (ob.w + dx) / ob.w), 4, 300);
      } else if (a.type === 'ink') {
        let sx = Math.max(0.05, (ob.w + dx) / ob.w);
        let sy = Math.max(0.05, (ob.h + dy) / ob.h);
        if (!e.shiftKey) sx = sy = Math.max(sx, sy);
        a.points = orig.points.map(([x, y]) => [ob.x + (x - ob.x) * sx, ob.y + (y - ob.y) * sy]);
      }
      drag.moved = true;
      break;
    }
    case 'endpoint': {
      const { a, end } = drag;
      const other = end === '1' ? [a.x2, a.y2] : [a.x1, a.y1];
      const [x, y] = e.shiftKey ? snapAngle(other[0], other[1], pt.x, pt.y) : [pt.x, pt.y];
      a[`x${end}`] = x;
      a[`y${end}`] = y;
      drag.moved = true;
      break;
    }
    case 'line': {
      const [x, y] = e.shiftKey ? snapAngle(drag.a.x1, drag.a.y1, pt.x, pt.y) : [pt.x, pt.y];
      drag.a.x2 = x;
      drag.a.y2 = y;
      break;
    }
    case 'draw':
      drag.a.points.push([pt.x, pt.y]);
      break;
    case 'rect': {
      const s = drag.start;
      Object.assign(drag.a, { x: Math.min(s.x, pt.x), y: Math.min(s.y, pt.y), w: Math.abs(pt.x - s.x), h: Math.abs(pt.y - s.y) });
      break;
    }
  }
  renderOverlay(p);
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  const drop = () => { d.p.annots = d.p.annots.filter((x) => x !== d.a); };
  if (d.mode === 'move' || d.mode === 'resize' || d.mode === 'endpoint') {
    if (d.moved) pushHistory(d.snap);
  } else if (d.mode === 'draw') {
    if (d.a.points.length === 1) {
      const [x, y] = d.a.points[0];
      d.a.points.push([x + 0.01, y]);
    }
    pushHistory(d.snap);
  } else if (d.mode === 'rect') {
    if (d.a.w * state.zoom < 4 || d.a.h * state.zoom < 4) drop();
    else pushHistory(d.snap);
  } else if (d.mode === 'line') {
    if (Math.hypot(d.a.x2 - d.a.x1, d.a.y2 - d.a.y1) * state.zoom < 4) drop();
    else pushHistory(d.snap);
  }
  renderOverlay(d.p);
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

pagesEl.addEventListener('dblclick', (e) => {
  if (state.tool !== 'select' || editing) return;
  const svg = e.target.closest('svg.overlay');
  const hitEl = e.target.closest('[data-aid]');
  if (!svg || !hitEl) return;
  const p = findPage(svg.dataset.id);
  const a = findAnnot(p, hitEl.dataset.aid);
  if (a && a.type === 'text') startEdit(p, a, false, snapshot());
  if (a && a.type === 'note') startNoteEdit(p, a, false, snapshot());
});

/* ---------------- text editing ---------------- */

function styleEditor(ta, a) {
  Object.assign(ta.style, {
    fontSize: `${a.size * state.zoom}px`,
    fontFamily: cssFontStack(effectiveFamily(a)),
    fontWeight: a.bold ? 700 : 400,
    fontStyle: a.italic ? 'italic' : 'normal',
    color: a.color,
    background: a.cover ? a.cover.fill : '',
  });
  const lines = ta.value.split('\n');
  const w = Math.max(...lines.map((l) => textWidth(l, a)));
  ta.style.width = `${(w + a.size) * state.zoom}px`;
  ta.style.height = `${lines.length * a.size * 1.2 * state.zoom + 2}px`;
}

function startEdit(p, a, isNew, snap) {
  setSelected(null);
  editing = { pageId: p.id, annotId: a.id, isNew, snap, original: a.text };
  renderOverlay(p);

  const el = pageElOf(p.id);
  const at = pagePoint(el, a.x, a.y - a.size * 0.2);
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.spellcheck = false;
  ta.value = a.text;
  Object.assign(ta.style, { left: `${at.x}px`, top: `${at.y}px`, transform: `rotate(${p.rot}deg)` });
  styleEditor(ta, a);
  ta.addEventListener('input', () => { a.text = ta.value; styleEditor(ta, a); });
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'Escape' || (ev.key === 'Enter' && mod)) {
      ev.preventDefault();
      finishEdit();
    } else if (mod && (ev.key === 'b' || ev.key === 'i')) {
      ev.preventDefault();
      const prop = ev.key === 'b' ? 'bold' : 'italic';
      applyTextStyle(prop, !a[prop]);
    }
  });
  ta.addEventListener('blur', () => finishEdit());
  el.appendChild(ta);
  editing.ta = ta;
  updateUI();
  requestAnimationFrame(() => {
    ta.focus();
    if (COARSE) setTimeout(() => ta.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    if (a.cover && isNew) ta.select();
  });
}

function finishEdit() {
  closeNoteEditor();
  if (!editing) return;
  const ed = editing;
  editing = null;
  ed.ta.remove();
  const p = findPage(ed.pageId);
  if (!p) return;
  const a = findAnnot(p, ed.annotId);
  if (a) {
    const unchanged = a.text === ed.original && !ed.styleChanged;
    if (a.cover && ed.isNew && unchanged) {
      // Opened an existing line but didn't change anything: leave the page untouched.
      p.annots = p.annots.filter((x) => x !== a);
    } else if (!a.text.trim()) {
      const i = p.annots.indexOf(a);
      if (a.cover) {
        // Emptying an existing line erases it.
        p.annots.splice(i, 1, { id: a.id, type: 'rect', kind: 'whiteout', x: a.cover.x, y: a.cover.y, w: a.cover.w, h: a.cover.h, fill: a.cover.fill });
        pushHistory(ed.snap);
      } else {
        p.annots.splice(i, 1);
        if (!ed.isNew) pushHistory(ed.snap);
      }
    } else {
      if (ed.isNew || !unchanged) pushHistory(ed.snap);
      if (a.font === 'original' && a.orig && !origFontState(a) && !unchanged) {
        toast("The PDF's original font doesn't include some of these characters, so this line uses the closest matching font.");
      }
      // Keep the text selected so font, color and size changes apply to it.
      state.selected = { pageId: p.id, annotId: a.id };
    }
  }
  renderOverlay(p);
  updateUI();
}

/* ---------------- comments (sticky notes) ---------------- */

function startNoteEdit(p, a, isNew, snap) {
  finishEdit();
  setSelected({ pageId: p.id, annotId: a.id });
  const el = pageElOf(p.id);
  const at = pagePoint(el, a.x + NOTE_SIZE, a.y);
  const box = document.createElement('div');
  box.className = 'note-editor';
  box.innerHTML = `
    <textarea rows="4" placeholder="Write a comment…" aria-label="Comment"></textarea>
    <div class="note-actions">
      <button type="button" class="link-btn danger" data-act="delete">Delete</button>
      <span class="spacer"></span>
      <button type="button" class="btn sm primary" data-act="done">Done</button>
    </div>`;
  box.style.left = `${clamp(at.x + 6, 4, Math.max(4, el.clientWidth - 244))}px`;
  box.style.top = `${Math.max(4, at.y)}px`;
  const ta = box.querySelector('textarea');
  ta.value = a.text;
  noteEditing = { pageId: p.id, a, isNew, snap, original: a.text, box };
  ta.addEventListener('input', () => { a.text = ta.value; });
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) {
      ev.preventDefault();
      closeNoteEditor();
    }
  });
  box.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'done') closeNoteEditor();
    if (act === 'delete') closeNoteEditor({ remove: true });
  });
  el.appendChild(box);
  setTimeout(() => ta.focus());
}

function closeNoteEditor({ remove = false } = {}) {
  if (!noteEditing) return;
  const ne = noteEditing;
  noteEditing = null;
  ne.box.remove();
  const p = findPage(ne.pageId);
  if (!p || !p.annots.includes(ne.a)) return;
  if (remove || !ne.a.text.trim()) {
    p.annots = p.annots.filter((x) => x !== ne.a);
    if (!ne.isNew) pushHistory(ne.snap);
    if (state.selected && state.selected.annotId === ne.a.id) state.selected = null;
  } else if (ne.isNew || ne.a.text !== ne.original) {
    pushHistory(ne.snap);
  }
  renderOverlay(p);
  updateUI();
}

/* ---------------- copy, paste, duplicate, nudge ---------------- */

const CLIP_MIME = 'application/x-pdf-editor';
const CLIP_MARKER = '[PDF Editor item]';

function addAnnotCopy(source, pageId, offset) {
  const p = findPage(pageId);
  if (!p) return;
  const a = structuredClone(source);
  a.id = uid();
  delete a.cover; // a copied text edit is just text
  const b = annotBounds(a);
  const dx = clamp(offset, -b.x, Math.max(-b.x, p.baseW - b.x - b.w));
  const dy = clamp(offset, -b.y, Math.max(-b.y, p.baseH - b.y - b.h));
  translateAnnot(a, structuredClone(a), dx, dy);
  pushHistory();
  p.annots.push(a);
  if (state.tool !== 'select') setTool('select');
  setSelected({ pageId: p.id, annotId: a.id });
}

function duplicateSelected() {
  const a = selectedAnnot();
  if (a) addAnnotCopy(a, state.selected.pageId, 12);
}

let lastNudge = 0;
function nudge(dx, dy) {
  const a = selectedAnnot();
  if (!a) return;
  const now = Date.now();
  if (now - lastNudge > 800) pushHistory(); // one undo step per burst of key presses
  lastNudge = now;
  translateAnnot(a, structuredClone(a), dx, dy);
  renderOverlay(findPage(state.selected.pageId));
}

function copySelectionTo(clipboardData) {
  const a = selectedAnnot();
  clip = { annot: structuredClone(a), pageId: state.selected.pageId, pastes: 0, marker: a.type === 'text' || a.type === 'note' ? a.text : CLIP_MARKER };
  clipboardData.setData('text/plain', clip.marker);
  clipboardData.setData(CLIP_MIME, a.id);
}

document.addEventListener('copy', (e) => {
  if (!inEditor() || isTyping(e.target) || openModalId() || !selectedAnnot()) return;
  e.preventDefault();
  copySelectionTo(e.clipboardData);
});

document.addEventListener('cut', (e) => {
  if (!inEditor() || isTyping(e.target) || openModalId() || !selectedAnnot()) return;
  e.preventDefault();
  copySelectionTo(e.clipboardData);
  deleteSelected();
});

document.addEventListener('paste', async (e) => {
  if (!inEditor() || isTyping(e.target) || openModalId() || !state.pages.length) return;
  const data = e.clipboardData;
  const file = [...data.files].find((f) => f.type.startsWith('image/'));
  const text = data.getData('text/plain');
  const target = state.pages[state.current];
  e.preventDefault();
  finishEdit();

  if (file) {
    pendingPlace = { pageId: target.id, pt: visibleCenter(target) };
    try { placeImage(await importImageFile(file), 220); } catch { toast("That image couldn't be pasted."); }
  } else if (clip && (data.types.includes(CLIP_MIME) || text === clip.marker)) {
    clip.pastes++;
    addAnnotCopy(clip.annot, target.id, target.id === clip.pageId ? 12 * clip.pastes : 0);
  } else if (text.trim()) {
    const c = visibleCenter(target);
    const a = { id: uid(), type: 'text', x: c.x, y: c.y, text: text.replace(/\r\n?/g, '\n'), size: state.sizes.text, color: state.colors.text, ...state.textStyle };
    const b = annotBounds(a);
    a.x = clamp(c.x - b.w / 2, 0, Math.max(0, target.baseW - b.w));
    a.y = clamp(c.y - b.h / 2, 0, Math.max(0, target.baseH - b.h));
    pushHistory();
    target.annots.push(a);
    if (state.tool !== 'select') setTool('select');
    setSelected({ pageId: target.id, annotId: a.id });
  }
});

/* ---------------- images ---------------- */

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function decodeImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Re-encode through a canvas: applies EXIF orientation, caps size, and yields PNG/JPEG that pdf-lib can embed.
async function importImageFile(file) {
  const img = await decodeImage(await readAsDataURL(file));
  const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const jpg = file.type === 'image/jpeg';
  const dataUrl = jpg ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png');
  return registerImage(dataUrl, jpg ? 'jpg' : 'png', img.naturalWidth, img.naturalHeight);
}

function registerImage(dataUrl, kind, w, h) {
  const id = uid();
  state.images[id] = { dataUrl, kind, w, h };
  return id;
}

function placeImage(imageId, maxW) {
  const place = pendingPlace;
  pendingPlace = null;
  const p = place && findPage(place.pageId);
  if (!p) return;
  const im = state.images[imageId];
  const scale = Math.min(maxW / im.w, (p.baseW * 0.9) / im.w, (p.baseH * 0.9) / im.h);
  const w = im.w * scale;
  const h = im.h * scale;
  const a = {
    id: uid(), type: 'image', imageId, w, h,
    x: clamp(place.pt.x - w / 2, 0, p.baseW - w),
    y: clamp(place.pt.y - h / 2, 0, p.baseH - h),
  };
  pushHistory();
  p.annots.push(a);
  setTool('select');
  setSelected({ pageId: p.id, annotId: a.id });
}

$('fileImage').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !pendingPlace) return;
  try {
    placeImage(await importImageFile(file), 220);
  } catch {
    pendingPlace = null;
    toast("That image couldn't be loaded.");
  }
});

/* ---------------- page drawer (phones) ---------------- */

function toggleDrawer(open) {
  const show = open ?? !$('sidebar').classList.contains('open');
  $('sidebar').classList.toggle('open', show);
  $('sidebarBackdrop').hidden = !show;
}
$('btnPages').addEventListener('click', () => toggleDrawer());
$('sidebarBackdrop').addEventListener('click', () => toggleDrawer(false));

/* ---------------- menu ---------------- */

function toggleMenu(open) {
  const menu = $('moreMenu');
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $('btnMore').setAttribute('aria-expanded', String(show));
}

const MENU_ACTIONS = {
  find: () => openSearch(),
  ocr: () => openOcrDialog(),
  decor: () => openDecorDialog(),
  images: () => { $('fileImages').value = ''; $('fileImages').click(); },
  'export-images': () => openImageExportDialog(),
  split: () => openSplitDialog(),
  shortcuts: () => openModal('keysModal'),
  open: () => openPicker(),
  add: () => { $('fileMerge').value = ''; $('fileMerge').click(); },
  blank: () => addBlankPage(),
};

$('btnMore').addEventListener('click', () => toggleMenu());
$('moreMenu').addEventListener('click', (e) => {
  const item = e.target.closest('[data-menu]');
  if (!item || item.disabled) return;
  toggleMenu(false);
  MENU_ACTIONS[item.dataset.menu]();
});
document.addEventListener('pointerdown', (e) => {
  if (!$('moreMenu').hidden && !e.target.closest('.menu-wrap')) toggleMenu(false);
});

/* ---------------- wiring ---------------- */

const openPicker = () => { $('filePdf').value = ''; $('filePdf').click(); };
$('btnOpen').addEventListener('click', openPicker);
$('btnOpen2').addEventListener('click', openPicker);
$('filePdf').addEventListener('change', (e) => { if (e.target.files.length) openFiles([...e.target.files], true); });
$('btnMerge').addEventListener('click', () => { $('fileMerge').value = ''; $('fileMerge').click(); });
$('fileMerge').addEventListener('change', (e) => { if (e.target.files.length) openFiles([...e.target.files], false); });
$('fileImages').addEventListener('change', (e) => { if (e.target.files.length) openFiles([...e.target.files], !state.pages.length); });
$('btnBlank').addEventListener('click', addBlankPage);
$('btnBlank2').addEventListener('click', addBlankPage);
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('btnDelete').addEventListener('click', deleteSelected);
$('btnDuplicate').addEventListener('click', duplicateSelected);
$('btnDuplicateM').addEventListener('click', duplicateSelected);
$('btnDeleteM').addEventListener('click', deleteSelected);
$('btnZoomIn').addEventListener('click', () => setZoom(state.zoom * 1.2));
$('btnZoomOut').addEventListener('click', () => setZoom(state.zoom / 1.2));
$('btnFit').addEventListener('click', fitWidth);
$('btnDownload').addEventListener('click', openDownloadDialog);
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

$('btnPickAll').addEventListener('click', () => {
  if (state.pageSel.size) state.pageSel.clear();
  else state.pages.forEach((p) => state.pageSel.add(p.id));
  refreshThumbState();
});
$('pgRotL').addEventListener('click', () => rotatePages(targetPageIds(), -90));
$('pgRotR').addEventListener('click', () => rotatePages(targetPageIds(), 90));
$('pgDup').addEventListener('click', () => duplicatePages(targetPageIds()));
$('pgDel').addEventListener('click', () => deletePages(targetPageIds()));
$('pgExtract').addEventListener('click', () => extractPages(targetPageIds()));
$('pgSplit').addEventListener('click', openSplitDialog);

// Modals: Cancel buttons and backdrop clicks dismiss them.
MODALS.forEach((id) => {
  const modal = $(id);
  modal.addEventListener('pointerdown', (e) => { if (e.target === modal) dismissModal(id); });
  if (id === 'sigModal') return; // signature.js wires its own Cancel
  modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dismissModal(id)));
});

// Clicking the gray area around the pages deselects. (Checking the target directly: a click
// inside a page may re-render the overlay and detach the clicked element before this runs.)
viewer.addEventListener('pointerdown', (e) => {
  if ((e.target === viewer || e.target === pagesEl) && state.selected) setSelected(null);
});

const TOOL_KEYS = { v: 'select', e: 'edittext', t: 'text', d: 'draw', h: 'highlight', r: 'shape', w: 'whiteout', x: 'redact', n: 'note', m: 'stamp', i: 'image', s: 'sign' };
const NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
document.addEventListener('keydown', (e) => {
  const modal = openModalId();
  if (modal) {
    if (e.key === 'Escape') dismissModal(modal);
    return;
  }
  if (!inEditor()) return; // tool pages have no editor shortcuts
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === 'Escape' && !$('moreMenu').hidden) { toggleMenu(false); return; }
  if (mod && key === 's') { e.preventDefault(); openDownloadDialog(); return; }
  if (mod && key === 'f') { e.preventDefault(); openSearch(); return; }
  if (isTyping(e.target)) return;

  if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && key === 'y') { e.preventDefault(); redo(); }
  else if (mod && key === 'o') { e.preventDefault(); openPicker(); }
  else if (mod && key === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (mod && (key === 'b' || key === 'i') && textStyleTarget()) {
    e.preventDefault();
    const prop = key === 'b' ? 'bold' : 'italic';
    applyTextStyle(prop, !textStyleTarget()[prop]);
  }
  else if (NUDGE_KEYS[e.key] && selectedAnnot()) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    nudge(NUDGE_KEYS[e.key][0] * step, NUDGE_KEYS[e.key][1] * step);
  }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape') {
    if (!$('searchbar').hidden) closeSearch();
    setSelected(null);
    if (state.tool !== 'select') setTool('select');
  }
  else if (e.key === '?') openModal('keysModal');
  else if (!mod && !e.altKey && state.pages.length) {
    if (TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
    else if (e.key === '+' || e.key === '=') setZoom(state.zoom * 1.2);
    else if (e.key === '-') setZoom(state.zoom / 1.2);
  }
});

// Drag & drop PDFs and images onto the window.
let dropDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropDepth++;
  $('dropmask').firstElementChild.textContent = !inEditor() ? 'Drop files here'
    : state.pages.length ? 'Drop PDFs or images to add pages' : 'Drop files to open';
  $('dropmask').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dropDepth <= 0) { dropDepth = 0; $('dropmask').hidden = true; }
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropDepth = 0;
  $('dropmask').hidden = true;
  const files = [...e.dataTransfer.files];
  if (!inEditor()) { hubDrop(files); return; }
  openFiles(files, !state.pages.length);
});

window.addEventListener('beforeunload', (e) => {
  if (dirty && state.pages.length) { e.preventDefault(); e.returnValue = ''; }
});

// Text measurements change once web fonts finish loading.
document.fonts.addEventListener('loadingdone', () => {
  state.pages.forEach(renderOverlay);
  if (editing) {
    const a = findAnnot(findPage(editing.pageId), editing.annotId);
    if (a) styleEditor(editing.ta, a);
  }
});

// Offline support (skipped on localhost so development always gets fresh files).
// The Android app already ships every file, so it doesn't need one.
if ('serviceWorker' in navigator && location.protocol === 'https:' && !NATIVE_APP) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline mode unavailable', err));
}

installFontFaces();
initSignature();
initExportDialogs();
initTextLayer();
initSearch();
initOcr();
initDecor();
updateUI();
initTouch();
initHub();
