'use strict';

// Text that's already in the PDF. pdf.js reports it as scattered fragments; we group them into
// lines (in the page's base frame) and use those lines for three things:
//   - an invisible, selectable text layer so text can be copied,
//   - "Edit text": cover a line with its background color and retype it as a text annotation,
//   - search.

const lineCache = new Map();

function getLines(p) {
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

/* ---------------- selectable text layer ---------------- */

async function buildTextLayer(el, p) {
  if (p.src === null || el.querySelector('.text-layer')) return;
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

function sizeTextLayer(el, p) {
  const layer = el.querySelector('.text-layer');
  if (!layer) return;
  const m = rotMatrix(p.rot, p.baseW, p.baseH).map((v) => v * state.zoom);
  layer.style.transform = `matrix(${m.join(',')})`;
}

/* ---------------- editing existing text ---------------- */

async function lineFontStyle(p, line) {
  const style = { font: lineFamily(line), bold: false, italic: false };
  try {
    const page = await state.sources[p.src].pdf.getPage(p.index + 1);
    if (page.commonObjs.has(line.fontName)) {
      const f = page.commonObjs.get(line.fontName);
      const name = f.name || '';
      style.bold = !!(f.bold || f.black) || /bold|black|heavy|semibold|demi/i.test(name);
      style.italic = !!f.italic || /italic|oblique/i.test(name);
      if (/courier|mono|consol/i.test(name)) style.font = 'mono';
      else if (/times|serif|georgia|garamond|roman|minion|cambria|palatino/i.test(name) && !/sans/i.test(name)) style.font = 'serif';
    }
  } catch { /* keep the generic guess */ }
  return style;
}

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// Reads the rendered page to find a line's background color (most common) and text color
// (the pixels most different from the background).
function sampleColors(p, box) {
  const fallback = { text: '#000000', bg: '#ffffff' };
  const el = pageElOf(p.id);
  const canvas = el && el.querySelector('canvas');
  if (!canvas || !canvas.width || !el.dataset.rendered) return fallback;
  const svg = el.querySelector('svg.overlay');
  const ctm = el.querySelector('g.root').getCTM();
  const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => {
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    return pt.matrixTransform(ctm);
  });
  const sx = canvas.width / el.clientWidth;
  const sy = canvas.height / el.clientHeight;
  const x0 = clamp(Math.floor(Math.min(...corners.map((c) => c.x)) * sx), 0, canvas.width - 1);
  const y0 = clamp(Math.floor(Math.min(...corners.map((c) => c.y)) * sy), 0, canvas.height - 1);
  const x1 = clamp(Math.ceil(Math.max(...corners.map((c) => c.x)) * sx), x0 + 1, canvas.width);
  const y1 = clamp(Math.ceil(Math.max(...corners.map((c) => c.y)) * sy), y0 + 1, canvas.height);
  let data;
  try {
    data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, x1 - x0, y1 - y0).data;
  } catch {
    return fallback;
  }

  const counts = new Map();
  let bgKey = 0;
  let bgCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const c = (counts.get(key) || 0) + 1;
    counts.set(key, c);
    if (c > bgCount) { bgCount = c; bgKey = key; }
  }
  let br = 0, bgc = 0, bb = 0, bn = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)) === bgKey) {
      br += data[i]; bgc += data[i + 1]; bb += data[i + 2]; bn++;
    }
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
  const style = await lineFontStyle(p, line);
  const colors = sampleColors(p, { x: line.x, y: top, w: line.w, h: height });
  const pad = Math.max(1, line.size * 0.08);
  const a = {
    id: uid(), type: 'text', text: line.text, color: colors.text, ...style,
    x: line.x, y: line.baseline - line.size * 0.8, size: Math.round(line.size * 10) / 10,
    cover: { x: line.x - pad, y: top - pad / 2, w: line.w + pad * 2, h: height + pad, fill: colors.bg },
  };
  p.annots.push(a);
  startEdit(p, a, true, snap);
}

function initTextLayer() {
  pagesEl.addEventListener('click', async (e) => {
    if (state.tool !== 'edittext') return;
    const span = e.target.closest('.tl-line');
    if (!span) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // the user dragged to select text for copying
    const p = findPage(span.closest('.page').dataset.id);
    const line = p && (await getLines(p))[Number(span.dataset.line)];
    if (line) startReplaceEdit(p, line);
  });
}

/* ---------------- search ---------------- */

const search = { query: '', hits: [], index: -1, token: 0 };

function matchRect(line, start, end) {
  measureCtx.font = `${line.size}px ${genericCss(line)}`;
  const full = measureCtx.measureText(line.text).width || 1;
  const at = (i) => line.x + (line.w * measureCtx.measureText(line.text.slice(0, i)).width) / full;
  const x0 = at(start);
  return { x: x0, y: line.baseline - line.size * 0.88, w: Math.max(2, at(end) - x0), h: line.size * 1.12 };
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
  if (q) {
    $('searchCount').textContent = 'Searching…';
    for (const p of state.pages) {
      const lines = await getLines(p);
      if (token !== search.token) return;
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
  // Keep the same match active when results are refreshed after an edit.
  search.index = hits.length ? Math.max(0, previous ? hits.findIndex((h) => h.pageId === previous.pageId && h.rect.x === previous.rect.x && h.rect.y === previous.rect.y) : 0) : -1;
  updateSearchUI();
  state.pages.forEach(renderOverlay);
  if (scroll && hits.length) scrollToHit(hits[search.index]);
}

function updateSearchUI() {
  const n = search.hits.length;
  $('searchCount').textContent = search.query.trim() ? (n ? `${search.index + 1} of ${n}` : 'No matches') : '';
  $('searchPrev').disabled = $('searchNext').disabled = $('searchHighlight').disabled = !n;
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
  const svg = el.querySelector('svg.overlay');
  const pt = svg.createSVGPoint();
  pt.x = hit.rect.x;
  pt.y = hit.rect.y;
  const at = pt.matrixTransform(el.querySelector('g.root').getCTM());
  viewer.scrollTo({
    top: el.offsetTop + at.y - viewer.clientHeight / 3,
    left: Math.max(0, el.offsetLeft + at.x - viewer.clientWidth / 2),
    behavior: 'smooth',
  });
}

function highlightAllMatches() {
  if (!search.hits.length) return;
  pushHistory();
  for (const hit of search.hits) {
    const p = findPage(hit.pageId);
    if (!p) continue;
    const { x, y, w, h } = hit.rect;
    p.annots.push({ id: uid(), type: 'rect', kind: 'highlight', x: x - 1, y, w: w + 2, h, color: state.colors.highlight });
  }
  const n = search.hits.length;
  closeSearch();
  renderAll();
  toast(`Highlighted ${n} match${n === 1 ? '' : 'es'}.`);
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
  $('searchHighlight').addEventListener('click', highlightAllMatches);
  $('searchClose').addEventListener('click', closeSearch);
  $('btnFind').addEventListener('click', openSearch);
  updateSearchUI();
}
