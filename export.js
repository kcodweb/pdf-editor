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
  const total = state.pages.length;
  for (const p of pages) {
    const page = p.src === null ? out.addPage([p.baseW, p.baseH]) : out.addPage(copiedFor.get(p));
    page.setRotation(degrees((p.rot0 + p.rot) % 360));
    const index = state.pages.indexOf(p);
    const decor = decorItems(p, index, total);
    const ocrText = state.ocr[ocrKey(p)] ? await readableText(p, { includePdfText: false }) : [];
    if (p.annots.length || decor.length || ocrText.length) isolatePageContent(out, page);
    if (p.annots.length) await drawAnnotations(out, page, p, fonts, images);
    if (decor.length) await drawDecor(out, page, p, decor, fonts);
    if (ocrText.length) {
      // Recognized text goes in as an invisible layer, making the scan searchable.
      const Bh = p.baseH;
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...pageFrame(page, p, p.rot0 % 360)));
      await drawHiddenText(out, page, ocrText, fonts, (it) => ({ x: it.x, y: Bh - it.baseline, angle: 0 }));
      page.pushOperators(popGraphicsState());
    }
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

/* ---------------- permanent removal ---------------- */

const SECURE_DPI = 200;

// Pages whose covered content must really be gone: always for redactions; with the privacy
// option, also for white-out and edited text.
const needsSecure = (p, all) => p.annots.some((a) => (a.type === 'rect' && (a.kind === 'redact' || (all && a.kind === 'whiteout')))
  || (all && a.type === 'text' && a.cover));

// Builds the PDF, then replaces pages that need it with an image of the finished page plus an
// invisible layer of the text that is still visible — so nothing hidden survives in the file.
async function buildFinalPdf(pages, opts = {}, ctx = createExportContext()) {
  const secure = pages.map((p, i) => (needsSecure(p, !!opts.secure) ? i : -1)).filter((i) => i >= 0);
  if (!secure.length) return buildPdf(pages, opts, ctx);

  // Form fields on replaced pages would point at deleted widgets, so answers are flattened first.
  const bytes = await buildPdf(pages, { ...opts, flatten: true, compress: 'none' }, ctx);
  const out = await PDFDocument.load(bytes);
  out.registerFontkit(fontkit);
  const rendered = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: `${PDFJS_CDN}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS_CDN}standard_fonts/` }).promise;
  const fonts = new Map();
  try {
    for (const i of secure) {
      $('hint').textContent = `Removing hidden content… page ${secure.indexOf(i) + 1} of ${secure.length}`;
      const p = pages[i];
      const page = await rendered.getPage(i + 1);
      const vp = page.getViewport({ scale: SECURE_DPI / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const c2d = canvas.getContext('2d');
      c2d.fillStyle = '#fff';
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      // 'print' intent renders without waiting for animation frames, so it also works in a background tab.
      await page.render({ canvasContext: c2d, viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      canvas.width = canvas.height = 0;
      const image = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));

      const { w, h } = pageDims(p);
      const flat = out.insertPage(i, [w, h]);
      flat.drawImage(image, { x: 0, y: 0, width: w, height: h });
      // Keep what's still visible searchable. Map base frame -> displayed page (y up).
      const m = rotMatrix(p.rot, p.baseW, p.baseH);
      const angle = (Math.atan2(-m[1], m[0]) * 180) / Math.PI;
      const items = await readableText(p);
      await drawHiddenText(out, flat, items, fonts, (it) => ({
        x: m[0] * it.x + m[2] * it.baseline + m[4],
        y: h - (m[1] * it.x + m[3] * it.baseline + m[5]),
        angle,
      }));
      out.removePage(i + 1);
    }
  } finally {
    rendered.destroy();
  }
  if (opts.compress && opts.compress !== 'none') await compressImages(out, opts.compress);
  return out.save();
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

/* ---------------- drawing helpers ---------------- */

// Wrap the original page content in q/Q so any graphics state it leaves behind can't skew our drawing.
function isolatePageContent(out, page) {
  try {
    const c = out.context;
    page.node.wrapContentStreams(
      c.register(c.contentStream([pushGraphicsState()])),
      c.register(c.contentStream([popGraphicsState()])),
    );
  } catch { /* draw without wrapping */ }
}

// Transform from a y-up frame of the page as displayed with `rotation` applied
// (origin bottom-left) to PDF user space. W/H: unrotated crop box size, x0/y0: its origin.
function frameMatrix(rotation, W, H, x0, y0) {
  return {
    0: [1, 0, 0, 1, x0, y0],
    90: [0, 1, -1, 0, W + x0, y0],
    180: [-1, 0, 0, -1, W + x0, H + y0],
    270: [0, -1, 1, 0, x0, H + y0],
  }[rotation];
}

function pageFrame(page, p, rotation) {
  const odd = p.rot0 % 180 !== 0;
  const W = odd ? p.baseH : p.baseW;
  const H = odd ? p.baseW : p.baseH;
  let x0 = 0;
  let y0 = 0;
  if (p.src !== null) {
    const box = page.getCropBox();
    x0 = box.x;
    y0 = box.y;
  }
  return frameMatrix(rotation, W, H, x0, y0);
}

function pdfFont(out, file, fonts) {
  if (!fonts.has(file)) {
    // fontkitFor() also applies the subsetting fix in fonts.js before pdf-lib subsets anything.
    fonts.set(file, fontkitFor(file).then(() => fetchFontBytes(file)).then((bytes) => out.embedFont(bytes, { subset: true })));
  }
  return fonts.get(file);
}

// Draws one line of text in any script, switching fonts per character run.
// x/y: baseline anchor (y up). align: left | center | right, measured along the text direction.
async function drawTextLine(out, page, fonts, text, o) {
  const runs = await splitRuns(text, o.file);
  const measured = [];
  let total = 0;
  for (const run of runs) {
    const font = await pdfFont(out, run.file, fonts);
    const width = font.widthOfTextAtSize(run.text, o.size);
    measured.push({ run, font, width });
    total += width;
  }
  const angle = ((o.angle || 0) * Math.PI) / 180;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const shift = o.align === 'center' ? total / 2 : o.align === 'right' ? total : 0;
  let x = o.x - ux * shift;
  let y = o.y - uy * shift;
  for (const { run, font, width } of measured) {
    const opts = { x, y, size: o.size, font, color: o.color };
    if (o.angle) opts.rotate = degrees(o.angle);
    if (o.opacity != null) opts.opacity = o.opacity;
    // Fallback script fonts have no italic face, so skew them like the browser does.
    if (o.italic && (o.synthItalic || run.file !== o.file)) opts.ySkew = degrees(12);
    page.drawText(run.text, opts);
    x += ux * width * (o.advanceScale || 1);
    y += uy * width * (o.advanceScale || 1);
  }
}

function dataUrlBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function roundedRectPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} `
    + `H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;
}

/* ---------------- annotations ---------------- */

async function drawAnnotations(out, page, p, fonts, images) {
  const m = pageFrame(page, p, p.rot0 % 360); // base frame: page with its own rotation
  const Bh = p.baseH;
  const notes = [];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));

  for (const a of p.annots) {
    if (a.type === 'text') {
      if (a.cover) {
        const c = a.cover;
        page.drawRectangle({ x: c.x, y: Bh - c.y - c.h, width: c.w, height: c.h, color: hexToRgb(c.fill) });
      }
      const orig = originalFontOnPage(page, a);
      const { file, synthItalic } = faceFile(effectiveFamily(a), a.bold, a.italic);
      const lines = a.text.replace(/\r/g, '').replace(/\t/g, '    ').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const y = Bh - (a.y + a.size * (0.8 + 1.2 * i));
        if (orig) {
          drawWithOriginalFont(page, orig, lines[i], a.x, y, a.size, a.color);
        } else {
          await drawTextLine(out, page, fonts, lines[i], {
            x: a.x, y, size: a.size, color: hexToRgb(a.color), file, italic: a.italic, synthItalic,
          });
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
        page.drawRectangle({ ...box, color: hexToRgb(a.fill || '#ffffff') });
      } else if (a.kind === 'redact') {
        page.drawRectangle({ ...box, color: rgb(0, 0, 0) });
      } else if (a.kind === 'ellipse') {
        page.drawEllipse({ x: a.x + a.w / 2, y: Bh - a.y - a.h / 2, xScale: a.w / 2, yScale: a.h / 2, borderColor: hexToRgb(a.color), borderWidth: a.width });
      } else {
        page.drawRectangle({ ...box, borderColor: hexToRgb(a.color), borderWidth: a.width });
      }
    } else if (a.type === 'line') {
      const geo = lineGeometry(a);
      page.drawLine({
        start: { x: a.x1, y: Bh - a.y1 }, end: { x: geo.end[0], y: Bh - geo.end[1] },
        thickness: a.width, color: hexToRgb(a.color), lineCap: LineCapStyle ? LineCapStyle.Round : undefined,
      });
      if (geo.head) {
        const [t, l, r] = geo.head;
        page.drawSvgPath(`M${t[0]} ${t[1]} L${l[0]} ${l[1]} L${r[0]} ${r[1]} Z`, { x: 0, y: Bh, color: hexToRgb(a.color) });
      }
    } else if (a.type === 'stamp') {
      const s = stampLayout(a);
      const color = hexToRgb(a.color);
      page.drawSvgPath(roundedRectPath(a.x + s.border / 2, a.y + s.border / 2, a.w - s.border, a.h - s.border, a.h * 0.14), {
        x: 0, y: Bh, borderColor: color, borderWidth: s.border, borderOpacity: 0.9,
      });
      const cx = a.x + a.w / 2;
      if (s.main) {
        await drawTextLine(out, page, fonts, s.main, { x: cx, y: Bh - s.mainBaseline, size: s.size, color, file: FONT_FAMILIES.sans.files.b, align: 'center', opacity: 0.9 });
      }
      if (s.two) {
        await drawTextLine(out, page, fonts, a.sub, { x: cx, y: Bh - s.subBaseline, size: s.subSize, color, file: FONT_FAMILIES.sans.files.r, align: 'center', opacity: 0.9 });
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
    } else if (a.type === 'note') {
      notes.push(a);
    }
  }
  page.pushOperators(popGraphicsState());
  for (const a of notes) addCommentAnnotation(out, page, a, m, Bh);
}

// The original font resource, if this exported page still has it and it can draw every character.
function originalFontOnPage(page, a) {
  const info = origFontState(a);
  if (!info) return null;
  const { PDFName, PDFDict } = PDFLib;
  const resources = page.node.Resources();
  const fonts = resources && resources.lookupMaybe(PDFName.of('Font'), PDFDict);
  return fonts && fonts.has(PDFName.of(info.res)) ? info : null;
}

// Writes text as the original font's character codes, so it looks exactly like the rest of the page.
function drawWithOriginalFont(page, info, text, x, y, size, color) {
  if (!text) return;
  const { PDFHexString, beginText, endText, setFontAndSize, setTextMatrix, showText, setFillingRgbColor } = PDFLib;
  const n = parseInt(color.slice(1), 16);
  const hex = [...text].map((ch) => info.codeFor.get(ch).toString(16).padStart(info.two ? 4 : 2, '0')).join('');
  page.pushOperators(
    pushGraphicsState(),
    setFillingRgbColor(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255),
    beginText(),
    setFontAndSize(info.res, size),
    setTextMatrix(1, 0, 0, 1, x, y),
    showText(PDFHexString.of(hex)),
    endText(),
    popGraphicsState(),
  );
}

// Invisible text (rendering mode 3) stretched over where words appear, so pages stay
// searchable and copyable: used for OCR results and for pages converted to images.
// `place` maps a base-frame item to { x, y, angle } in the current drawing frame (y up).
async function drawHiddenText(out, page, items, fonts, place) {
  const { PDFOperator, PDFNumber } = PDFLib;
  const file = FONT_FAMILIES.sans.files.r;
  for (const it of items) {
    let natural = 0;
    for (const run of await splitRuns(it.text, file)) {
      natural += (await pdfFont(out, run.file, fonts)).widthOfTextAtSize(run.text, it.size);
    }
    if (natural <= 0 || it.w <= 0) continue;
    const stretch = it.w / natural;
    const { x, y, angle } = place(it);
    page.pushOperators(
      pushGraphicsState(),
      PDFOperator.of('Tr', [PDFNumber.of(3)]),
      PDFOperator.of('Tz', [PDFNumber.of(Math.round(stretch * 10000) / 100)]),
    );
    await drawTextLine(out, page, fonts, it.text, { x, y, size: it.size, color: rgb(0, 0, 0), file, angle, advanceScale: stretch });
    page.pushOperators(popGraphicsState());
  }
}

// Comments become real PDF "sticky note" annotations that other viewers show as pop-ups.
function addCommentAnnotation(out, page, a, m, Bh) {
  const { PDFHexString, PDFString, rectangle, fillAndStroke, setFillingRgbColor, setStrokingRgbColor, setLineWidth, moveTo, lineTo, stroke } = PDFLib;
  const toPdf = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const corners = [toPdf(a.x, Bh - a.y), toPdf(a.x + NOTE_SIZE, Bh - a.y - NOTE_SIZE)];
  const rect = [
    Math.min(corners[0][0], corners[1][0]), Math.min(corners[0][1], corners[1][1]),
    Math.max(corners[0][0], corners[1][0]), Math.max(corners[0][1], corners[1][1]),
  ];
  const n = parseInt(a.color.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const s = NOTE_SIZE;
  const appearance = out.context.formXObject([
    setFillingRgbColor(r, g, b), setStrokingRgbColor(0.35, 0.35, 0.35), setLineWidth(1),
    rectangle(0.5, 0.5, s - 1, s - 1), fillAndStroke(),
    setStrokingRgbColor(0.3, 0.3, 0.3),
    moveTo(s * 0.22, s * 0.68), lineTo(s * 0.78, s * 0.68),
    moveTo(s * 0.22, s * 0.5), lineTo(s * 0.78, s * 0.5),
    moveTo(s * 0.22, s * 0.32), lineTo(s * 0.6, s * 0.32), stroke(),
  ], { BBox: [0, 0, s, s] });
  const dict = out.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: rect,
    Contents: PDFHexString.fromText(a.text),
    T: PDFHexString.fromText('PDF Editor'),
    M: PDFString.fromDate(new Date()),
    Name: 'Comment',
    C: [r, g, b],
    F: 4 | 8 | 16, // print, no zoom, no rotate
    Open: false,
    AP: { N: out.context.register(appearance) },
  });
  page.node.addAnnot(out.context.register(dict));
}

/* ---------------- page numbers, headers, watermark ---------------- */

async function drawDecor(out, page, p, items, fonts) {
  const m = pageFrame(page, p, (p.rot0 + p.rot) % 360); // displayed frame
  const Dh = pageDims(p).h;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
  for (const it of items) {
    const angle = ((it.angle || 0) * Math.PI) / 180;
    let x = it.x;
    let y = Dh - it.y;
    if (it.middle) {
      // Vertically center the text on its anchor, measured along the text's up direction.
      x += Math.sin(angle) * it.size * 0.35;
      y -= Math.cos(angle) * it.size * 0.35;
    }
    await drawTextLine(out, page, fonts, it.text, {
      x, y, size: it.size, color: hexToRgb(it.color), align: it.align, angle: it.angle, opacity: it.opacity,
      file: it.bold ? FONT_FAMILIES.sans.files.b : FONT_FAMILIES.sans.files.r,
    });
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
    const bytes = await buildFinalPdf(pages, { ...opts, warnings });
    saveBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
    if (pages === state.pages) dirty = false;
    let msg = `Downloaded ${filename} (${formatBytes(bytes.length)})`;
    const secured = pages.filter((p) => needsSecure(p, !!opts.secure)).length;
    if (secured) msg += ` — hidden content was permanently removed from ${secured} page${secured === 1 ? '' : 's'}`;
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
  const hasCovers = state.pages.some((p) => needsSecure(p, true));
  const hasRedactions = state.pages.some((p) => needsSecure(p, false));
  $('dlSecureSet').hidden = !hasCovers;
  $('dlSecure').disabled = hasRedactions;
  if (hasRedactions) $('dlSecure').checked = true;
  $('dlSecureLabel').innerHTML = hasRedactions
    ? '<b>Permanently remove covered text</b> — always on because this document has redactions. Pages with redactions (and, when on, white-out or edited text) become images, so hidden words can\'t be recovered. Other text on them stays searchable.'
    : '<b>Permanently remove covered text</b> — pages with white-out or edited text become images, so the hidden words can\'t be copied or recovered. Their other text stays searchable.';
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
      const bytes = await buildFinalPdf(parts[i].map((idx) => state.pages[idx]), {}, ctx);
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

/* ---------------- pages as images ---------------- */

function openImageExportDialog() {
  if (!state.pages.length) return;
  finishEdit();
  const picked = state.pageSel.size;
  $('imgCurrentLabel').textContent = `Current page (${state.current + 1})`;
  $('imgSelectedLabel').textContent = picked ? `Selected pages (${picked})` : 'Selected pages (none selected)';
  $('imgSelectedRadio').disabled = !picked;
  $('imgAllLabel').textContent = `All pages (${state.pages.length})`;
  if (picked) $('imgSelectedRadio').checked = true;
  else if ($('imgSelectedRadio').checked) document.querySelector('input[name=imgPages][value=current]').checked = true;
  openModal('imgModal');
}

async function runImageExport(pages, format, dpi) {
  if (!pages.length || document.body.classList.contains('busy')) return;
  finishEdit();
  busy(true, 'Rendering images…');
  let doc = null;
  try {
    // Render the finished PDF so the images include every edit, form answer and page number.
    const bytes = await buildPdf(pages, { flatten: true });
    doc = await pdfjsLib.getDocument({ data: bytes, cMapUrl: `${PDFJS_CDN}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS_CDN}standard_fonts/` }).promise;
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const digits = String(state.pages.length).length;
    const files = [];
    for (let i = 0; i < pages.length; i++) {
      $('hint').textContent = `Rendering page ${i + 1} of ${pages.length}…`;
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, `image/${format}`, 0.92));
      const n = String(state.pages.indexOf(pages[i]) + 1).padStart(digits, '0');
      files.push({ name: `${state.fileName}-page-${n}.${ext}`, blob });
      canvas.width = canvas.height = 0;
    }
    if (files.length === 1) {
      saveBlob(files[0].blob, files[0].name);
      toast(`Downloaded ${files[0].name}`);
    } else {
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f.blob));
      const name = `${state.fileName}-images.zip`;
      saveBlob(await zip.generateAsync({ type: 'blob' }), name);
      toast(`Downloaded ${files.length} images as ${name}`);
    }
  } catch (err) {
    console.error(err);
    toast(`Couldn't create the images: ${err.message}`);
  } finally {
    if (doc) doc.destroy();
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
      secure: $('dlSecure').checked,
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

  $('imgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const which = document.querySelector('input[name=imgPages]:checked').value;
    const pages = which === 'all' ? state.pages
      : which === 'selected' ? state.pages.filter((p) => state.pageSel.has(p.id))
        : [state.pages[state.current]].filter(Boolean);
    closeModal('imgModal');
    runImageExport(pages, document.querySelector('input[name=imgFormat]:checked').value, Number(document.querySelector('input[name=imgDpi]:checked').value));
  });
}
