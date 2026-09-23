'use strict';

// More tools: grayscale, pages per sheet (N-up), crop, document properties, Excel to PDF and
// compare. Each works on the engine's current document (state.pages) or on files directly.

const openPdfJs = (bytes) => pdfjsLib.getDocument({
  data: bytes.slice(), cMapUrl: `${PDFJS_CDN}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS_CDN}standard_fonts/`,
}).promise;

async function renderPdfPage(page, scale, { gray = false } = {}) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
  if (gray) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const canvasToJpeg = (canvas, quality) => new Promise((resolve) => canvas.toBlob(async (blob) => {
  resolve(new Uint8Array(await blob.arrayBuffer()));
}, 'image/jpeg', quality));

// Base frame -> displayed page (y up) for invisible text on re-rendered pages.
function displayedTextPlacer(p, h) {
  const m = rotMatrix(p.rot, p.baseW, p.baseH);
  const angle = (Math.atan2(-m[1], m[0]) * 180) / Math.PI;
  return (it) => ({ x: m[0] * it.x + m[2] * it.baseline + m[4], y: h - (m[1] * it.x + m[3] * it.baseline + m[5]), angle });
}

/* ---------------- grayscale ---------------- */

// Pages are re-rendered in shades of gray; the text is laid over them invisibly so it stays searchable.
async function grayscalePdf(pages, dpi) {
  const bytes = await buildFinalPdf(pages, { flatten: true, quietProgress: true });
  const rendered = await openPdfJs(bytes);
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const fonts = new Map();
  try {
    for (let i = 0; i < pages.length; i++) {
      progress(`Converting page ${i + 1} of ${pages.length}…`, (i + 1) / pages.length);
      await checkpoint();
      const p = pages[i];
      const { w, h } = pageDims(p);
      const canvas = await renderPdfPage(await rendered.getPage(i + 1), dpi / 72, { gray: true });
      const image = await out.embedJpg(await canvasToJpeg(canvas, 0.85));
      canvas.width = canvas.height = 0;
      const page = out.addPage([w, h]);
      page.drawImage(image, { x: 0, y: 0, width: w, height: h });
      await drawHiddenText(out, page, await readableText(p), fonts, displayedTextPlacer(p, h));
    }
  } finally {
    rendered.destroy();
  }
  return out.save({ objectsPerTick: 200 });
}

/* ---------------- pages per sheet ---------------- */

const NUP_GRID = { 2: [2, 1, 'landscape'], 4: [2, 2, 'portrait'], 6: [3, 2, 'landscape'], 9: [3, 3, 'portrait'], 16: [4, 4, 'portrait'] };

async function nUpPdf(pages, { perSheet = 4, size = 'a4', orientation = 'auto', borders = false } = {}) {
  const bytes = await buildFinalPdf(pages, { quietProgress: true });
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const [gridCols, gridRows, natural] = NUP_GRID[perSheet] || NUP_GRID[4];
  const landscape = orientation === 'auto' ? natural === 'landscape' : orientation === 'landscape';
  let [W, H] = PAGE_SIZES[size] || PAGE_SIZES.a4;
  if (landscape) [W, H] = [H, W];
  // Forcing the other orientation turns the grid so each cell stays page-shaped.
  const [cols, rows] = (natural === 'landscape') === landscape ? [gridCols, gridRows] : [gridRows, gridCols];
  const margin = 18;
  const gap = 10;
  const cellW = (W - margin * 2 - gap * (cols - 1)) / cols;
  const cellH = (H - margin * 2 - gap * (rows - 1)) / rows;
  const srcPages = src.getPages();
  const boxes = srcPages.map((pg) => {
    const b = pg.getCropBox();
    return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
  });
  const embedded = await out.embedPages(srcPages, boxes);

  for (let i = 0; i < embedded.length; i += perSheet) {
    progress(`Arranging sheet ${Math.floor(i / perSheet) + 1} of ${Math.ceil(embedded.length / perSheet)}…`, i / embedded.length);
    await checkpoint();
    const sheet = out.addPage([W, H]);
    for (let k = 0; k < perSheet && i + k < embedded.length; k++) {
      const emb = embedded[i + k];
      const rot = srcPages[i + k].getRotation().angle % 360;
      const ew = emb.width;
      const eh = emb.height;
      const [dw, dh] = rot % 180 ? [eh, ew] : [ew, eh];
      const s = Math.min(cellW / dw, cellH / dh);
      const col = k % cols;
      const row = Math.floor(k / cols);
      const x = margin + col * (cellW + gap) + (cellW - dw * s) / 2;
      const y = H - margin - row * (cellH + gap) - cellH + (cellH - dh * s) / 2;
      // /Rotate turns pages clockwise when displayed; drawPage rotates counter-clockwise about its origin.
      const [ox, oy] = { 0: [0, 0], 90: [0, ew * s], 180: [ew * s, eh * s], 270: [eh * s, 0] }[rot] || [0, 0];
      sheet.drawPage(emb, { x: x + ox, y: y + oy, xScale: s, yScale: s, rotate: degrees(-rot) });
      if (borders) sheet.drawRectangle({ x, y, width: dw * s, height: dh * s, borderColor: rgb(0.6, 0.62, 0.66), borderWidth: 0.6 });
    }
  }
  return out.save({ objectsPerTick: 200 });
}

/* ---------------- crop ---------------- */

// boxes[i]: { l, t, r, b } as fractions of page i as displayed, or null to leave it alone.
async function cropPdf(pages, boxes) {
  const bytes = await buildFinalPdf(pages, { quietProgress: true });
  const doc = await PDFDocument.load(bytes);
  doc.getPages().forEach((page, i) => {
    const f = boxes[i];
    if (!f) return;
    const box = page.getCropBox();
    const R = page.getRotation().angle % 360;
    const [Wd, Hd] = R % 180 ? [box.height, box.width] : [box.width, box.height];
    const m = frameMatrix(R, box.width, box.height, box.x, box.y);
    const pts = [[f.l * Wd, (1 - f.t) * Hd], [f.r * Wd, (1 - f.b) * Hd]]
      .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const x0 = Math.min(pts[0][0], pts[1][0]);
    const x1 = Math.max(pts[0][0], pts[1][0]);
    const y0 = Math.min(pts[0][1], pts[1][1]);
    const y1 = Math.max(pts[0][1], pts[1][1]);
    page.setMediaBox(x0, y0, x1 - x0, y1 - y0);
    page.setCropBox(x0, y0, x1 - x0, y1 - y0);
  });
  return doc.save({ objectsPerTick: 200 });
}

// The area of a rendered page that isn't (near-)white, as fractions with a little padding.
function contentBounds(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 0.015;
  return {
    l: clamp(x0 / width - pad, 0, 1), t: clamp(y0 / height - pad, 0, 1),
    r: clamp(x1 / width + pad, 0, 1), b: clamp(y1 / height + pad, 0, 1),
  };
}

/* ---------------- document properties ---------------- */

async function readProperties(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const get = (fn) => { try { return fn() || ''; } catch { return ''; } };
  return {
    title: get(() => doc.getTitle()), author: get(() => doc.getAuthor()), subject: get(() => doc.getSubject()),
    keywords: get(() => doc.getKeywords()), creator: get(() => doc.getCreator()), producer: get(() => doc.getProducer()),
  };
}

async function writeProperties(bytes, props, { strip = false } = {}) {
  const { PDFName } = PDFLib;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = doc.getInfoDict();
  if (strip) {
    // Remove XMP metadata and every Info entry (dates, software, custom fields).
    doc.catalog.delete(PDFName.of('Metadata'));
    for (const key of info.keys()) info.delete(key);
  }
  const set = (key, value, setter) => {
    if (value && value.trim()) setter(value.trim());
    else info.delete(PDFName.of(key));
  };
  set('Title', props.title, (v) => doc.setTitle(v));
  set('Author', props.author, (v) => doc.setAuthor(v));
  set('Subject', props.subject, (v) => doc.setSubject(v));
  set('Keywords', props.keywords, (v) => doc.setKeywords(v.split(/[,;]/).map((k) => k.trim()).filter(Boolean)));
  if (!strip) doc.setModificationDate(new Date());
  return doc.save();
}

/* ---------------- Excel to PDF ---------------- */

let xlsxLoading = null;
function loadXlsx() {
  if (!xlsxLoading) {
    xlsxLoading = loadScript('vendor/xlsx.full.min.js').then(() => window.XLSX).catch((err) => { xlsxLoading = null; throw err; });
  }
  return xlsxLoading;
}

const SHEET_CSS = `
.sheet-page { box-sizing: border-box; background: #fff; overflow: hidden; }
.sheet-title { font: 600 12px Arial, Helvetica, sans-serif; color: #555; margin: 0 0 8px; }
.sheet-table { border-collapse: collapse; font: 11px/1.35 Calibri, Carlito, Arial, Helvetica, sans-serif; color: #111; table-layout: auto; }
.sheet-table td { padding: 2px 5px; white-space: nowrap; vertical-align: bottom; }
.sheet-table.grid td { border: 1px solid #d0d4da; }
.sheet-table td[data-t="n"] { text-align: right; }
.sheet-table tr.head td { font-weight: 700; background: #f3f4f6; }
`;

async function sheetsToPdf(file, { orientation = 'auto', repeatHeader = true, gridlines = true } = {}) {
  const XLSX = await loadXlsx();
  progress('Reading the spreadsheet…', null);
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const host = document.createElement('div');
  host.className = 'docx-render-host';
  const style = document.createElement('style');
  style.textContent = SHEET_CSS;
  document.body.appendChild(host);

  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const fonts = new Map();
  const A4 = [595.28 / PX_TO_PT, 841.89 / PX_TO_PT]; // CSS pixels
  const margin = 44;
  let pageCount = 0;
  try {
    for (const [sheetIndex, sheetName] of wb.SheetNames.entries()) {
      const ws = wb.Sheets[sheetName];
      if (!ws || !ws['!ref']) continue;
      const holder = document.createElement('div');
      holder.innerHTML = XLSX.utils.sheet_to_html(ws, { header: '', footer: '' });
      const table = holder.querySelector('table');
      if (!table || !table.rows.length) continue;
      table.removeAttribute('border');
      table.className = `sheet-table${gridlines ? ' grid' : ''}`;
      if (ws['!cols']) {
        const cols = document.createElement('colgroup');
        for (const c of ws['!cols']) {
          const col = document.createElement('col');
          if (c && (c.wpx || c.wch)) col.style.width = `${c.wpx || Math.round(c.wch * 7 + 5)}px`;
          cols.appendChild(col);
        }
        table.prepend(cols);
      }
      host.replaceChildren(style, table);
      const naturalWidth = table.offsetWidth;
      const landscape = orientation === 'landscape' || (orientation === 'auto' && naturalWidth > A4[0] - margin * 2);
      const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
      const contentW = pw - margin * 2;
      const contentH = ph - margin * 2 - 24;
      const scale = Math.max(0.35, Math.min(1, contentW / naturalWidth));
      const colgroup = table.querySelector('colgroup');
      const rows = [...table.rows];
      const header = repeatHeader && rows.length > 1 ? rows[0] : null;
      if (header) header.classList.add('head');

      let i = header ? 1 : 0;
      let part = 0;
      while (i < rows.length || (part === 0 && header)) {
        progress(`Converting "${sheetName}"… row ${i} of ${rows.length}`, (sheetIndex + i / rows.length) / wb.SheetNames.length);
        await checkpoint();
        part++;
        const page = document.createElement('section');
        page.className = 'sheet-page';
        Object.assign(page.style, { width: `${pw}px`, height: `${ph}px`, padding: `${margin}px` });
        const title = document.createElement('div');
        title.className = 'sheet-title';
        title.textContent = wb.SheetNames.length > 1 || part > 1 ? `${sheetName}${part > 1 ? ` (continued)` : ''}` : sheetName;
        const scaler = document.createElement('div');
        Object.assign(scaler.style, { transform: `scale(${scale})`, transformOrigin: '0 0', width: `${naturalWidth}px` });
        const pageTable = table.cloneNode(false);
        if (colgroup) pageTable.appendChild(colgroup.cloneNode(true));
        const tbody = document.createElement('tbody');
        pageTable.appendChild(tbody);
        scaler.appendChild(pageTable);
        page.append(title, scaler);
        host.replaceChildren(style, page);
        if (header) tbody.appendChild(header.cloneNode(true));
        let added = 0;
        while (i < rows.length) {
          tbody.appendChild(rows[i].cloneNode(true));
          if (pageTable.offsetHeight * scale > contentH && added > 0) {
            tbody.lastChild.remove();
            break;
          }
          i++;
          added++;
        }
        const wPt = pw * PX_TO_PT;
        const hPt = ph * PX_TO_PT;
        const items = htmlTextItems(page);
        const canvas = await rasterizeHtmlPage(page, SHEET_CSS, 2.2);
        const image = await out.embedJpg(await canvasToJpeg(canvas, 0.88));
        canvas.width = canvas.height = 0;
        const pdfPage = out.addPage([wPt, hPt]);
        pdfPage.drawImage(image, { x: 0, y: 0, width: wPt, height: hPt });
        await drawHiddenText(out, pdfPage, items, fonts, (it) => ({ x: it.x, y: hPt - it.baseline, angle: 0 }));
        pageCount++;
        if (!added) break;
      }
    }
    if (!pageCount) throw new Error('This spreadsheet has no cells to convert.');
    return out.save({ objectsPerTick: 200 });
  } finally {
    host.remove();
  }
}

/* ---------------- compare ---------------- */

// Word-level diff (Myers). Returns runs of { op: '=', '-' or '+', words }.
function diffWords(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const limit = Math.min(max, 4000);
  const v = new Int32Array(2 * limit + 4);
  const trace = [];
  const off = limit + 1;
  let found = false;
  for (let d = 0; d <= limit && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  if (!found) return [{ op: '-', words: a }, { op: '+', words: b }]; // too different to align
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['=', a[x - 1]]); x--; y--; }
    if (x === prevX) ops.push(['+', b[y - 1]]); else ops.push(['-', a[x - 1]]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { ops.push(['=', a[x - 1]]); x--; y--; }
  ops.reverse();
  const runs = [];
  for (const [op, word] of ops) {
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.words.push(word);
    else runs.push({ op, words: [word] });
  }
  return runs;
}

async function pageWords(page) {
  const content = await page.getTextContent();
  return content.items.map((i) => i.str).join(' ').split(/\s+/).filter(Boolean);
}

// Areas where two renders differ, as fractions of the page, found on a coarse grid.
function diffRegions(ca, cb) {
  const w = Math.min(ca.width, cb.width);
  const h = Math.min(ca.height, cb.height);
  if (!w || !h) return [];
  const da = ca.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const db = cb.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const cell = 8;
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const marks = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (Math.abs(da[i] - db[i]) > 48 || Math.abs(da[i + 1] - db[i + 1]) > 48 || Math.abs(da[i + 2] - db[i + 2]) > 48) {
        marks[Math.floor(y / cell) * gw + Math.floor(x / cell)] = 1;
      }
    }
  }
  // Group marked cells that touch (with a 2-cell reach) into rectangles.
  const seen = new Uint8Array(gw * gh);
  const regions = [];
  for (let start = 0; start < marks.length; start++) {
    if (!marks[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    while (stack.length) {
      const c = stack.pop();
      const cx = c % gw;
      const cy = Math.floor(c / gw);
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const nc = ny * gw + nx;
          if (marks[nc] && !seen[nc]) { seen[nc] = 1; stack.push(nc); }
        }
      }
    }
    regions.push({ l: (x0 * cell) / w, t: (y0 * cell) / h, r: Math.min(1, ((x1 + 1) * cell) / w), b: Math.min(1, ((y1 + 1) * cell) / h) });
    if (regions.length > 60) break;
  }
  return regions;
}

async function comparePdfs(fileA, fileB, { includeUnchanged = false } = {}) {
  const open = async (file) => {
    const unlocked = await unlockBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    if (!unlocked) throw new CancelledError();
    return openPdfJs(unlocked.bytes);
  };
  const A = await open(fileA);
  const B = await open(fileB);
  const total = Math.max(A.numPages, B.numPages);
  const pagesOut = [];
  let added = 0;
  let removed = 0;
  try {
    for (let i = 0; i < total; i++) {
      progress(`Comparing page ${i + 1} of ${total}…`, (i + 1) / (total + 1));
      await checkpoint();
      const pa = i < A.numPages ? await A.getPage(i + 1) : null;
      const pb = i < B.numPages ? await B.getPage(i + 1) : null;
      const runs = diffWords(pa ? await pageWords(pa) : [], pb ? await pageWords(pb) : []);
      const plus = runs.filter((r) => r.op === '+').reduce((s, r) => s + r.words.length, 0);
      const minus = runs.filter((r) => r.op === '-').reduce((s, r) => s + r.words.length, 0);
      const ca = pa ? await renderPdfPage(pa, 1.1) : null;
      const cb = pb ? await renderPdfPage(pb, 1.1) : null;
      const regions = ca && cb ? diffRegions(ca, cb) : [];
      const changed = !pa || !pb || plus || minus || regions.length;
      added += plus;
      removed += minus;
      if (changed || includeUnchanged) {
        pagesOut.push({ i, ca, cb, runs, plus, minus, regions, onlyA: !pb, onlyB: !pa, changed });
      } else {
        if (ca) ca.width = 0;
        if (cb) cb.width = 0;
      }
    }
    progress('Writing the report…', null);
    const changedPages = pagesOut.filter((p) => p.changed);
    const bytes = await buildCompareReport(fileA.name, fileB.name, A.numPages, B.numPages, pagesOut, { added, removed });
    const title = changedPages.length ? 'Differences found' : 'No differences found';
    const detail = changedPages.length
      ? `${changedPages.length} of ${plural(total, 'page')} changed · ${plural(removed, 'word')} removed, ${added} added`
      : `The two documents look the same (${total} page${total === 1 ? '' : 's'} compared)`;
    return { bytes, title, detail };
  } finally {
    A.destroy();
    B.destroy();
  }
}

async function buildCompareReport(nameA, nameB, countA, countB, pagesOut, totals) {
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const fonts = new Map();
  const [W, H] = [841.89, 595.28];
  const regular = FONT_FAMILIES.sans.files.r;
  const bold = FONT_FAMILIES.sans.files.b;
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.39, 0.45, 0.55);
  const red = rgb(0.86, 0.15, 0.15);
  const green = rgb(0.09, 0.5, 0.24);
  const line = (page, text, x, y, size, color, file = regular) => drawTextLine(out, page, fonts, text, { x, y, size, color, file });
  const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

  // Summary page
  const cover = out.addPage([W, H]);
  await line(cover, 'Comparison report', 48, H - 70, 26, ink, bold);
  await line(cover, `Original: ${clip(nameA, 90)} (${countA} page${countA === 1 ? '' : 's'})`, 48, H - 104, 12, muted);
  await line(cover, `Changed: ${clip(nameB, 90)} (${countB} page${countB === 1 ? '' : 's'})`, 48, H - 122, 12, muted);
  await line(cover, `Created ${todayText()} with PDF Worker`, 48, H - 140, 12, muted);
  const changed = pagesOut.filter((p) => p.changed);
  await line(cover, changed.length ? `${plural(changed.length, 'page')} with differences · ${plural(totals.removed, 'word')} removed · ${plural(totals.added, 'word')} added` : 'No differences were found.', 48, H - 184, 15, ink, bold);
  let y = H - 214;
  for (const p of changed.slice(0, 22)) {
    const bits = [];
    if (p.onlyA) bits.push('page removed');
    else if (p.onlyB) bits.push('page added');
    else {
      if (p.minus) bits.push(`${plural(p.minus, 'word')} removed`);
      if (p.plus) bits.push(`${plural(p.plus, 'word')} added`);
      if (p.regions.length) bits.push(`${p.regions.length} changed area${p.regions.length === 1 ? '' : 's'}`);
    }
    await line(cover, `Page ${p.i + 1}: ${bits.join(', ')}`, 60, y, 12, ink);
    y -= 18;
  }
  if (changed.length > 22) await line(cover, `…and ${changed.length - 22} more pages`, 60, y, 12, muted);

  // One sheet per page: original | changed, with changed areas outlined.
  for (const [n, p] of pagesOut.entries()) {
    progress(`Writing the report… page ${n + 1} of ${pagesOut.length}`, (n + 1) / pagesOut.length);
    await checkpoint();
    const sheet = out.addPage([W, H]);
    const summary = p.onlyA ? 'Only in the original' : p.onlyB ? 'Only in the changed version' : p.changed ? `${plural(p.minus, 'word')} removed · ${plural(p.plus, 'word')} added · ${plural(p.regions.length, 'changed area')}` : 'No changes';
    await line(sheet, `Page ${p.i + 1}`, 36, H - 34, 15, ink, bold);
    await line(sheet, summary, 100, H - 34, 11, p.changed ? red : muted);
    const boxW = (W - 36 * 2 - 24) / 2;
    const boxH = H - 34 - 150;
    const panels = [[p.ca, 36, `Original`], [p.cb, 36 + boxW + 24, `Changed`]];
    for (const [canvas, x0, label] of panels) {
      await line(sheet, label, x0, H - 58, 10, muted, bold);
      if (!canvas) {
        await line(sheet, '(no page)', x0 + boxW / 2 - 24, H - 58 - boxH / 2, 11, muted);
        continue;
      }
      const s = Math.min(boxW / canvas.width, boxH / canvas.height);
      const w = canvas.width * s;
      const h = canvas.height * s;
      const x = x0 + (boxW - w) / 2;
      const top = H - 66;
      const image = await out.embedJpg(await canvasToJpeg(canvas, 0.8));
      sheet.drawImage(image, { x, y: top - h, width: w, height: h });
      sheet.drawRectangle({ x, y: top - h, width: w, height: h, borderColor: rgb(0.8, 0.83, 0.87), borderWidth: 0.6 });
      for (const r of p.regions) {
        sheet.drawRectangle({
          x: x + r.l * w, y: top - r.b * h, width: (r.r - r.l) * w, height: (r.b - r.t) * h,
          color: red, opacity: 0.12, borderColor: red, borderWidth: 1.2,
        });
      }
      canvas.width = canvas.height = 0;
    }
    // Text changes under the pictures.
    let ty = 104;
    const changes = p.runs.filter((r) => r.op !== '=');
    for (const r of changes.slice(0, 5)) {
      const text = clip(`${r.op === '-' ? '−' : '+'} ${r.words.join(' ')}`, 150);
      await line(sheet, text, 36, ty, 10, r.op === '-' ? red : green);
      ty -= 15;
    }
    if (changes.length > 5) await line(sheet, `…${changes.length - 5} more changes on this page`, 36, ty, 10, muted);
  }
  return out.save({ objectsPerTick: 200 });
}
