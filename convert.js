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
    para.centered = para.lines.length <= 2 && para.lines.every((l) => l.w < pageWidth * 0.7
      && Math.abs(l.x + l.w / 2 - pageWidth / 2) < pageWidth * 0.03 + l.size);
  }
  return paragraphs;
}

// Finds tables: runs of rows where text sits in the same columns. Returns the page split into
// segments in reading order, each either { lines } (ordinary text) or { table: [[cellLines…]…] }.
function findTables(lines) {
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const rows = [];
  for (const l of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(l.baseline - row.baseline) < row.size * 0.35) row.cells.push(l);
    else rows.push({ baseline: l.baseline, size: l.size, cells: [l] });
  }
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x);

  // Columns = gaps in the text that every row of the block leaves open.
  const columnsOf = (block) => {
    const spans = block.flatMap((r) => r.cells.map((c) => [c.x, c.x + c.w])).sort((a, b) => a[0] - b[0]);
    const cols = [];
    for (const [a, b] of spans) {
      const last = cols[cols.length - 1];
      if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b);
      else cols.push([a, b]);
    }
    return cols;
  };
  const colIndex = (cols, cell) => cols.findIndex(([a, b]) => cell.x >= a - 1 && cell.x <= b);

  const segments = [];
  const pushLines = (ls) => {
    const last = segments[segments.length - 1];
    if (last && last.lines) last.lines.push(...ls);
    else segments.push({ lines: [...ls] });
  };
  let i = 0;
  while (i < rows.length) {
    if (rows[i].cells.length < 2) { pushLines(rows[i++].cells); continue; }
    // Grow a block of multi-cell rows (single-cell rows may be wrapped cell text) while columns hold.
    let j = i + 1;
    let cols = columnsOf([rows[i]]);
    while (j < rows.length) {
      const gap = rows[j].baseline - rows[j - 1].baseline;
      if (gap > Math.max(rows[j - 1].size, rows[j].size) * 3) break;
      const next = columnsOf(rows.slice(i, j + 1));
      if (next.length < 2 || next.length < Math.min(cols.length, 3)) break;
      if (rows[j].cells.length < 2) {
        // A lone line only belongs if another multi-cell row follows it within the block.
        let k = j + 1;
        while (k < rows.length && rows[k].cells.length < 2 && k - j < 3) k++;
        if (k >= rows.length || rows[k].cells.length < 2) break;
      }
      cols = next;
      j++;
    }
    while (j > i && rows[j - 1].cells.length < 2) j--; // don't end on a lone line
    // …unless it sits right under the last row: that's the last cell's wrapped text.
    while (j < rows.length && rows[j].cells.length === 1 && rows[j].baseline - rows[j - 1].baseline < rows[j].size * 1.45
      && colIndex(cols, rows[j].cells[0]) >= 0) j++;
    const block = rows.slice(i, j);
    // A header left-aligned over right-aligned numbers leaves a gap inside one column:
    // join neighbouring columns that no row uses both of.
    for (let k = cols.length - 2; k >= 0; k--) {
      const near = cols[k + 1][0] - cols[k][1] < block[0].size * 2.5;
      const both = block.some((r) => r.cells.some((c) => colIndex(cols, c) === k) && r.cells.some((c) => colIndex(cols, c) === k + 1));
      if (near && !both) cols.splice(k, 2, [cols[k][0], cols[k + 1][1]]);
    }
    const multi = block.filter((r) => r.cells.length >= 2);
    const avgLen = multi.reduce((n, r) => n + r.cells.reduce((m, c) => m + c.text.length, 0) / r.cells.length, 0) / (multi.length || 1);
    // Two long-text columns is a two-column page layout, not a table.
    const isTable = multi.length >= 2 && cols.length >= 2 && !(cols.length === 2 && avgLen > 45);
    if (!isTable) { pushLines(rows[i++].cells); continue; }
    // Build the grid; a row with fewer cells right under the previous one continues its cells.
    const grid = [];
    let prev = null;
    for (const r of block) {
      const cells = cols.map(() => []);
      for (const c of r.cells) cells[Math.max(0, colIndex(cols, c))].push(c);
      const filled = cells.filter((c) => c.length).length;
      const tight = prev && r.baseline - prev.baseline < r.size * 1.45;
      if (grid.length && tight && filled < Math.max(2, grid[grid.length - 1].filter((c) => c.length).length)) {
        cells.forEach((c, k) => grid[grid.length - 1][k].push(...c));
      } else grid.push(cells);
      prev = r;
    }
    segments.push({ table: grid, cols });
    i = j;
  }
  return segments;
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
    const allLines = await getLines(p);
    const lines = allLines.filter((l) => !l.angle);
    const turned = allLines.filter((l) => l.angle);
    const pageBreak = i > 0;
    if (!allLines.length) {
      emptyPages.push({ p, index: children.length, pageBreak });
      children.push(null); // filled with an image below
      continue;
    }
    const styles = await lineStylesFor(p, allLines);
    const segments = findTables(lines);
    if (turned.length) segments.push({ lines: turned.map((l, k) => ({ ...l, x: 0, baseline: 1e6 + k * 1e3 })) });
    // Body text size = the size used by the most characters on the page.
    const chars = new Map();
    for (const l of lines) chars.set(Math.round(l.size), (chars.get(Math.round(l.size)) || 0) + l.text.length);
    const body = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
    let first = pageBreak;
    const run = (text, size, style, extra = {}) => new D.TextRun({
      text,
      size: Math.max(2, Math.round(size * 2)),
      bold: style.bold || undefined,
      italics: style.italic || undefined,
      font: WORD_FONTS[style.family] || 'Arial',
      ...extra,
    });
    for (const seg of segments) {
      if (seg.table) {
        const widths = seg.cols.map(([a], k) => (seg.cols[k + 1] ? seg.cols[k + 1][0] : seg.cols[k][1] + 6) - a);
        const total = widths.reduce((x, y) => x + y, 0);
        const usable = 9000; // twips between the page margins, roughly
        if (first) { children.push(new D.Paragraph({ pageBreakBefore: true, children: [] })); first = false; }
        children.push(new D.Table({
          width: { size: 100, type: D.WidthType.PERCENTAGE },
          columnWidths: widths.map((x) => Math.round((x / total) * usable)),
          rows: seg.table.map((cells) => new D.TableRow({
            children: cells.map((cellLines, k) => {
              const sortedLines = [...cellLines].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
              const text = sortedLines.map((l) => l.text.trim()).join(' ');
              const l0 = sortedLines[0];
              // Numbers and centered headings keep their alignment inside the cell.
              const [a, b] = seg.cols[k];
              const mid = l0 ? l0.x + l0.w / 2 : 0;
              const alignment = !l0 ? undefined
                : /^[-+(]?[\d$€£¥.,%\s)]+$/.test(text) && Math.abs(l0.x + l0.w - b) < 3 && l0.x - a > 3 ? D.AlignmentType.RIGHT
                  : Math.abs(mid - (a + b) / 2) < 3 && l0.x - a > 3 ? D.AlignmentType.CENTER : undefined;
              return new D.TableCell({
                width: { size: Math.round((widths[k] / total) * usable), type: D.WidthType.DXA },
                margins: { top: 40, bottom: 40, left: 80, right: 80 },
                children: [new D.Paragraph({
                  alignment,
                  children: l0 ? [run(text, l0.size, styles.get(l0) || {})] : [],
                })],
              });
            }),
          })),
        }));
        children.push(new D.Paragraph({ children: [], spacing: { after: 120 } }));
        continue;
      }
      paragraphsFromLines(seg.lines, w).forEach((para) => {
        const style = styles.get(para.lines[0]) || {};
        const ratio = para.size / body;
        const heading = ratio >= 1.6 ? D.HeadingLevel.HEADING_1 : ratio >= 1.25 ? D.HeadingLevel.HEADING_2 : undefined;
        children.push(new D.Paragraph({
          heading,
          pageBreakBefore: first || undefined,
          alignment: para.centered ? D.AlignmentType.CENTER : undefined,
          spacing: { after: Math.round(Math.min(para.size, 14) * 8) },
          children: [run(para.text, para.size, style, { color: heading ? '000000' : undefined })],
        }));
        first = false;
      });
    }
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
    // Tables come out one row per line with tab-separated cells (pastes into a spreadsheet).
    const all = await getLines(p);
    const turned = all.filter((l) => l.angle).map((l) => l.text);
    const blocks = findTables(all.filter((l) => !l.angle)).map((seg) => (seg.table
      ? seg.table.map((row) => row.map((cell) => [...cell].sort((a, b) => a.baseline - b.baseline).map((l) => l.text.trim()).join(' ')).join('\t')).join('\n')
      : paragraphsFromLines(seg.lines, pageDims(p).w).map((q) => q.text).join('\n\n')));
    parts.push([...blocks, ...turned].join('\n\n'));
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
