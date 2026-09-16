'use strict';

/* ---------------- building the PDF ---------------- */

// Shared across several builds (e.g. split parts) so each source file is parsed once.
function createExportContext() {
  return { srcDocs: new Map() };
}

function loadSourceDoc(ctx, src) {
  if (!ctx.srcDocs.has(src)) {
    ctx.srcDocs.set(src, (async () => {
      const doc = await PDFDocument.load(state.sources[src].bytes, { ignoreEncryption: true });
      doc.registerFontkit(fontkit);
      await applyFormValues(doc, src);
      detachWidgetPages(doc);
      return doc;
    })());
  }
  return ctx.srcDocs.get(src);
}

async function buildPdf(pages, opts = {}, ctx = createExportContext()) {
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const fonts = new Map();
  const images = new Map();

  // Copy pages with one copyPages call per source so shared resources stay shared.
  // A page used twice (duplicated) must come from a separate call, or both would be the same object.
  const copiedFor = new Map();
  const bySource = new Map();
  for (const p of pages) {
    if (p.src === null) continue;
    if (!bySource.has(p.src)) bySource.set(p.src, []);
    bySource.get(p.src).push(p);
  }
  let formSource = null;
  for (const [src, list] of bySource) {
    const doc = await loadSourceDoc(ctx, src);
    let remaining = list;
    while (remaining.length) {
      const batch = [];
      const later = [];
      const used = new Set();
      for (const p of remaining) {
        if (used.has(p.index)) later.push(p);
        else { used.add(p.index); batch.push(p); }
      }
      const copied = await out.copyPages(doc, batch.map((p) => p.index));
      batch.forEach((p, i) => copiedFor.set(p, copied[i]));
      remaining = later;
    }
    if (state.sources[src].hasForm && !formSource) formSource = doc;
  }

  const added = [];
  for (const p of pages) {
    const page = p.src === null ? out.addPage([p.baseW, p.baseH]) : out.addPage(copiedFor.get(p));
    page.setRotation(degrees((p.rot0 + p.rot) % 360));
    if (p.annots.length) await drawAnnotations(out, page, p, fonts, images);
    added.push(page);
  }

  if (formSource) {
    registerFormFields(out, added, formSource);
    if (opts.flatten) {
      try {
        out.getForm().flatten({ updateFieldAppearances: false });
        // flatten() deletes widget objects but can leave their entries in page /Annots.
        for (const page of added) {
          const annots = page.node.Annots();
          if (!annots) continue;
          for (let i = annots.size() - 1; i >= 0; i--) {
            const ref = annots.get(i);
            if (ref instanceof PDFLib.PDFRef && !out.context.lookup(ref)) annots.remove(i);
          }
        }
      } catch (err) {
        console.warn(err);
        opts.warnings?.push("some form fields couldn't be flattened");
      }
    }
  }
  if (opts.compress && opts.compress !== 'none') await compressImages(out, opts.compress);
  return out.save({ updateFieldAppearances: false });
}

const isWidget = (dict) => dict instanceof PDFLib.PDFDict
  && String(dict.get(PDFLib.PDFName.of('Subtype'))) === '/Widget';

// A widget's optional /P link to its page would make copyPages drag along copies of
// pages that aren't being exported (a field's other widgets can live on other pages).
function detachWidgetPages(doc) {
  const P = PDFLib.PDFName.of('P');
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (isWidget(annot)) annot.delete(P);
    }
  }
}

// copyPages brings widget annotations along, but the new document's form doesn't know about
// their fields until they're listed in its AcroForm.
function registerFormFields(out, pages, srcDoc) {
  const { PDFName, PDFDict, PDFRef, PDFArray, PDFObjectCopier } = PDFLib;
  const acro = out.getForm().acroForm;
  const onPage = new Set();
  const roots = new Map();
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      let ref = annots.get(i);
      if (!(ref instanceof PDFRef) || !isWidget(out.context.lookup(ref))) continue;
      onPage.add(ref.toString());
      let dict = out.context.lookup(ref);
      for (let depth = 0; depth < 32; depth++) {
        const parent = dict.get(PDFName.of('Parent'));
        if (!(parent instanceof PDFRef)) break;
        ref = parent;
        dict = out.context.lookup(parent);
      }
      roots.set(ref.toString(), ref);
    }
  }

  // Drop widgets belonging to pages that weren't exported, so no field points at missing objects.
  const prune = (dict) => {
    const kids = dict.lookup(PDFName.of('Kids'));
    if (!(kids instanceof PDFArray)) return;
    for (let i = kids.size() - 1; i >= 0; i--) {
      const kidRef = kids.get(i);
      const kid = out.context.lookup(kidRef);
      if (isWidget(kid) && !(kidRef instanceof PDFRef && onPage.has(kidRef.toString()))) kids.remove(i);
      else if (kid instanceof PDFDict) prune(kid);
    }
  };
  for (const ref of roots.values()) {
    prune(out.context.lookup(ref));
    acro.addField(ref);
  }
  // Default appearance and resources, needed by viewers to draw edited values.
  const srcAcro = srcDoc.catalog.getAcroForm();
  if (srcAcro) {
    const copier = PDFObjectCopier.for(srcDoc.context, out.context);
    for (const k of ['DA', 'DR']) {
      const v = srcAcro.dict.get(PDFName.of(k));
      if (v && !acro.dict.has(PDFName.of(k))) acro.dict.set(PDFName.of(k), copier.copy(v));
    }
  }
}

function pdfFont(out, file, fonts) {
  if (!fonts.has(file)) {
    // fontkitFor() also applies the subsetting fix in fonts.js before pdf-lib subsets anything.
    fonts.set(file, fontkitFor(file).then(() => fetchFontBytes(file)).then((bytes) => out.embedFont(bytes, { subset: true })));
  }
  return fonts.get(file);
}

function dataUrlBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function drawAnnotations(out, page, p, fonts, images) {
  // Isolate the original content so any graphics state it leaves behind can't skew our drawing.
  try {
    const c = out.context;
    page.node.wrapContentStreams(
      c.register(c.contentStream([pushGraphicsState()])),
      c.register(c.contentStream([popGraphicsState()])),
    );
  } catch { /* draw without wrapping */ }

  // Transform so annotations can be drawn in the base frame with y up (baseW x baseH).
  const r0 = p.rot0 % 360;
  const W = r0 % 180 ? p.baseH : p.baseW; // unrotated page size
  const H = r0 % 180 ? p.baseW : p.baseH;
  let x0 = 0;
  let y0 = 0;
  if (p.src !== null) {
    const box = page.getCropBox();
    x0 = box.x;
    y0 = box.y;
  }
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
      const { file, synthItalic } = faceFile(a.font, a.bold, a.italic);
      const lines = a.text.replace(/\r/g, '').replace(/\t/g, '    ').split('\n');
      for (let i = 0; i < lines.length; i++) {
        let x = a.x;
        const y = Bh - (a.y + a.size * (0.8 + 1.2 * i));
        for (const run of await splitRuns(lines[i], file)) {
          const font = await pdfFont(out, run.file, fonts);
          const opts = { x, y, size: a.size, font, color: hexToRgb(a.color) };
          // Fallback script fonts have no italic face, so skew them like the browser does.
          if (synthItalic || (a.italic && run.file !== file)) opts.ySkew = degrees(12);
          page.drawText(run.text, opts);
          x += font.widthOfTextAtSize(run.text, a.size);
        }
      }
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
      let img = images.get(a.imageId);
      if (!img) {
        const im = state.images[a.imageId];
        const bytes = dataUrlBytes(im.dataUrl);
        img = im.kind === 'jpg' ? await out.embedJpg(bytes) : await out.embedPng(bytes);
        images.set(a.imageId, img);
      }
      page.drawImage(img, { x: a.x, y: Bh - a.y - a.h, width: a.w, height: a.h });
    }
  }
  page.pushOperators(popGraphicsState());
}

/* ---------------- compression ---------------- */

// Re-encodes large JPEG photos at a lower resolution/quality. Text and vector content is untouched.
async function compressImages(out, level) {
  const { PDFName, PDFArray, PDFRawStream, PDFNumber } = PDFLib;
  const { maxDim, quality } = level === 'strong' ? { maxDim: 1200, quality: 0.55 } : { maxDim: 2000, quality: 0.75 };
  const name = (n) => PDFName.of(n);

  for (const [ref, obj] of [...out.context.enumerateIndirectObjects()]) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (String(dict.get(name('Subtype'))) !== '/Image') continue;
    const filter = dict.lookup(name('Filter'));
    const filterName = filter instanceof PDFArray ? (filter.size() === 1 ? String(filter.get(0)) : '') : String(filter);
    if (filterName !== '/DCTDecode' || dict.has(name('Decode')) || dict.has(name('ImageMask'))) continue;
    const cs = dict.lookup(name('ColorSpace'));
    const csName = cs instanceof PDFArray ? String(cs.get(0)) : String(cs);
    if (!['/DeviceRGB', '/DeviceGray', '/ICCBased', '/CalRGB', '/CalGray'].includes(csName)) continue;
    if (csName === '/ICCBased') {
      const icc = cs.lookup(1);
      const n = icc && icc.dict && icc.dict.lookup(name('N'));
      if (n && n.asNumber() === 4) continue; // CMYK
    }
    if (obj.contents.length < 50000) continue;

    try {
      const bitmap = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length > obj.contents.length * 0.9) continue;

      const nd = dict.clone(out.context);
      nd.set(name('Width'), PDFNumber.of(canvas.width));
      nd.set(name('Height'), PDFNumber.of(canvas.height));
      nd.set(name('ColorSpace'), name('DeviceRGB'));
      nd.set(name('BitsPerComponent'), PDFNumber.of(8));
      nd.set(name('Filter'), name('DCTDecode'));
      nd.delete(name('DecodeParms'));
      out.context.assign(ref, PDFRawStream.of(nd, bytes));
    } catch (err) {
      console.warn('Skipped an image while compressing', err);
    }
  }
}

/* ---------------- downloads ---------------- */

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const safeName = (name) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'document';

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function runDownload(pages, filename, opts = {}) {
  if (!pages.length || document.body.classList.contains('busy')) return;
  finishEdit();
  busy(true, 'Building PDF…');
  try {
    const warnings = [];
    const bytes = await buildPdf(pages, { ...opts, warnings });
    saveBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
    if (pages === state.pages) dirty = false;
    let msg = `Downloaded ${filename} (${formatBytes(bytes.length)})`;
    if (opts.compress && opts.compress !== 'none') {
      const original = state.sources.reduce((sum, s) => sum + s.bytes.length, 0);
      if (original) msg += ` — originals were ${formatBytes(original)}`;
    }
    if (warnings.length) msg += `. Note: ${warnings.join(', ')}.`;
    toast(msg);
  } catch (err) {
    console.error(err);
    toast(`Couldn't build the PDF: ${err.message}`);
  } finally {
    busy(false);
  }
}

function openDownloadDialog() {
  if (!state.pages.length) return;
  finishEdit();
  $('dlName').value = `${state.fileName}-edited`;
  $('dlFormsSet').hidden = !state.sources.some((s) => s.hasForm);
  openModal('dlModal');
  $('dlName').select();
}

// Short label for a set of page indices: "3", "1-4" or "1,3,8".
function pagesLabel(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  if (sorted.length === 1) return `${sorted[0] + 1}`;
  if (contiguous) return `${sorted[0] + 1}-${sorted[sorted.length - 1] + 1}`;
  const list = sorted.map((i) => i + 1).join(',');
  return list.length > 30 ? `${sorted.length}-pages` : list;
}

function extractPages(ids) {
  const indices = ids.map((id) => state.pages.findIndex((p) => p.id === id)).filter((i) => i >= 0);
  if (!indices.length) return;
  indices.sort((a, b) => a - b);
  runDownload(indices.map((i) => state.pages[i]), `${state.fileName}-page${indices.length > 1 ? 's' : ''}-${pagesLabel(indices)}.pdf`);
}

// "1-3, 5, 7-9" -> [[0,1,2],[4],[6,7,8]]; throws with a readable message.
function parseRanges(text, total) {
  const parts = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Enter at least one page range.');
  return parts.map((part) => {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) throw new Error(`"${part}" isn't a page or range.`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > total || a > b) throw new Error(`"${part}" is outside pages 1–${total}.`);
    return Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i);
  });
}

function splitParts() {
  const total = state.pages.length;
  const mode = document.querySelector('input[name=splitMode]:checked').value;
  if (mode === 'ranges') return parseRanges($('splitRanges').value, total);
  const every = Math.max(1, Math.floor(Number($('splitEvery').value) || 1));
  const parts = [];
  for (let i = 0; i < total; i += every) parts.push(Array.from({ length: Math.min(every, total - i) }, (_, k) => i + k));
  return parts;
}

function updateSplitPreview() {
  const el = $('splitPreview');
  try {
    const parts = splitParts();
    el.textContent = `Creates ${parts.length} PDF${parts.length === 1 ? '' : 's'}.`;
    el.classList.remove('error');
  } catch (err) {
    el.textContent = err.message;
    el.classList.add('error');
  }
}

function openSplitDialog() {
  if (!state.pages.length) return;
  finishEdit();
  openModal('splitModal');
  updateSplitPreview();
}

async function runSplit(parts) {
  finishEdit();
  busy(true, 'Splitting…');
  try {
    const zip = new JSZip();
    const ctx = createExportContext();
    for (let i = 0; i < parts.length; i++) {
      $('hint').textContent = `Splitting… part ${i + 1} of ${parts.length}`;
      const bytes = await buildPdf(parts[i].map((idx) => state.pages[idx]), {}, ctx);
      zip.file(`${String(i + 1).padStart(2, '0')}-${state.fileName}-p${pagesLabel(parts[i])}.pdf`, bytes);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    saveBlob(blob, `${state.fileName}-split.zip`);
    toast(`Downloaded ${parts.length} PDFs as ${state.fileName}-split.zip`);
  } catch (err) {
    console.error(err);
    toast(`Couldn't split the PDF: ${err.message}`);
  } finally {
    busy(false);
  }
}

function initExportDialogs() {
  $('dlForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = safeName($('dlName').value.replace(/\.pdf$/i, ''));
    closeModal('dlModal');
    runDownload(state.pages, `${name}.pdf`, {
      flatten: document.querySelector('input[name=dlForms]:checked').value === 'flatten',
      compress: document.querySelector('input[name=dlCompress]:checked').value,
    });
  });

  $('splitForm').addEventListener('input', (e) => {
    if (e.target.id === 'splitRanges') document.querySelector('input[name=splitMode][value=ranges]').checked = true;
    if (e.target.id === 'splitEvery') document.querySelector('input[name=splitMode][value=every]').checked = true;
    updateSplitPreview();
  });
  $('splitForm').addEventListener('submit', (e) => {
    e.preventDefault();
    let parts;
    try { parts = splitParts(); } catch { updateSplitPreview(); return; }
    closeModal('splitModal');
    runSplit(parts);
  });
}
