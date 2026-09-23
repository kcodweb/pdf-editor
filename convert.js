'use strict';

// Conversions between PDF and other formats, done entirely in the browser.
//   Word -> PDF:  docx-preview lays the document out as HTML, each page is rendered to an image
//                 and the words are laid over it as invisible text, so the PDF stays searchable.
//   PDF -> Word:  text lines (or OCR results) are regrouped into paragraphs and written with docx.
//   PDF -> Text:  the same paragraphs as plain text.

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(`Couldn't load ${src.split('/').pop()}`)); };
    document.head.appendChild(s);
  });
}

// Both libraries install a global named "docx", so each is captured right after it loads.
let docxWriterLoading = null;
let docxPreviewLoading = null;
function loadDocxWriter() {
  if (!docxWriterLoading) {
    docxWriterLoading = (async () => {
      const previous = window.docx;
      await loadScript('vendor/docx.iife.js');
      const lib = window.docx;
      window.docx = previous;
      return lib;
    })().catch((err) => { docxWriterLoading = null; throw err; });
  }
  return docxWriterLoading;
}
function loadDocxPreview() {
  if (!docxPreviewLoading) {
    docxPreviewLoading = (async () => {
      const previous = window.docx;
      await loadScript('vendor/docx-preview.min.js');
      const lib = window.docx;
      window.docx = previous;
      return lib;
    })().catch((err) => { docxPreviewLoading = null; throw err; });
  }
  return docxPreviewLoading;
}

/* ---------------- PDF -> paragraphs ---------------- */

// Groups a page's lines into paragraphs: same size, close together, similar left edge.
function paragraphsFromLines(lines, pageWidth) {
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const paragraphs = [];
  let cur = null;
  for (const line of sorted) {
    const prev = cur && cur.lines[cur.lines.length - 1];
    const continues = prev
      && Math.abs(line.size - prev.size) < prev.size * 0.15
      && line.baseline - prev.baseline > 0
      && line.baseline - prev.baseline < prev.size * 1.75
      && Math.abs(line.x - cur.lines[0].x) < prev.size * 2.5;
    if (continues) cur.lines.push(line);
    else {
      cur = { lines: [line] };
      paragraphs.push(cur);
    }
  }
  for (const para of paragraphs) {
    let text = '';
    for (const line of para.lines) {
      const t = line.text.trim();
      if (!text) text = t;
      else if (/[A-Za-z]-$/.test(text)) text = text.slice(0, -1) + t; // re-join hyphenated words
      else text += ` ${t}`;
    }
    para.text = text;
    para.size = para.lines[0].size;
    const first = para.lines[0];
    const center = first.x + first.w / 2;
    para.centered = para.lines.length <= 2 && first.w < pageWidth * 0.7 && Math.abs(center - pageWidth / 2) < pageWidth * 0.06;
  }
  return paragraphs;
}

async function lineStylesFor(p, lines) {
  const styles = new Map();
  if (p.src === null) return styles;
  try {
    const page = await state.sources[p.src].pdf.getPage(p.index + 1);
    await page.getOperatorList(); // makes font details available
    for (const line of lines) {
      if (line.ocr || !page.commonObjs.has(line.fontName)) continue;
      const f = page.commonObjs.get(line.fontName);
      const n = f.name || '';
      styles.set(line, {
        bold: !!(f.bold || f.black) || /bold|black|heavy|semibold/i.test(n),
        italic: !!f.italic || /italic|oblique/i.test(n),
        family: matchFontFamily(n, line.generic),
      });
    }
  } catch { /* plain styling */ }
  return styles;
}

const WORD_FONTS = { arial: 'Arial', times: 'Times New Roman', courier: 'Courier New', calibri: 'Calibri', cambria: 'Cambria', serif: 'Georgia', mono: 'Consolas', sans: 'Arial' };

async function pdfToDocx(pages, { imagesForEmptyPages = true } = {}) {
  const D = await loadDocxWriter();
  const children = [];
  const emptyPages = [];
  for (let i = 0; i < pages.length; i++) {
    progress(`Converting page ${i + 1} of ${pages.length}…`, (i + 1) / pages.length);
    await checkpoint();
    const p = pages[i];
    const { w } = pageDims(p);
    const lines = await getLines(p);
    const pageBreak = i > 0;
    if (!lines.length) {
      emptyPages.push({ p, index: children.length, pageBreak });
      children.push(null); // filled with an image below
      continue;
    }
    const styles = await lineStylesFor(p, lines);
    const paragraphs = paragraphsFromLines(lines, w);
    // Body text size = the size used by the most characters on the page.
    const chars = new Map();
    for (const q of paragraphs) chars.set(Math.round(q.size), (chars.get(Math.round(q.size)) || 0) + q.text.length);
    const body = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
    paragraphs.forEach((para, k) => {
      const style = styles.get(para.lines[0]) || {};
      const ratio = para.size / body;
      const heading = ratio >= 1.6 ? D.HeadingLevel.HEADING_1 : ratio >= 1.25 ? D.HeadingLevel.HEADING_2 : undefined;
      children.push(new D.Paragraph({
        heading,
        pageBreakBefore: pageBreak && k === 0,
        alignment: para.centered ? D.AlignmentType.CENTER : undefined,
        spacing: { after: Math.round(Math.min(para.size, 14) * 8) },
        children: [new D.TextRun({
          text: para.text,
          size: Math.max(2, Math.round(para.size * 2)),
          bold: style.bold || undefined,
          italics: style.italic || undefined,
          font: WORD_FONTS[style.family] || 'Arial',
          color: heading ? '000000' : undefined,
        })],
      }));
    });
  }
  // Pages with no text (images, drawings) come across as pictures.
  if (emptyPages.length && imagesForEmptyPages) {
    const images = await renderPagesToImages(emptyPages.map((e) => e.p), 'png', 110);
    emptyPages.forEach((e, k) => {
      const { w, h } = pageDims(e.p);
      const width = 600; // pixels at 96 DPI ≈ printable width
      children[e.index] = { image: images[k].blob, width, height: Math.round((width * h) / w), pageBreak: e.pageBreak };
    });
  }
  const finalChildren = [];
  for (const child of children) {
    if (!child) continue;
    if (child.image) {
      finalChildren.push(new D.Paragraph({
        pageBreakBefore: child.pageBreak,
        children: [new D.ImageRun({ type: 'png', data: await child.image.arrayBuffer(), transformation: { width: child.width, height: child.height } })],
      }));
    } else {
      finalChildren.push(child);
    }
  }
  if (!finalChildren.length) finalChildren.push(new D.Paragraph(''));
  const first = pageDims(pages[0]);
  const doc = new D.Document({
    creator: 'PDF Worker',
    sections: [{
      properties: {
        page: {
          size: { width: Math.round(first.w * 20), height: Math.round(first.h * 20) },
          margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
        },
      },
      children: finalChildren,
    }],
  });
  return D.Packer.toBlob(doc);
}

async function pdfToText(pages) {
  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    progress(`Reading page ${i + 1} of ${pages.length}…`, (i + 1) / pages.length);
    await checkpoint();
    const p = pages[i];
    const paragraphs = paragraphsFromLines(await getLines(p), pageDims(p).w);
    parts.push(paragraphs.map((q) => q.text).join('\n\n'));
  }
  return new Blob([parts.join('\n\n\f\n\n')], { type: 'text/plain;charset=utf-8' });
}

/* ---------------- Word -> PDF ---------------- */

const PX_TO_PT = 0.75; // CSS pixels are 1/96 inch, PDF points 1/72

// docx-preview only starts a new page at explicit page breaks, so long sections are split
// here by moving overflowing blocks into a copy of the page.
function paginateSection(section) {
  const pages = [section];
  const style = getComputedStyle(section);
  // Computed styles are always in pixels (docx-preview writes sizes in points).
  const pageHeight = parseFloat(style.minHeight) || parseFloat(style.height) || section.offsetWidth * 1.414;
  const padBottom = parseFloat(style.paddingBottom) || 0;
  let page = section;
  for (let guard = 0; guard < 500; guard++) {
    page.style.position = 'relative';
    const article = page.querySelector(':scope > article') || page;
    const limit = pageHeight - padBottom;
    const blocks = [...article.children];
    const overflowAt = blocks.findIndex((b, i) => i > 0 && b.offsetTop + b.offsetHeight > limit);
    if (overflowAt === -1) break;
    const next = page.cloneNode(false);
    const nextArticle = article === page ? next : article.cloneNode(false);
    if (article !== page) {
      // Carry headers/footers along to the new page.
      for (const extra of page.querySelectorAll(':scope > header, :scope > footer')) next.appendChild(extra.cloneNode(true));
      next.appendChild(nextArticle);
    }
    blocks.slice(overflowAt).forEach((b) => nextArticle.appendChild(b));
    page.after(next);
    pages.push(next);
    page = next;
  }
  return pages;
}

async function inlineImages(root) {
  for (const img of root.querySelectorAll('img')) {
    if (img.src.startsWith('data:')) continue;
    try {
      const blob = await (await fetch(img.src)).blob();
      img.src = await readAsDataURL(blob);
    } catch { img.remove(); }
  }
}

// Renders one laid-out page to a canvas via an SVG foreignObject.
async function rasterizeHtmlPage(page, css, scale) {
  const w = page.offsetWidth;
  const h = page.offsetHeight;
  const xhtml = new XMLSerializer().serializeToString(page);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}">`
    + `<foreignObject x="0" y="0" width="${w}" height="${h}" transform="scale(${scale})">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden;background:#fff">`
    + `<style>${css.replace(/<\/style/gi, '')}</style>${xhtml}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return canvas;
}

// Word-level positions of every piece of text on a page, in points from the page's top-left.
function htmlTextItems(page) {
  const origin = page.getBoundingClientRect();
  const items = [];
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent;
    if (!text.trim()) continue;
    const size = parseFloat(getComputedStyle(node.parentElement).fontSize) || 16;
    let line = null;
    const flush = () => { if (line && line.text.trim()) items.push(line); line = null; };
    for (const match of text.matchAll(/\S+\s*/g)) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].trimEnd().length);
      const r = range.getBoundingClientRect();
      if (!r.width) continue;
      const x = (r.left - origin.left) * PX_TO_PT;
      const baseline = (r.bottom - origin.top - r.height * 0.22) * PX_TO_PT;
      if (line && Math.abs(line.baseline - baseline) < 2) {
        line.text += (line.text.endsWith(' ') ? '' : ' ') + match[0].trim();
        line.w = x + r.width * PX_TO_PT - line.x;
      } else {
        flush();
        line = { text: match[0].trim(), x, baseline, w: r.width * PX_TO_PT, size: size * PX_TO_PT };
      }
    }
    flush();
  }
  return items;
}

async function docxToPdf(file) {
  const preview = await loadDocxPreview();
  const host = document.createElement('div');
  host.className = 'docx-render-host';
  document.body.appendChild(host);
  try {
    progress('Reading the document…', null);
    await preview.renderAsync(file, host, host, {
      inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false,
      renderHeaders: true, renderFooters: true, useBase64URL: true, experimental: true,
    });
    await inlineImages(host);
    const css = [...host.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const pages = [...host.querySelectorAll('section.docx')].flatMap(paginateSection);
    if (!pages.length) throw new Error("This file doesn't contain any pages.");

    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const fonts = new Map();
    for (let i = 0; i < pages.length; i++) {
      progress(`Converting page ${i + 1} of ${pages.length}…`, (i + 1) / pages.length);
      await checkpoint();
      const page = pages[i];
      const wPt = page.offsetWidth * PX_TO_PT;
      const hPt = page.offsetHeight * PX_TO_PT;
      const items = htmlTextItems(page);
      const canvas = await rasterizeHtmlPage(page, css, 2.2);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      canvas.width = canvas.height = 0;
      const image = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      const pdfPage = out.addPage([wPt, hPt]);
      pdfPage.drawImage(image, { x: 0, y: 0, width: wPt, height: hPt });
      await drawHiddenText(out, pdfPage, items, fonts, (it) => ({ x: it.x, y: hPt - it.baseline, angle: 0 }));
    }
    return out.save();
  } finally {
    host.remove();
  }
}
