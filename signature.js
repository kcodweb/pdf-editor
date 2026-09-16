'use strict';

// Signatures: draw or type one, optionally remembered in this browser's localStorage.
const SIG_STORE = 'pdf-editor:signatures';
const SIG_SCALE = 2; // signature images are rendered at 2x for crisp output

let sigCtx = null;
let sigInk = false;
let sigLast = null;
let sigTab = 'draw';

function loadSavedSignatures() {
  try {
    const list = JSON.parse(localStorage.getItem(SIG_STORE));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function storeSignatures(list) {
  try {
    localStorage.setItem(SIG_STORE, JSON.stringify(list.slice(0, 5)));
  } catch { /* storage full or blocked: just don't remember */ }
}

function openSignature() {
  openModal('sigModal');
  renderSavedSignatures();
  setSigTab(sigTab);
}

function closeSignature() {
  closeModal('sigModal');
  pendingPlace = null;
}

function setSigTab(tab) {
  sigTab = tab;
  document.querySelectorAll('[data-sigtab]').forEach((b) => b.classList.toggle('active', b.dataset.sigtab === tab));
  document.querySelectorAll('[data-sigpane]').forEach((p) => { p.hidden = p.dataset.sigpane !== tab; });
  if (tab === 'draw') setupSigCanvas();
  else {
    updateSigPreview();
    $('sigText').focus();
  }
}

function setupSigCanvas() {
  const canvas = $('sigCanvas');
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * SIG_SCALE);
  canvas.height = Math.round(r.height * SIG_SCALE);
  sigCtx = canvas.getContext('2d');
  sigCtx.scale(SIG_SCALE, SIG_SCALE);
  sigCtx.lineWidth = 2.6;
  sigCtx.lineCap = 'round';
  sigCtx.lineJoin = 'round';
  sigCtx.strokeStyle = sigCtx.fillStyle = state.colors.sign;
  sigInk = false;
}

function updateSigPreview() {
  const prev = $('sigPreview');
  prev.textContent = $('sigText').value || 'Your signature';
  prev.style.color = $('sigText').value ? state.colors.sign : '#cbd5e1';
}

function renderSavedSignatures() {
  const list = loadSavedSignatures();
  $('sigSaved').hidden = !list.length;
  const row = $('sigSaved').querySelector('.saved-row');
  row.replaceChildren();
  list.forEach((url, i) => {
    const item = document.createElement('div');
    item.className = 'saved-sig';
    item.innerHTML = `<button type="button" class="use" title="Use this signature"><img alt="Saved signature ${i + 1}"></button>
      <button type="button" class="remove" title="Forget this signature" aria-label="Forget signature ${i + 1}">&times;</button>`;
    item.querySelector('img').src = url;
    item.querySelector('.use').addEventListener('click', () => useSignature(url, true));
    item.querySelector('.remove').addEventListener('click', () => {
      storeSignatures(loadSavedSignatures().filter((u) => u !== url));
      renderSavedSignatures();
    });
    row.appendChild(item);
  });
}

// Crops a canvas to its inked pixels (plus padding) and returns a PNG data URL, or null if empty.
function trimCanvas(canvas, pad = 8) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
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
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

async function typedSignature(text) {
  const font = `64px EdScript, cursive`;
  await document.fonts.load(font, text);
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width + 40);
  c.width = w * SIG_SCALE;
  c.height = 110 * SIG_SCALE;
  ctx.scale(SIG_SCALE, SIG_SCALE);
  ctx.font = font;
  ctx.fillStyle = state.colors.sign;
  ctx.fillText(text, 20, 76);
  return trimCanvas(c);
}

async function useSignature(url, remember) {
  const img = await decodeImage(url);
  const id = registerImage(url, 'png', img.naturalWidth / SIG_SCALE, img.naturalHeight / SIG_SCALE);
  if (remember) storeSignatures([url, ...loadSavedSignatures().filter((u) => u !== url)]);
  const place = pendingPlace;
  closeModal('sigModal');
  pendingPlace = place;
  placeImage(id, 180);
}

function initSignature() {
  const canvas = $('sigCanvas');
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    sigLast = point(e);
    sigCtx.beginPath();
    sigCtx.arc(sigLast[0], sigLast[1], sigCtx.lineWidth / 2, 0, Math.PI * 2);
    sigCtx.fill();
    sigInk = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!sigLast) return;
    const pt = point(e);
    sigCtx.beginPath();
    sigCtx.moveTo(sigLast[0], sigLast[1]);
    sigCtx.lineTo(pt[0], pt[1]);
    sigCtx.stroke();
    sigLast = pt;
  });
  const stop = () => { sigLast = null; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  document.querySelectorAll('[data-sigtab]').forEach((b) => b.addEventListener('click', () => setSigTab(b.dataset.sigtab)));
  $('sigText').addEventListener('input', updateSigPreview);
  $('sigText').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sigOk').click(); });

  $('sigClear').addEventListener('click', () => {
    if (sigTab === 'draw') setupSigCanvas();
    else { $('sigText').value = ''; updateSigPreview(); }
  });
  $('sigModal').querySelector('[data-close]').addEventListener('click', closeSignature);
  $('sigOk').addEventListener('click', async () => {
    let url = null;
    if (sigTab === 'draw') url = sigInk ? trimCanvas(canvas) : null;
    else if ($('sigText').value.trim()) url = await typedSignature($('sigText').value.trim());
    if (!url) {
      toast(sigTab === 'draw' ? 'Draw your signature first.' : 'Type your name first.');
      return;
    }
    useSignature(url, $('sigRemember').checked);
  });
}
