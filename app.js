'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const {
  PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle,
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

const TOOL_HINTS = {
  select: 'Click an item to select it. Drag to move, drag the corner to resize, double-click text to edit, Delete to remove.',
  text: 'Click on a page to add text. Click outside or press Esc to finish.',
  draw: 'Drag on a page to draw freehand.',
  highlight: 'Drag over an area to highlight it.',
  rect: 'Drag to draw a box outline.',
  whiteout: 'Drag over content to cover it with white.',
  image: 'Click on a page where the image should go.',
  sign: 'Click on a page where your signature should go.',
};
const RECT_KINDS = { highlight: 'highlight', rect: 'outline', whiteout: 'whiteout' };

/*
 * Coordinates: every annotation lives in the page's "base frame" — PDF points,
 * origin top-left, y down, as the page appears with its own /Rotate applied.
 * Extra rotation done in this editor (page.rot) is applied on top via an SVG
 * transform on screen and via /Rotate on export, so annotations rotate with the page.
 */
const state = {
  sources: [],   // { bytes, pdf (pdf.js doc), name }
  pages: [],     // { id, src, index, baseW, baseH, rot0, rot, annots: [] }
  images: {},    // id -> { dataUrl, kind: 'png'|'jpg', w, h }
  tool: 'select',
  colors: { text: '#111827', draw: '#e11d48', highlight: '#facc15', rect: '#2563eb', sign: '#1e3a8a' },
  sizes: { text: 16, draw: 3, rect: 2 },
  zoom: 1.25,
  selected: null, // { pageId, annotId }
  current: 0,
  fileName: 'document',
};

const undoStack = [];
const redoStack = [];
let dirty = false;
let drag = null;
let editing = null;
let pendingPlace = null;
let styleSnap = null;

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
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function busy(on, msg) {
  document.body.classList.toggle('busy', on);
  $('hint').textContent = on ? msg : TOOL_HINTS[state.tool];
}

const measureCtx = document.createElement('canvas').getContext('2d');
function textWidth(text, size) {
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

function dispSize(p) {
  const odd = p.rot % 180 !== 0;
  return {
    w: (odd ? p.baseH : p.baseW) * state.zoom,
    h: (odd ? p.baseW : p.baseH) * state.zoom,
  };
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

function annotBounds(a) {
  switch (a.type) {
    case 'text': {
      const lines = a.text.split('\n');
      const w = Math.max(...lines.map((l) => textWidth(l, a.size)), a.size * 0.5);
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
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

/* ---------------- history ---------------- */

const snapshot = () => JSON.stringify(state.pages);

function pushHistory(snap = snapshot()) {
  undoStack.push(snap);
  if (undoStack.length > 150) undoStack.shift();
  redoStack.length = 0;
  dirty = true;
  updateUI();
}

function restore(snap) {
  state.pages = JSON.parse(snap);
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

/* ---------------- loading ---------------- */

async function loadPdfFiles(files, replace) {
  if (replace && dirty && state.pages.length && !confirm('Open a new file? Your unsaved edits will be lost.')) return;
  busy(true, 'Opening…');
  try {
    const loaded = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let pdf;
      try {
        // pdf.js takes ownership of the buffer it is given, so hand it a copy.
        pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      } catch (err) {
        toast(err && err.name === 'PasswordException'
          ? `"${file.name}" is password-protected and can't be opened.`
          : `"${file.name}" doesn't look like a valid PDF.`);
        continue;
      }
      const pages = [];
      for (let i = 0; i < pdf.numPages; i++) {
        const page = await pdf.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        pages.push({ id: uid(), index: i, baseW: vp.width, baseH: vp.height, rot0: page.rotate % 360, rot: 0, annots: [] });
      }
      loaded.push({ file, bytes, pdf, pages });
    }
    if (!loaded.length) return;

    if (replace) {
      finishEdit();
      state.sources.forEach((s) => s.pdf.destroy());
      state.sources = [];
      state.pages = [];
      state.images = {};
      state.selected = null;
      state.current = 0;
      undoStack.length = 0;
      redoStack.length = 0;
      thumbCache.clear();
      pagesEl.replaceChildren();
      state.fileName = loaded[0].file.name.replace(/\.pdf$/i, '') || 'document';
      dirty = false;
    } else {
      pushHistory();
    }

    const firstNew = state.pages.length;
    for (const l of loaded) {
      const src = state.sources.push({ bytes: l.bytes, pdf: l.pdf, name: l.file.name }) - 1;
      for (const pg of l.pages) state.pages.push({ ...pg, src });
    }
    if (!replace) dirty = true;
    renderAll();
    if (replace) viewer.scrollTop = 0;
    else {
      scrollToPage(state.pages[firstNew].id);
      const n = state.pages.length - firstNew;
      toast(`Added ${n} page${n === 1 ? '' : 's'}.`);
    }
  } finally {
    busy(false);
  }
}

function addBlankPage() {
  finishEdit();
  const ref = state.pages[state.current];
  let w = 612, h = 792; // US Letter
  if (ref) {
    const odd = ref.rot % 180 !== 0;
    w = odd ? ref.baseH : ref.baseW;
    h = odd ? ref.baseW : ref.baseH;
  }
  const page = { id: uid(), src: null, index: 0, baseW: w, baseH: h, rot0: 0, rot: 0, annots: [] };
  if (state.pages.length) pushHistory();
  else state.fileName = 'untitled';
  const at = state.pages.length ? state.current + 1 : 0;
  state.pages.splice(at, 0, page);
  dirty = true;
  renderAll();
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
  }
  for (const el of existing.values()) el.remove();

  if (state.selected && !selectedAnnot()) state.selected = null;
  state.current = clamp(state.current, 0, Math.max(0, state.pages.length - 1));
  renderThumbs();
  updateUI();
  requestAnimationFrame(() => { renderVisible(); updateCurrent(); });
}

function createPageEl(p) {
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.id = p.id;
  const svg = svgEl('svg', { class: 'overlay', 'data-id': p.id });
  svg.appendChild(svgEl('g', { class: 'root' }));
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
  svg.firstChild.setAttribute('transform', `matrix(${m.join(' ')})`);
}

function renderVisible() {
  const vr = viewer.getBoundingClientRect();
  for (const el of pagesEl.children) {
    const r = el.getBoundingClientRect();
    if (r.bottom > vr.top - 1200 && r.top < vr.bottom + 1200) renderCanvas(el);
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
    return;
  }
  try {
    const page = await state.sources[p.src].pdf.getPage(p.index + 1);
    if (el.dataset.rendered !== key) return;
    const vp = page.getViewport({ scale: state.zoom * dpr, rotation: (p.rot0 + p.rot) % 360 });
    // Render offscreen, then swap in, so the old image stays visible meanwhile.
    const off = document.createElement('canvas');
    off.width = Math.ceil(vp.width);
    off.height = Math.ceil(vp.height);
    const prev = renderTasks.get(el);
    if (prev) prev.cancel();
    const task = page.render({ canvasContext: off.getContext('2d'), viewport: vp });
    renderTasks.set(el, task);
    await task.promise;
    if (el.dataset.rendered !== key) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
  } catch (err) {
    if (!err || err.name !== 'RenderingCancelledException') console.error(err);
    if (el.dataset.rendered === key) el.dataset.rendered = '';
  }
}

function renderOverlay(p) {
  const el = pageElOf(p.id);
  if (!el) return;
  const g = el.querySelector('g.root');
  g.replaceChildren();
  for (const a of p.annots) {
    if (editing && editing.annotId === a.id) continue;
    g.appendChild(annotEl(a));
  }
  const sel = state.selected;
  if (sel && sel.pageId === p.id) {
    const a = findAnnot(p, sel.annotId);
    if (a) drawSelection(g, a);
  }
}

function annotEl(a) {
  const wrap = svgEl('g', { 'data-aid': a.id, class: `annot annot-${a.type}` });
  switch (a.type) {
    case 'text': {
      const t = svgEl('text', { 'font-size': a.size, fill: a.color, 'font-family': 'Helvetica, Arial, sans-serif' });
      a.text.split('\n').forEach((line, i) => {
        const ts = svgEl('tspan', { x: a.x, y: a.y + a.size * (0.8 + 1.2 * i) });
        ts.textContent = line || ' ';
        t.appendChild(ts);
      });
      t.setAttribute('xml:space', 'preserve');
      wrap.appendChild(t);
      break;
    }
    case 'ink': {
      const d = inkPath(a.points);
      wrap.append(
        svgEl('path', { d, class: 'hit', fill: 'none', 'stroke-width': Math.max(a.width + 8, 12) }),
        svgEl('path', { d, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      );
      break;
    }
    case 'rect': {
      const base = { x: a.x, y: a.y, width: a.w, height: a.h };
      if (a.kind === 'highlight') {
        wrap.appendChild(svgEl('rect', { ...base, fill: a.color, 'fill-opacity': 0.4, style: 'mix-blend-mode:multiply' }));
      } else if (a.kind === 'whiteout') {
        wrap.appendChild(svgEl('rect', { ...base, fill: '#fff' }));
      } else {
        wrap.appendChild(svgEl('rect', { ...base, fill: 'none', stroke: a.color, 'stroke-width': a.width }));
      }
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
  const b = annotBounds(a);
  const pad = 4 / z;
  g.appendChild(svgEl('rect', {
    class: 'sel-box', x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2,
    'stroke-width': 1.5 / z, 'stroke-dasharray': `${5 / z} ${3 / z}`,
  }));
  if (a.type === 'rect' || a.type === 'image') {
    const s = 10 / z;
    g.appendChild(svgEl('rect', { class: 'handle', x: a.x + a.w - s / 2, y: a.y + a.h - s / 2, width: s, height: s, 'stroke-width': 1.5 / z }));
  }
}

/* ---------------- thumbnails ---------------- */

const thumbCache = new Map();
function getThumb(p) {
  const key = `${p.src}|${p.index}|${p.rot}|${p.baseW}x${p.baseH}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const job = (async () => {
    const c = document.createElement('canvas');
    if (p.src === null) {
      const odd = p.rot % 180 !== 0;
      const w = odd ? p.baseH : p.baseW;
      const h = odd ? p.baseW : p.baseH;
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
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c.toDataURL('image/jpeg', 0.8);
  })();
  thumbCache.set(key, job);
  job.catch(() => thumbCache.delete(key));
  return job;
}

const ICON_ROT_L = '<svg viewBox="0 0 24 24"><path d="M4 4v5h5"/><path d="M5 9a8 8 0 1 1-1 5"/></svg>';
const ICON_ROT_R = '<svg viewBox="0 0 24 24"><path d="M20 4v5h-5"/><path d="M19 9a8 8 0 1 0 1 5"/></svg>';
const ICON_DEL = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

function renderThumbs() {
  thumbsEl.replaceChildren();
  state.pages.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'thumb' + (i === state.current ? ' current' : '');
    item.draggable = true;
    item.dataset.id = p.id;
    item.innerHTML = `
      <div class="thumb-img"><img alt="Page ${i + 1}"></div>
      <div class="thumb-bar">
        <span class="num">${i + 1}</span>
        <span class="thumb-actions">
          <button data-act="rotl" title="Rotate left">${ICON_ROT_L}</button>
          <button data-act="rotr" title="Rotate right">${ICON_ROT_R}</button>
          <button data-act="del" title="Delete page">${ICON_DEL}</button>
        </span>
      </div>`;
    const img = item.querySelector('img');
    getThumb(p).then((url) => { img.src = url; }).catch(() => {});
    thumbsEl.appendChild(item);
  });
}

thumbsEl.addEventListener('click', (e) => {
  const item = e.target.closest('.thumb');
  if (!item) return;
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'rotl') rotatePage(item.dataset.id, -90);
  else if (act === 'rotr') rotatePage(item.dataset.id, 90);
  else if (act === 'del') deletePage(item.dataset.id);
  else scrollToPage(item.dataset.id);
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
thumbsEl.addEventListener('drop', (e) => {
  if (!thumbDragId) return;
  e.preventDefault();
  const item = e.target.closest('.thumb');
  clearDropMarks();
  if (item && item.dataset.id !== thumbDragId) {
    const r = item.getBoundingClientRect();
    const after = e.clientY >= r.top + r.height / 2;
    finishEdit();
    pushHistory();
    const from = state.pages.findIndex((p) => p.id === thumbDragId);
    const [moved] = state.pages.splice(from, 1);
    let to = state.pages.findIndex((p) => p.id === item.dataset.id);
    if (after) to++;
    state.pages.splice(to, 0, moved);
    state.current = to;
    renderAll();
  }
  thumbDragId = null;
});
thumbsEl.addEventListener('dragend', () => {
  thumbDragId = null;
  clearDropMarks();
  thumbsEl.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
});

/* ---------------- page operations ---------------- */

function rotatePage(id, delta) {
  const p = findPage(id);
  if (!p) return;
  finishEdit();
  pushHistory();
  p.rot = (p.rot + delta + 360) % 360;
  renderAll();
}

function deletePage(id) {
  const idx = state.pages.findIndex((p) => p.id === id);
  if (idx < 0) return;
  finishEdit();
  pushHistory();
  state.pages.splice(idx, 1);
  if (state.current >= idx && state.current > 0) state.current--;
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
    [...thumbsEl.children].forEach((t, i) => t.classList.toggle('current', i === idx));
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

function setZoom(z) {
  z = clamp(Math.round(z * 100) / 100, 0.25, 4);
  if (z === state.zoom) return;
  finishEdit();
  const ratio = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  state.zoom = z;
  renderAll();
  viewer.scrollTop = ratio * viewer.scrollHeight;
}

function fitWidth() {
  if (!state.pages.length) return;
  const widest = Math.max(...state.pages.map((p) => (p.rot % 180 ? p.baseH : p.baseW)));
  setZoom((viewer.clientWidth - 64) / widest);
}

viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.pages.length) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

/* ---------------- tools & style controls ---------------- */

function setTool(tool) {
  finishEdit();
  state.tool = tool;
  if (tool !== 'select') setSelected(null);
  updateUI();
}

function setSelected(sel) {
  const prev = state.selected;
  state.selected = sel;
  if (prev) { const p = findPage(prev.pageId); if (p) renderOverlay(p); }
  if (sel && (!prev || prev.pageId !== sel.pageId)) { const p = findPage(sel.pageId); if (p) renderOverlay(p); }
  updateUI();
}

// Which color/size the style controls currently edit: the selection, or the active tool's defaults.
function styleTarget() {
  const a = selectedAnnot();
  if (a) {
    const noColor = a.type === 'image' || (a.type === 'rect' && a.kind === 'whiteout');
    let sizeProp = null;
    if (a.type === 'text') sizeProp = 'size';
    else if (a.type === 'ink' || (a.type === 'rect' && a.kind === 'outline')) sizeProp = 'width';
    return {
      annot: a,
      color: noColor ? null : a.color,
      size: sizeProp ? a[sizeProp] : null,
      sizeProp,
      label: a.type === 'text' ? 'Font size' : 'Stroke',
    };
  }
  const t = state.tool;
  return {
    annot: null,
    color: state.colors[t] ?? null,
    size: state.sizes[t] ?? null,
    label: t === 'text' ? 'Font size' : 'Stroke',
  };
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
    t.annot[t.sizeProp] = clamp(v, 1, 144);
    renderOverlay(findPage(state.selected.pageId));
  } else if (state.tool in state.sizes) {
    state.sizes[state.tool] = clamp(v, 1, 144);
  }
});
const commitStyle = () => { if (styleSnap) { pushHistory(styleSnap); styleSnap = null; } };
$('color').addEventListener('change', commitStyle);
$('size').addEventListener('change', commitStyle);

function deleteSelected() {
  const a = selectedAnnot();
  if (!a) return;
  const p = findPage(state.selected.pageId);
  pushHistory();
  p.annots = p.annots.filter((x) => x !== a);
  setSelected(null);
}

function updateUI() {
  const has = state.pages.length > 0;
  document.body.classList.toggle('has-doc', has);
  $('empty').hidden = has;
  for (const id of ['btnMerge', 'btnBlank', 'btnDownload', 'btnZoomIn', 'btnZoomOut', 'btnFit']) $(id).disabled = !has;
  $('btnUndo').disabled = !undoStack.length;
  $('btnRedo').disabled = !redoStack.length;
  $('btnDelete').disabled = !state.selected;
  $('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  viewer.className = `viewer tool-${state.tool}`;
  if (!document.body.classList.contains('busy')) $('hint').textContent = has ? TOOL_HINTS[state.tool] : '';
  if (!has) $('pageInfo').textContent = '';
  updateStyleControls();
}

/* ---------------- pointer interaction ---------------- */

function basePoint(svg, e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const r = pt.matrixTransform(svg.firstChild.getScreenCTM().inverse());
  return { x: r.x, y: r.y };
}

pagesEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.text-editor')) return;
  const svg = e.target.closest('svg.overlay');
  if (editing) {
    finishEdit();
    if (state.tool === 'text') { e.preventDefault(); return; }
  }
  if (!svg) return;
  const p = findPage(svg.dataset.id);
  const raw = basePoint(svg, e);
  const pt = { x: clamp(raw.x, 0, p.baseW), y: clamp(raw.y, 0, p.baseH) };
  const hitEl = e.target.closest('[data-aid]');
  const hit = hitEl ? findAnnot(p, hitEl.dataset.aid) : null;
  const tool = state.tool;
  e.preventDefault();

  if (tool === 'select') {
    if (e.target.closest('.handle') && selectedAnnot()) {
      const a = selectedAnnot();
      drag = { mode: 'resize', svg, p, a, start: pt, orig: structuredClone(a), snap: snapshot(), moved: false };
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
    const a = { id: uid(), type: 'text', x: pt.x, y: Math.max(0, pt.y - size * 0.6), text: '', size, color: state.colors.text };
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
    if (tool === 'rect') { a.color = state.colors.rect; a.width = state.sizes.rect; }
    p.annots.push(a);
    drag = { mode: 'rect', svg, p, a, start: pt, snap };
  } else if (tool === 'image') {
    pendingPlace = { pageId: p.id, pt };
    $('fileImage').value = '';
    $('fileImage').click();
    return;
  } else if (tool === 'sign') {
    pendingPlace = { pageId: p.id, pt };
    openSignature();
    return;
  }
  svg.setPointerCapture(e.pointerId);
  renderOverlay(p);
});

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
      const { a, orig } = drag;
      if (a.type === 'ink') a.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
      else { a.x = orig.x + dx; a.y = orig.y + dy; }
      break;
    }
    case 'resize': {
      const { a, orig } = drag;
      let w = Math.max(4, orig.w + pt.x - drag.start.x);
      let h = Math.max(4, orig.h + pt.y - drag.start.y);
      if (a.type === 'image' && !e.shiftKey) {
        const ratio = orig.w / orig.h;
        if (w / h > ratio) h = w / ratio; else w = h * ratio;
      }
      a.w = w;
      a.h = h;
      drag.moved = true;
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

pagesEl.addEventListener('dblclick', (e) => {
  if (state.tool !== 'select' || editing) return;
  const svg = e.target.closest('svg.overlay');
  const hitEl = e.target.closest('[data-aid]');
  if (!svg || !hitEl) return;
  const p = findPage(svg.dataset.id);
  const a = findAnnot(p, hitEl.dataset.aid);
  if (a && a.type === 'text') startEdit(p, a, false, snapshot());
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.mode === 'move' || d.mode === 'resize') {
    if (d.moved) pushHistory(d.snap);
  } else if (d.mode === 'draw') {
    if (d.a.points.length === 1) {
      const [x, y] = d.a.points[0];
      d.a.points.push([x + 0.01, y]);
    }
    pushHistory(d.snap);
  } else if (d.mode === 'rect') {
    if (d.a.w * state.zoom < 4 || d.a.h * state.zoom < 4) d.p.annots = d.p.annots.filter((x) => x !== d.a);
    else pushHistory(d.snap);
  }
  renderOverlay(d.p);
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

/* ---------------- text editing ---------------- */

function startEdit(p, a, isNew, snap) {
  setSelected(null);
  editing = { pageId: p.id, annotId: a.id, isNew, snap, original: a.text };
  renderOverlay(p);

  const el = pageElOf(p.id);
  const ctm = el.querySelector('g.root').getCTM();
  const svgPt = el.querySelector('svg').createSVGPoint();
  svgPt.x = a.x;
  svgPt.y = a.y - a.size * 0.2;
  const at = svgPt.matrixTransform(ctm);

  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.spellcheck = false;
  ta.value = a.text;
  Object.assign(ta.style, {
    left: `${at.x}px`,
    top: `${at.y}px`,
    fontSize: `${a.size * state.zoom}px`,
    color: a.color,
    transform: `rotate(${p.rot}deg)`,
  });
  const autosize = () => {
    const lines = ta.value.split('\n');
    const w = Math.max(...lines.map((l) => textWidth(l, a.size)));
    ta.style.width = `${(w + a.size) * state.zoom}px`;
    ta.style.height = `${lines.length * a.size * 1.2 * state.zoom + 2}px`;
  };
  autosize();
  ta.addEventListener('input', () => { a.text = ta.value; autosize(); });
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) {
      ev.preventDefault();
      finishEdit();
    }
  });
  ta.addEventListener('blur', () => finishEdit());
  el.appendChild(ta);
  editing.ta = ta;
  requestAnimationFrame(() => ta.focus());
}

function finishEdit() {
  if (!editing) return;
  const ed = editing;
  editing = null;
  ed.ta.remove();
  const p = findPage(ed.pageId);
  if (!p) return;
  const a = findAnnot(p, ed.annotId);
  if (a) {
    if (!a.text.trim()) {
      p.annots = p.annots.filter((x) => x !== a);
      if (!ed.isNew) pushHistory(ed.snap);
    } else if (ed.isNew || a.text !== ed.original) {
      pushHistory(ed.snap);
    }
  }
  renderOverlay(p);
}

/* ---------------- images & signatures ---------------- */

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

const sigCanvas = $('sigCanvas');
let sigCtx = null;
let sigInk = false;
let sigLast = null;

function openSignature() {
  $('sigModal').hidden = false;
  const dpr = window.devicePixelRatio || 1;
  const r = sigCanvas.getBoundingClientRect();
  sigCanvas.width = Math.round(r.width * dpr);
  sigCanvas.height = Math.round(r.height * dpr);
  sigCtx = sigCanvas.getContext('2d');
  sigCtx.scale(dpr, dpr);
  sigCtx.lineWidth = 2.6;
  sigCtx.lineCap = 'round';
  sigCtx.lineJoin = 'round';
  sigCtx.strokeStyle = state.colors.sign;
  sigInk = false;
}

function closeSignature() {
  $('sigModal').hidden = true;
  pendingPlace = null;
}

function sigPoint(e) {
  const r = sigCanvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
sigCanvas.addEventListener('pointerdown', (e) => {
  sigCanvas.setPointerCapture(e.pointerId);
  sigLast = sigPoint(e);
  sigCtx.beginPath();
  sigCtx.arc(sigLast[0], sigLast[1], sigCtx.lineWidth / 2, 0, Math.PI * 2);
  sigCtx.fillStyle = sigCtx.strokeStyle;
  sigCtx.fill();
  sigInk = true;
});
sigCanvas.addEventListener('pointermove', (e) => {
  if (!sigLast) return;
  const pt = sigPoint(e);
  sigCtx.beginPath();
  sigCtx.moveTo(sigLast[0], sigLast[1]);
  sigCtx.lineTo(pt[0], pt[1]);
  sigCtx.stroke();
  sigLast = pt;
});
sigCanvas.addEventListener('pointerup', () => { sigLast = null; });
sigCanvas.addEventListener('pointercancel', () => { sigLast = null; });

$('sigClear').addEventListener('click', () => {
  sigCtx.save();
  sigCtx.setTransform(1, 0, 0, 1, 0, 0);
  sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
  sigCtx.restore();
  sigInk = false;
});
$('sigCancel').addEventListener('click', closeSignature);
$('sigModal').addEventListener('pointerdown', (e) => { if (e.target === $('sigModal')) closeSignature(); });
$('sigOk').addEventListener('click', () => {
  if (!sigInk) { toast('Draw your signature first.'); return; }
  const { width, height } = sigCanvas;
  const data = sigCtx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) { toast('Draw your signature first.'); return; }
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const c = document.createElement('canvas');
  c.width = x1 - x0 + 1;
  c.height = y1 - y0 + 1;
  c.getContext('2d').drawImage(sigCanvas, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  const dpr = window.devicePixelRatio || 1;
  const id = registerImage(c.toDataURL('image/png'), 'png', c.width / dpr, c.height / dpr);
  const place = pendingPlace;
  $('sigModal').hidden = true;
  pendingPlace = place;
  placeImage(id, 180);
});

/* ---------------- export ---------------- */

function dataUrlBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function buildPdf() {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  let charset = null;
  try { charset = new Set(font.getCharacterSet()); } catch { /* keep text as-is */ }
  const embeddedImages = new Map();

  // Copy pages per source in one call so shared resources (fonts, images) aren't duplicated.
  const copied = new Map();
  const bySource = new Map();
  for (const p of state.pages) {
    if (p.src === null) continue;
    if (!bySource.has(p.src)) bySource.set(p.src, []);
    bySource.get(p.src).push(p.index);
  }
  for (const [src, indices] of bySource) {
    const doc = await PDFDocument.load(state.sources[src].bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(doc, indices);
    indices.forEach((idx, i) => copied.set(`${src}:${idx}`, pages[i]));
  }

  for (const p of state.pages) {
    const page = p.src === null ? out.addPage([p.baseW, p.baseH]) : out.addPage(copied.get(`${p.src}:${p.index}`));
    page.setRotation(degrees((p.rot0 + p.rot) % 360));
    if (p.annots.length) await drawAnnotations(out, page, p, font, charset, embeddedImages);
  }
  return out.save();
}

async function drawAnnotations(out, page, p, font, charset, embeddedImages) {
  // Isolate the original content so any graphics state it leaves behind can't skew our drawing.
  try {
    const ctx = out.context;
    page.node.wrapContentStreams(
      ctx.register(ctx.contentStream([pushGraphicsState()])),
      ctx.register(ctx.contentStream([popGraphicsState()])),
    );
  } catch { /* older pdf-lib: draw without wrapping */ }

  // Transform so we can draw in the base frame with y up (width baseW, height baseH).
  const r0 = p.rot0 % 360;
  const W = r0 % 180 ? p.baseH : p.baseW; // unrotated page size
  const H = r0 % 180 ? p.baseW : p.baseH;
  let x0 = 0, y0 = 0;
  if (p.src !== null) { const box = page.getCropBox(); x0 = box.x; y0 = box.y; }
  const m = {
    0: [1, 0, 0, 1, x0, y0],
    90: [0, 1, -1, 0, W + x0, y0],
    180: [-1, 0, 0, -1, W + x0, H + y0],
    270: [0, -1, 1, 0, x0, H + y0],
  }[r0];
  const Bh = p.baseH;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));

  for (const a of p.annots) {
    if (a.type === 'text') {
      const clean = [...a.text.replace(/\r/g, '').replace(/\t/g, '    ')]
        .map((ch) => (ch === '\n' || !charset || charset.has(ch.codePointAt(0)) ? ch : '?')).join('');
      clean.split('\n').forEach((line, i) => {
        if (!line) return;
        page.drawText(line, { x: a.x, y: Bh - (a.y + a.size * (0.8 + 1.2 * i)), size: a.size, font, color: hexToRgb(a.color) });
      });
    } else if (a.type === 'ink') {
      page.drawSvgPath(inkPath(a.points), {
        x: 0, y: Bh, borderColor: hexToRgb(a.color), borderWidth: a.width,
        borderLineCap: LineCapStyle ? LineCapStyle.Round : undefined,
      });
    } else if (a.type === 'rect') {
      const box = { x: a.x, y: Bh - a.y - a.h, width: a.w, height: a.h };
      if (a.kind === 'highlight') {
        page.drawRectangle({ ...box, color: hexToRgb(a.color), opacity: 0.4, blendMode: BlendMode ? BlendMode.Multiply : undefined });
      } else if (a.kind === 'whiteout') {
        page.drawRectangle({ ...box, color: rgb(1, 1, 1) });
      } else {
        page.drawRectangle({ ...box, borderColor: hexToRgb(a.color), borderWidth: a.width });
      }
    } else if (a.type === 'image') {
      let img = embeddedImages.get(a.imageId);
      if (!img) {
        const im = state.images[a.imageId];
        const bytes = dataUrlBytes(im.dataUrl);
        img = im.kind === 'jpg' ? await out.embedJpg(bytes) : await out.embedPng(bytes);
        embeddedImages.set(a.imageId, img);
      }
      page.drawImage(img, { x: a.x, y: Bh - a.y - a.h, width: a.w, height: a.h });
    }
  }
  page.pushOperators(popGraphicsState());
}

async function download() {
  if (!state.pages.length || document.body.classList.contains('busy')) return;
  finishEdit();
  busy(true, 'Building PDF…');
  try {
    const bytes = await buildPdf();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.fileName}-edited.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    dirty = false;
  } catch (err) {
    console.error(err);
    toast(`Couldn't build the PDF: ${err.message}`);
  } finally {
    busy(false);
  }
}

/* ---------------- wiring ---------------- */

const openPicker = () => { $('filePdf').value = ''; $('filePdf').click(); };
$('btnOpen').addEventListener('click', openPicker);
$('btnOpen2').addEventListener('click', openPicker);
$('filePdf').addEventListener('change', (e) => { if (e.target.files.length) loadPdfFiles([e.target.files[0]], true); });
$('btnMerge').addEventListener('click', () => { $('fileMerge').value = ''; $('fileMerge').click(); });
$('fileMerge').addEventListener('change', (e) => { if (e.target.files.length) loadPdfFiles([...e.target.files], false); });
$('btnBlank').addEventListener('click', addBlankPage);
$('btnBlank2').addEventListener('click', addBlankPage);
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('btnDelete').addEventListener('click', deleteSelected);
$('btnZoomIn').addEventListener('click', () => setZoom(state.zoom * 1.2));
$('btnZoomOut').addEventListener('click', () => setZoom(state.zoom / 1.2));
$('btnFit').addEventListener('click', fitWidth);
$('btnDownload').addEventListener('click', download);
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

// Clicking outside any page deselects.
viewer.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.page') && state.selected) setSelected(null);
});

const TOOL_KEYS = { v: 'select', t: 'text', d: 'draw', h: 'highlight', r: 'rect', w: 'whiteout', i: 'image', s: 'sign' };
document.addEventListener('keydown', (e) => {
  if (!$('sigModal').hidden) { if (e.key === 'Escape') closeSignature(); return; }
  if (e.target.matches('input, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && key === 'y') { e.preventDefault(); redo(); }
  else if (mod && key === 's') { e.preventDefault(); download(); }
  else if (mod && key === 'o') { e.preventDefault(); openPicker(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape') { setSelected(null); if (state.tool !== 'select') setTool('select'); }
  else if (!mod && !e.altKey && state.pages.length) {
    if (TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
    else if (e.key === '+' || e.key === '=') setZoom(state.zoom * 1.2);
    else if (e.key === '-') setZoom(state.zoom / 1.2);
  }
});

// Drag & drop PDFs onto the window.
let dropDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropDepth++;
  $('dropmask').firstElementChild.textContent = state.pages.length ? 'Drop PDFs to add their pages' : 'Drop PDF to open';
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
  const pdfs = [...e.dataTransfer.files].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast('Only PDF files can be dropped here.'); return; }
  if (state.pages.length) loadPdfFiles(pdfs, false);
  else loadPdfFiles(pdfs.slice(0, 1), true).then(() => { if (pdfs.length > 1) loadPdfFiles(pdfs.slice(1), false); });
});

window.addEventListener('beforeunload', (e) => {
  if (dirty && state.pages.length) { e.preventDefault(); e.returnValue = ''; }
});

updateUI();
