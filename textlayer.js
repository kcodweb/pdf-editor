'use strict';

// Text that's already in the PDF. pdf.js reports it as scattered fragments; we group them into
// lines (in the page's base frame) and use those lines for:
//   - an invisible, selectable text layer so text can be copied,
//   - "Edit text": cover a line with its background color and retype it,
//   - search, redaction and keeping exported pages searchable.
// Scanned pages have no text, so OCR results (state.ocr) stand in for them.

const lineCache = new Map();

const ocrKey = (p) => (p.src === null ? `page|${p.id}` : `${p.src}|${p.index}`);

function getLines(p) {
  const ocr = state.ocr[ocrKey(p)];
  return ocr ? Promise.resolve(ocr) : pdfLines(p);
}

function pdfLines(p) {
  if (p.src === null) return Promise.resolve([]);
  const key = `${p.src}|${p.index}`;
  if (!lineCache.has(key)) {
    lineCache.set(key, (async () => {
      const page = await state.sources[p.src].pdf.getPage(p.index + 1);
      const vp = page.getViewport({ scale: 1 }); // scale 1 with the page's own rotation = base frame
      return groupLines(await page.getTextContent(), vp);
    })().catch((err) => {
      console.warn('Could not read page text', err);
      return [];
    }));
  }
  return lineCache.get(key);
}

function groupLines(content, vp) {
  const frags = [];
  for (const item of content.items) {
    if (!item.str || !item.transform) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
    const size = Math.hypot(tx[2], tx[3]);
    if (size < 2 || Math.abs(Math.atan2(tx[1], tx[0])) > 0.02) continue; // horizontal text only
    const style = content.styles[item.fontName] || {};
    frags.push({ x: tx[4], baseline: tx[5], size, w: item.width, str: item.str, fontName: item.fontName, generic: style.fontFamily || '' });
  }

  // Rows share a baseline; within a row, fragments close together form a line.
  frags.sort((a, b) => a.baseline - b.baseline);
  const rows = [];
  for (const f of frags) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(f.baseline - row.baseline) < row.size * 0.35) row.items.push(f);
    else rows.push({ baseline: f.baseline, size: f.size, items: [f] });
  }

  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const f of row.items) {
      const gap = cur ? f.x - (cur.x + cur.w) : 0;
      if (cur && gap < cur.size * 1.5 && gap > -cur.size * 0.5 && Math.abs(f.size - cur.size) < cur.size * 0.3) {
        if (gap > cur.size * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(f.str)) cur.text += ' ';
        cur.text += f.str;
        cur.w = Math.max(cur.w, f.x + f.w - cur.x);
        // A line mixing fonts can't be redrawn in a single original font.
        if (f.str.trim() && f.fontName !== cur.fontName) cur.mixedFonts = true;
      } else {
        if (cur) lines.push(cur);
        cur = f.str.trim()
          ? { x: f.x, baseline: f.baseline, size: f.size, w: f.w, text: f.str, fontName: f.fontName, generic: f.generic }
          : null;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+$/, '') }))
    .filter((l) => l.text && l.w > 0);
}

const lineFamily = (l) => (/monospace/.test(l.generic) ? 'mono' : l.generic === 'serif' ? 'serif' : 'sans');
const genericCss = (l) => ({ mono: 'monospace', serif: 'serif', sans: 'sans-serif' }[lineFamily(l)]);

// Width of a prefix of a line's text, scaled so the whole text spans the line's real width.
function lineMeasurer(line, measure) {
  const full = measure(line.text) || 1;
  return (i) => (line.w * measure(line.text.slice(0, i))) / full;
}
function genericMeasure(line) {
  return (s) => {
    measureCtx.font = `${line.size}px ${genericCss(line)}`;
    return measureCtx.measureText(s).width;
  };
}

/* ---------------- selectable text layer ---------------- */

async function buildTextLayer(el, p) {
  if (el.querySelector('.text-layer')) return;
  if (p.src === null && !state.ocr[ocrKey(p)]) return;
  const layer = document.createElement('div');
  layer.className = 'text-layer';
  el.appendChild(layer);
  sizeTextLayer(el, p);
  const lines = await getLines(p);
  if (!el.isConnected) return;
  layer.style.width = `${p.baseW}px`;
  layer.style.height = `${p.baseH}px`;
  lines.forEach((l, i) => {
    const span = document.createElement('span');
    span.className = 'tl-line';
    span.dataset.line = i;
    span.textContent = l.text;
    const family = genericCss(l);
    Object.assign(span.style, {
      left: `${l.x}px`,
      top: `${l.baseline - l.size * 0.92}px`,
      fontSize: `${l.size}px`,
      lineHeight: `${l.size * 1.2}px`,
      fontFamily: family,
    });
    measureCtx.font = `${l.size}px ${family}`;
    const natural = measureCtx.measureText(l.text).width;
    if (natural > 0) span.style.transform = `scaleX(${l.w / natural})`;
    layer.append(span, document.createElement('br'));
  });
}

function rebuildTextLayers(key) {
  for (const p of state.pages) {
    if (ocrKey(p) !== key) continue;
    const el = pageElOf(p.id);
    if (!el) continue;
    el.querySelector('.text-layer')?.remove();
    buildTextLayer(el, p);
  }
}

function sizeTextLayer(el, p) {
  const layer = el.querySelector('.text-layer');
  if (!layer) return;
  const m = rotMatrix(p.rot, p.baseW, p.baseH).map((v) => v * state.zoom);
  layer.style.transform = `matrix(${m.join(',')})`;
}

/* ---------------- the PDF's own fonts ---------------- */

// Edited text is drawn with the original font resource whenever that font contains every
// character typed. Info per font: which page resource it is, the character code for each
// Unicode character, and the browser font pdf.js registered for it (for the on-screen preview).
const origFonts = new Map();
const inspectDocs = new Map();

function inspectDoc(src) {
  if (!inspectDocs.has(src)) {
    inspectDocs.set(src, PDFDocument.load(state.sources[src].bytes, { ignoreEncryption: true, updateMetadata: false }));
  }
  return inspectDocs.get(src);
}

function pageFontDict(doc, index) {
  const { PDFName, PDFDict } = PDFLib;
  // Resources can be inherited from a parent node in the page tree.
  for (let node = doc.getPage(index).node, depth = 0; node && depth < 32; depth++) {
    const resources = node.lookupMaybe(PDFName.of('Resources'), PDFDict);
    if (resources) return resources.lookupMaybe(PDFName.of('Font'), PDFDict);
    const parent = node.get(PDFName.of('Parent'));
    node = parent ? doc.context.lookup(parent) : null;
  }
  return undefined;
}

const stripSubset = (s) => String(s || '').replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');

async function resolveOrigFont(p, fontName) {
  const key = `${p.src}|${p.index}|${fontName}`;
  if (origFonts.has(key)) return origFonts.get(key);
  let info = null;
  try {
    const { PDFName, PDFDict } = PDFLib;
    const page = await state.sources[p.src].pdf.getPage(p.index + 1);
    if (!page.commonObjs.has(fontName)) await page.getOperatorList();
    const f = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
    if (f && !f.isType3Font && !f.vertical && f.toUnicode && f.toUnicode._map) {
      const fonts = pageFontDict(await inspectDoc(p.src), p.index);
      const resKey = fonts && fonts.keys().find((k) => stripSubset(fonts.lookup(k, PDFDict).get(PDFName.of('BaseFont'))) === stripSubset(f.name));
      const dict = resKey && fonts.lookup(resKey, PDFDict);
      const subtype = dict && String(dict.get(PDFName.of('Subtype')));
      const two = subtype === '/Type0';
      const encodingOk = !two || String(dict.get(PDFName.of('Encoding'))) === '/Identity-H';
      if (dict && subtype !== '/Type3' && encodingOk) {
        const codeFor = new Map();
        const screenFor = new Map();
        const loaded = !f.missingFile && [...document.fonts].some((ff) => ff.family.replace(/["']/g, '') === f.loadedName && ff.status === 'loaded');
        Object.entries(f.toUnicode._map).forEach(([codeStr, uni]) => {
          const code = Number(codeStr);
          if (typeof uni !== 'string' || [...uni].length !== 1 || codeFor.has(uni)) return;
          if (code > (two ? 0xffff : 0xff)) return;
          codeFor.set(uni, code);
          const fontChar = f.toFontChar[code];
          screenFor.set(uni, fontChar != null ? String.fromCodePoint(fontChar) : uni);
        });
        info = {
          res: resKey.asString().slice(1), two, codeFor, screenFor,
          family: loaded ? f.loadedName : null,
          name: f.name, bold: !!(f.bold || f.black), italic: !!f.italic,
        };
      }
    }
  } catch (err) {
    console.warn('Original font unavailable', err);
  }
  origFonts.set(key, info);
  return info;
}

// The resolved original font for a text annotation, if it can draw all of its text.
function origFontState(a) {
  if (a.font !== 'original' || !a.orig) return null;
  const info = origFonts.get(a.orig.key);
  if (!info) return null;
  for (const ch of a.text) if (ch !== '\n' && !info.codeFor.has(ch)) return null;
  return info;
}

async function lineFontStyle(p, line) {
  const style = { font: lineFamily(line), bold: false, italic: false };
  if (p.src === null || line.ocr) return style;
  try {
    const page = await state.sources[p.src].pdf.getPage(p.index + 1);
    if (page.commonObjs.has(line.fontName)) {
      const f = page.commonObjs.get(line.fontName);
      const name = f.name || '';
      style.bold = !!(f.bold || f.black) || /bold|black|heavy|semibold|demi/i.test(name);
      style.italic = !!f.italic || /italic|oblique/i.test(name);
      style.font = matchFontFamily(name, line.generic);
    }
  } catch { /* keep the generic guess */ }
  if (!line.mixedFonts) {
    const info = await resolveOrigFont(p, line.fontName);
    if (info) {
      style.fallback = style.font;
      style.font = 'original';
      style.orig = { key: `${p.src}|${p.index}|${line.fontName}` };
    }
  }
  return style;
}

/* ---------------- rasterizing & colors ---------------- */

const imageElements = new Map();
function imageElement(imageId) {
  if (!imageElements.has(imageId)) imageElements.set(imageId, decodeImage(state.images[imageId].dataUrl));
  return imageElements.get(imageId);
}

// The page in its base frame with pasted images drawn on top (used by OCR and color sampling).
async function rasterizePage(p, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(p.baseW * scale));
  canvas.height = Math.max(1, Math.round(p.baseH * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (p.src !== null) {
    const page = await state.sources[p.src].pdf.getPage(p.index + 1);
    // 'print' intent renders without waiting for animation frames, so it also works in a background tab.
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale, rotation: p.rot0 }), intent: 'print' }).promise;
  }
  for (const a of p.annots) {
    if (a.type !== 'image' || !state.images[a.imageId]) continue;
    ctx.drawImage(await imageElement(a.imageId), a.x * scale, a.y * scale, a.w * scale, a.h * scale);
  }
  return canvas;
}

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// Background = most common color in the box; text = the pixels most different from it.
function colorsFromPixels(data) {
  const counts = new Map();
  let bgKey = 0;
  let bgCount = 0;
  const bucket = (i) => ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
  for (let i = 0; i < data.length; i += 4) {
    const c = (counts.get(bucket(i)) || 0) + 1;
    counts.set(bucket(i), c);
    if (c > bgCount) { bgCount = c; bgKey = bucket(i); }
  }
  let br = 0, bgc = 0, bb = 0, bn = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (bucket(i) === bgKey) { br += data[i]; bgc += data[i + 1]; bb += data[i + 2]; bn++; }
  }
  const bg = [br / bn, bgc / bn, bb / bn];
  const dist = (i) => Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
  let maxD = 0;
  for (let i = 0; i < data.length; i += 4) maxD = Math.max(maxD, dist(i));
  if (maxD < 60) return { text: bg[0] + bg[1] + bg[2] > 380 ? '#000000' : '#ffffff', bg: toHex(...bg) };
  let tr = 0, tg = 0, tb = 0, tn = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (dist(i) >= maxD * 0.8) { tr += data[i]; tg += data[i + 1]; tb += data[i + 2]; tn++; }
  }
  return { text: toHex(tr / tn, tg / tn, tb / tn), bg: toHex(...bg) };
}

async function sampleColors(p, box) {
  const fallback = { text: '#000000', bg: '#ffffff' };
  const overImage = p.annots.some((a) => a.type === 'image' && a.x < box.x + box.w && a.x + a.w > box.x && a.y < box.y + box.h && a.y + a.h > box.y);
  try {
    if (overImage || p.src === null) {
      // Scans pasted as images aren't on the page canvas, so render the page with them.
      const scale = 2;
      const canvas = await rasterizePage(p, scale);
      const x0 = clamp(Math.floor(box.x * scale), 0, canvas.width - 1);
      const y0 = clamp(Math.floor(box.y * scale), 0, canvas.height - 1);
      const w = clamp(Math.ceil(box.w * scale), 1, canvas.width - x0);
      const h = clamp(Math.ceil(box.h * scale), 1, canvas.height - y0);
      return colorsFromPixels(canvas.getContext('2d').getImageData(x0, y0, w, h).data);
    }
    const el = pageElOf(p.id);
    const canvas = el && el.querySelector('canvas');
    if (!canvas || !canvas.width || !el.dataset.rendered) return fallback;
    const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => pagePoint(el, x, y));
    const sx = canvas.width / el.clientWidth;
    const sy = canvas.height / el.clientHeight;
    const x0 = clamp(Math.floor(Math.min(...corners.map((c) => c.x)) * sx), 0, canvas.width - 1);
    const y0 = clamp(Math.floor(Math.min(...corners.map((c) => c.y)) * sy), 0, canvas.height - 1);
    const x1 = clamp(Math.ceil(Math.max(...corners.map((c) => c.x)) * sx), x0 + 1, canvas.width);
    const y1 = clamp(Math.ceil(Math.max(...corners.map((c) => c.y)) * sy), y0 + 1, canvas.height);
    return colorsFromPixels(canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, x1 - x0, y1 - y0).data);
  } catch {
    return fallback;
  }
}

/* ---------------- editing existing text ---------------- */

async function startReplaceEdit(p, line) {
  const top = line.baseline - line.size * 0.92;
  const height = line.size * 1.2;
  // Clicking a line that was already edited reopens that edit.
  const existing = p.annots.find((a) => a.type === 'text' && a.cover
    && a.cover.x < line.x + line.w && a.cover.x + a.cover.w > line.x
    && Math.abs(a.cover.y + a.cover.h / 2 - (top + height / 2)) < line.size * 0.5);
  if (existing) {
    startEdit(p, existing, false, snapshot());
    return;
  }
  const snap = snapshot();
  const [style, colors] = await Promise.all([lineFontStyle(p, line), sampleColors(p, { x: line.x, y: top, w: line.w, h: height })]);
  const pad = Math.max(1, line.size * 0.08);
  const a = {
    id: uid(), type: 'text', text: line.text, color: colors.text, ...style,
    x: line.x, y: line.baseline - line.size * 0.8, size: Math.round(line.size * 10) / 10,
    cover: { x: line.x - pad, y: top - pad / 2, w: line.w + pad * 2, h: height + pad, fill: colors.bg },
  };
  p.annots.push(a);
  startEdit(p, a, true, snap);
}

const noTextHinted = new Set();

function initTextLayer() {
  pagesEl.addEventListener('click', async (e) => {
    if (state.tool !== 'edittext' || e.target.closest('.text-editor')) return;
    const pageEl = e.target.closest('.page');
    if (!pageEl) return;
    const p = findPage(pageEl.dataset.id);
    const span = e.target.closest('.tl-line');
    if (!span) {
      if (p && !noTextHinted.has(p.id) && !(await getLines(p)).length) {
        noTextHinted.add(p.id);
        toast('This page has no text to edit — it looks like a scan or photo. Use More → Recognize text in scans (OCR) first.');
      }
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // the user dragged to select text for copying
    const line = p && (await getLines(p))[Number(span.dataset.line)];
    if (line) startReplaceEdit(p, line);
  });
}

/* ---------------- what stays readable after covering ---------------- */

// Areas whose underlying text is hidden: white-out, redactions and edited lines' covers.
function coverRects(p) {
  const rects = [];
  for (const a of p.annots) {
    if (a.type === 'rect' && (a.kind === 'whiteout' || a.kind === 'redact')) rects.push({ x: a.x, y: a.y, w: a.w, h: a.h, from: a });
    if (a.type === 'text' && a.cover) rects.push({ ...a.cover, from: a });
  }
  return rects;
}

// Pieces of a line whose characters aren't under any of `rects`.
function visibleSegments(line, rects, measure) {
  const top = line.baseline - line.size * 0.8;
  const bottom = line.baseline + line.size * 0.2;
  const hits = rects.filter((r) => r.y < bottom && r.y + r.h > top && r.x < line.x + line.w && r.x + r.w > line.x);
  if (!hits.length) return [{ text: line.text, x: line.x, w: line.w }];
  const at = lineMeasurer(line, measure);
  const chars = [...line.text];
  const segments = [];
  let cur = null;
  let offset = 0;
  for (const ch of chars) {
    const x0 = line.x + at(offset);
    const x1 = line.x + at(offset + ch.length);
    offset += ch.length;
    const cx = (x0 + x1) / 2;
    if (hits.some((r) => cx >= r.x && cx <= r.x + r.w)) {
      if (cur) segments.push(cur);
      cur = null;
    } else {
      if (!cur) cur = { text: '', x: x0, w: 0 };
      cur.text += ch;
      cur.w = x1 - cur.x;
    }
  }
  if (cur) segments.push(cur);
  return segments.filter((s) => s.text.trim());
}

// Text that should remain searchable on a page: its (OCR or PDF) lines minus covered parts,
// plus text added in the editor. Positions are in the base frame.
async function readableText(p, { includePdfText = true } = {}) {
  const rects = coverRects(p);
  const items = [];
  const lines = includePdfText ? await getLines(p) : (state.ocr[ocrKey(p)] || []);
  for (const line of lines) {
    for (const seg of visibleSegments(line, rects, genericMeasure(line))) {
      items.push({ text: seg.text, x: seg.x, baseline: line.baseline, size: line.size, w: seg.w });
    }
  }
  if (includePdfText) {
    for (const a of p.annots) {
      if (a.type !== 'text') continue;
      a.text.split('\n').forEach((text, i) => {
        if (!text.trim()) return;
        const line = { text, x: a.x, baseline: a.y + a.size * (0.8 + 1.2 * i), size: a.size, w: textWidth(text, a) };
        const others = rects.filter((r) => r.from !== a && p.annots.indexOf(r.from) > p.annots.indexOf(a));
        for (const seg of visibleSegments(line, others, (s) => textWidth(s, a))) {
          items.push({ text: seg.text, x: seg.x, baseline: line.baseline, size: line.size, w: seg.w });
        }
      });
    }
  }
  return items;
}

/* ---------------- OCR ---------------- */

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let tesseractLoading = null;

function loadTesseract() {
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESSERACT_URL;
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => {
        tesseractLoading = null;
        script.remove();
        reject(new Error("Couldn't download the text recognition engine. Check your internet connection."));
      };
      document.head.appendChild(script);
    });
  }
  return tesseractLoading;
}

function ocrLines(data, scale) {
  const lines = [];
  for (const l of data.lines || []) {
    const text = l.text.replace(/\s+/g, ' ').trim();
    if (!text || l.confidence < 35) continue;
    const b = l.bbox;
    let baseline = l.baseline ? (l.baseline.y0 + l.baseline.y1) / 2 : NaN;
    if (!(baseline > b.y0 && baseline <= b.y1 + 2)) baseline = b.y1 - (b.y1 - b.y0) * 0.2;
    lines.push({
      x: b.x0 / scale, baseline: baseline / scale, w: (b.x1 - b.x0) / scale,
      size: Math.max(4, (baseline - b.y0) / scale / 0.72),
      text, generic: 'sans-serif', ocr: true,
    });
  }
  return lines;
}

async function pagesWithoutText() {
  const result = [];
  for (const p of state.pages) {
    if (state.ocr[ocrKey(p)]) continue;
    if (!(await pdfLines(p)).length) result.push(p);
  }
  return result;
}

async function openOcrDialog() {
  if (!state.pages.length) return;
  finishEdit();
  openModal('ocrModal');
  $('ocrCurrentLabel').textContent = `Current page (${state.current + 1})`;
  $('ocrAllLabel').textContent = `All pages (${state.pages.length})`;
  $('ocrTextlessLabel').textContent = 'Pages without text (checking…)';
  const textless = await pagesWithoutText();
  $('ocrTextlessLabel').textContent = `Pages without text (${textless.length})`;
  const radio = document.querySelector('input[name=ocrPages][value=textless]');
  radio.disabled = !textless.length;
  if (!textless.length && radio.checked) document.querySelector('input[name=ocrPages][value=current]').checked = true;
}

async function runOcr(pages, lang) {
  if (!pages.length) return;
  finishEdit();
  busy(true, 'Loading text recognition…');
  let worker = null;
  let current = 0;
  try {
    const Tesseract = await loadTesseract();
    worker = await Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          progress(`Recognizing text: page ${current + 1} of ${pages.length}… ${Math.round(m.progress * 100)}%`, (current + m.progress) / pages.length);
        } else if (m.status) {
          progress(`Preparing text recognition (${m.status}${m.progress ? ` ${Math.round(m.progress * 100)}%` : ''})…`, null);
        }
      },
    });
    // Recognizing a page can take seconds, so Cancel stops the engine right away.
    job.onCancel = () => worker && worker.terminate();
    let found = 0;
    for (current = 0; current < pages.length; current++) {
      await checkpoint();
      const p = pages[current];
      const scale = Math.min(300 / 72, 3200 / Math.max(p.baseW, p.baseH));
      const canvas = await rasterizePage(p, scale);
      const { data } = await worker.recognize(canvas);
      canvas.width = canvas.height = 0;
      const lines = ocrLines(data, scale);
      state.ocr[ocrKey(p)] = lines;
      found += lines.length;
      rebuildTextLayers(ocrKey(p));
    }
    dirty = true;
    toast(found
      ? `Recognized ${found} line${found === 1 ? '' : 's'} of text. You can now search, copy and edit it, and the download will be searchable.`
      : 'No readable text was found on those pages.');
    if (!$('searchbar').hidden && search.query.trim()) runSearch(search.query);
  } catch (err) {
    if (isCancel(err) || job.cancelled) toast('Text recognition was cancelled. Pages finished so far keep their text.');
    else {
      console.error(err);
      toast(err.message || 'Text recognition failed.');
    }
  } finally {
    job.onCancel = null;
    if (worker) worker.terminate();
    busy(false);
  }
}

function initOcr() {
  $('ocrForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const which = document.querySelector('input[name=ocrPages]:checked').value;
    closeModal('ocrModal');
    const pages = which === 'all' ? [...state.pages]
      : which === 'current' ? [state.pages[state.current]].filter(Boolean)
        : await pagesWithoutText();
    // Pages that share a source page only need recognizing once.
    const unique = [...new Map(pages.map((p) => [ocrKey(p), p])).values()];
    runOcr(unique, $('ocrLang').value);
  });
}

/* ---------------- search ---------------- */

const search = { query: '', hits: [], index: -1, token: 0, textless: 0 };

function matchRect(line, start, end) {
  const at = lineMeasurer(line, genericMeasure(line));
  const x0 = line.x + at(start);
  return { x: x0, y: line.baseline - line.size * 0.88, w: Math.max(2, line.x + at(end) - x0), h: line.size * 1.12 };
}

function openSearch() {
  if (!state.pages.length) return;
  $('searchbar').hidden = false;
  $('searchInput').focus();
  $('searchInput').select();
  if ($('searchInput').value.trim()) runSearch($('searchInput').value, { scroll: true });
}

function closeSearch() {
  $('searchbar').hidden = true;
  search.token++;
  search.query = '';
  search.hits = [];
  search.index = -1;
  state.pages.forEach(renderOverlay);
}

async function runSearch(query, { scroll = false } = {}) {
  const token = ++search.token;
  const q = query.trim().toLowerCase();
  search.query = query;
  const hits = [];
  let textless = 0;
  if (q) {
    $('searchCount').textContent = 'Searching…';
    for (const p of state.pages) {
      const lines = await getLines(p);
      if (token !== search.token) return;
      if (!lines.length) textless++;
      for (const line of lines) {
        const text = line.text.toLowerCase();
        for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
          hits.push({ pageId: p.id, rect: matchRect(line, at, at + q.length) });
        }
      }
    }
  }
  const previous = search.hits[search.index];
  search.hits = hits;
  search.textless = textless;
  // Keep the same match active when results are refreshed after an edit.
  search.index = hits.length ? Math.max(0, previous ? hits.findIndex((h) => h.pageId === previous.pageId && h.rect.x === previous.rect.x && h.rect.y === previous.rect.y) : 0) : -1;
  updateSearchUI();
  state.pages.forEach(renderOverlay);
  if (scroll && hits.length) scrollToHit(hits[search.index]);
}

function updateSearchUI() {
  const n = search.hits.length;
  let label = '';
  if (search.query.trim()) {
    label = n ? `${search.index + 1} of ${n}` : 'No matches';
    if (!n && search.textless) label += ` · ${search.textless} page${search.textless === 1 ? '' : 's'} need OCR`;
  }
  $('searchCount').textContent = label;
  $('searchPrev').disabled = $('searchNext').disabled = $('searchHighlight').disabled = $('searchRedact').disabled = !n;
}

function stepSearch(delta) {
  const n = search.hits.length;
  if (!n) return;
  search.index = (search.index + delta + n) % n;
  updateSearchUI();
  state.pages.forEach(renderOverlay);
  scrollToHit(search.hits[search.index]);
}

function scrollToHit(hit) {
  const el = pageElOf(hit.pageId);
  if (!el) return;
  const at = pagePoint(el, hit.rect.x, hit.rect.y);
  viewer.scrollTo({
    top: el.offsetTop + at.y - viewer.clientHeight / 3,
    left: Math.max(0, el.offsetLeft + at.x - viewer.clientWidth / 2),
    behavior: 'smooth',
  });
}

function markAllMatches(kind) {
  if (!search.hits.length) return;
  pushHistory();
  for (const hit of search.hits) {
    const p = findPage(hit.pageId);
    if (!p) continue;
    const { x, y, w, h } = hit.rect;
    const a = { id: uid(), type: 'rect', kind, x: x - 1, y, w: w + 2, h };
    if (kind === 'highlight') a.color = state.colors.highlight;
    p.annots.push(a);
  }
  const n = search.hits.length;
  closeSearch();
  renderAll();
  toast(kind === 'redact'
    ? `Redacted ${n} match${n === 1 ? '' : 'es'}. They're removed for good when you download.`
    : `Highlighted ${n} match${n === 1 ? '' : 'es'}.`);
}

function drawSearchHits(g, p) {
  search.hits.forEach((hit, i) => {
    if (hit.pageId !== p.id) return;
    const { x, y, w, h } = hit.rect;
    g.appendChild(svgEl('rect', { class: i === search.index ? 'search-hit current' : 'search-hit', x, y, width: w, height: h }));
  });
}

function initSearch() {
  let timer;
  $('searchInput').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch($('searchInput').value, { scroll: true }), 220);
  });
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (search.query !== $('searchInput').value) runSearch($('searchInput').value, { scroll: true });
      else stepSearch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });
  $('searchPrev').addEventListener('click', () => stepSearch(-1));
  $('searchNext').addEventListener('click', () => stepSearch(1));
  $('searchHighlight').addEventListener('click', () => markAllMatches('highlight'));
  $('searchRedact').addEventListener('click', () => markAllMatches('redact'));
  $('searchClose').addEventListener('click', closeSearch);
  $('btnFind').addEventListener('click', openSearch);
  updateSearchUI();
}
