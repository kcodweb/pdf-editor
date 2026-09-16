'use strict';

// Page numbers, headers/footers and watermarks. They're document-wide settings (state.decor)
// drawn on every page — on screen and at export — so numbering always follows the current order.
// Coordinates are in the page's displayed frame (after rotation), y down, in points.

const todayText = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function decorItems(p, index, total) {
  const d = state.decor;
  if (!d) return [];
  const { w, h } = pageDims(p);
  const start = Number.isFinite(d.start) ? d.start : 1;
  const fill = (text) => text
    .replace(/\{page\}/gi, index + start)
    .replace(/\{total\}/gi, total + start - 1)
    .replace(/\{date\}/gi, todayText())
    .replace(/\{file\}/gi, state.fileName);
  const items = [];
  const add = (text, vpos, align) => {
    if (!text || !text.trim()) return;
    items.push({
      text: fill(text), align, size: d.size, color: d.color,
      x: align === 'left' ? d.margin : align === 'right' ? w - d.margin : w / 2,
      y: vpos === 'top' ? d.margin + d.size * 0.8 : h - d.margin,
    });
  };
  if (!(d.skipFirst && index === 0)) {
    if (d.header) add(d.header.text, 'top', d.header.align);
    if (d.footer) add(d.footer.text, 'bottom', d.footer.align);
    if (d.numbers) {
      const [vpos, align] = d.numbers.position.split('-');
      add(d.numbers.format, vpos, align);
    }
  }
  if (d.watermark && d.watermark.text.trim()) {
    const wm = d.watermark;
    items.push({
      text: wm.text, align: 'center', size: wm.size, color: wm.color, opacity: wm.opacity, bold: true,
      x: w / 2, y: h / 2, middle: true, angle: wm.diagonal ? (Math.atan2(h, w) * 180) / Math.PI : 0,
    });
  }
  return items;
}

function renderDecor(g, p, index, total) {
  g.replaceChildren();
  for (const it of decorItems(p, index, total)) {
    const t = svgEl('text', {
      x: it.x,
      y: it.middle ? it.y + it.size * 0.35 : it.y,
      'font-size': it.size,
      fill: it.color,
      'fill-opacity': it.opacity ?? 1,
      'font-family': cssFontStack('sans'),
      'font-weight': it.bold ? 700 : 400,
      'text-anchor': { left: 'start', center: 'middle', right: 'end' }[it.align],
      transform: it.angle ? `rotate(${-it.angle} ${it.x} ${it.y})` : null,
    });
    t.textContent = it.text;
    g.appendChild(t);
  }
}

/* ---------------- dialog ---------------- */

let decorBefore = null; // settings when the dialog opened, restored on cancel

function fillDecorForm(d) {
  const v = (id, value) => { $(id).value = value; };
  const c = (id, value) => { $(id).checked = value; };
  c('dNumbers', !!(d && d.numbers));
  v('dNumPos', d?.numbers?.position || 'bottom-center');
  v('dNumFormat', d?.numbers?.format || 'Page {page} of {total}');
  v('dStart', d?.start ?? 1);
  c('dHeader', !!(d && d.header));
  v('dHeaderText', d?.header?.text || '');
  v('dHeaderAlign', d?.header?.align || 'center');
  c('dFooter', !!(d && d.footer));
  v('dFooterText', d?.footer?.text || '');
  v('dFooterAlign', d?.footer?.align || 'left');
  v('dSize', d?.size ?? 10);
  v('dMargin', d?.margin ?? 30);
  v('dColor', d?.color || '#475569');
  c('dSkipFirst', !!d?.skipFirst);
  c('dWatermark', !!(d && d.watermark));
  v('dWmText', d?.watermark?.text || '');
  v('dWmSize', d?.watermark?.size ?? 72);
  v('dWmOpacity', Math.round((d?.watermark?.opacity ?? 0.15) * 100));
  v('dWmColor', d?.watermark?.color || '#dc2626');
  c('dWmDiagonal', d?.watermark ? !!d.watermark.diagonal : true);
}

function readDecorForm() {
  const num = (id, fallback, min, max) => {
    const n = Number($(id).value);
    return Number.isFinite(n) && $(id).value !== '' ? clamp(n, min, max) : fallback;
  };
  const d = {
    numbers: $('dNumbers').checked ? { position: $('dNumPos').value, format: $('dNumFormat').value } : null,
    header: $('dHeader').checked && $('dHeaderText').value.trim() ? { text: $('dHeaderText').value, align: $('dHeaderAlign').value } : null,
    footer: $('dFooter').checked && $('dFooterText').value.trim() ? { text: $('dFooterText').value, align: $('dFooterAlign').value } : null,
    watermark: $('dWatermark').checked && $('dWmText').value.trim() ? {
      text: $('dWmText').value, size: num('dWmSize', 72, 12, 300), opacity: num('dWmOpacity', 15, 5, 60) / 100,
      color: $('dWmColor').value, diagonal: $('dWmDiagonal').checked,
    } : null,
    start: num('dStart', 1, 0, 99999),
    size: num('dSize', 10, 6, 48),
    margin: num('dMargin', 30, 6, 144),
    color: $('dColor').value,
    skipFirst: $('dSkipFirst').checked,
  };
  return d.numbers || d.header || d.footer || d.watermark ? d : null;
}

function openDecorDialog() {
  if (!state.pages.length) return;
  finishEdit();
  decorBefore = state.decor;
  fillDecorForm(state.decor);
  if (!state.decor) $('dNumbers').checked = true; // most people come here for page numbers
  openModal('decorModal');
  previewDecor();
}

function previewDecor() {
  state.decor = readDecorForm();
  state.pages.forEach(renderOverlay);
}

function closeDecor(apply) {
  if ($('decorModal').hidden) return;
  closeModal('decorModal');
  if (apply) {
    const next = readDecorForm();
    state.decor = decorBefore;
    if (JSON.stringify(next) !== JSON.stringify(decorBefore)) {
      pushHistory();
      state.decor = next;
    }
  } else {
    state.decor = decorBefore;
  }
  decorBefore = null;
  state.pages.forEach(renderOverlay);
  updateUI();
}

function initDecor() {
  const form = $('decorForm');
  form.addEventListener('input', (e) => {
    // Typing into a section switches it on.
    const section = e.target.closest('.decor-section');
    const toggle = section && section.querySelector('.strong input');
    if (toggle && e.target !== toggle) toggle.checked = true;
    previewDecor();
  });
  form.addEventListener('change', previewDecor);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    closeDecor(true);
  });
  $('decorRemove').addEventListener('click', () => {
    form.querySelectorAll('.decor-section .strong input').forEach((c) => { c.checked = false; });
    previewDecor();
    closeDecor(true);
  });
}
