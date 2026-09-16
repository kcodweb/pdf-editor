'use strict';

// Fillable forms: pdf.js reports where the fields are, we overlay real HTML inputs,
// and export.js writes the answers back with pdf-lib.
// Values live in state.forms (user changes, part of undo history) on top of
// state.formDefaults (what the file already contained). Keys are "sourceIndex|fieldName".

const WIDGET_ANNOTATION = 20;
const widgetCache = new Map();

const formKey = (src, name) => `${src}|${name}`;
const formValue = (key) => (key in state.forms ? state.forms[key] : state.formDefaults[key]);

function getWidgets(p) {
  if (p.src === null || !state.sources[p.src].hasForm) return Promise.resolve([]);
  const cacheKey = `${p.src}|${p.index}`;
  if (!widgetCache.has(cacheKey)) {
    widgetCache.set(cacheKey, (async () => {
      const page = await state.sources[p.src].pdf.getPage(p.index + 1);
      const annots = await page.getAnnotations({ intent: 'display' });
      return annots.filter((a) => a.annotationType === WIDGET_ANNOTATION && a.fieldName
        && !(a.annotationFlags & 2) // hidden
        && !a.pushButton
        && ['Tx', 'Btn', 'Ch'].includes(a.fieldType));
    })().catch((err) => { console.warn('Could not read form fields', err); return []; }));
  }
  return widgetCache.get(cacheKey);
}

function initialFormValue(w) {
  if (w.fieldType === 'Tx') return w.fieldValue ?? '';
  if (w.fieldType === 'Btn') return w.fieldValue || 'Off';
  const v = w.fieldValue;
  if (w.multiSelect) return Array.isArray(v) ? v : v ? [v] : [];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

async function buildFormLayer(el, p) {
  const layerKey = `${p.rot}|${state.zoom}`;
  let layer = el.querySelector('.form-layer');
  if (layer && layer.dataset.key === layerKey) { syncFormLayer(layer); return; }
  if (el.dataset.formKey === layerKey) return; // a build for this size is already running
  el.dataset.formKey = layerKey;

  const widgets = await getWidgets(p);
  if (!widgets.length) { el.dataset.formKey = ''; return; }
  const page = await state.sources[p.src].pdf.getPage(p.index + 1);
  if (el.dataset.formKey !== layerKey || !el.isConnected) return;

  const vp = page.getViewport({ scale: state.zoom, rotation: (p.rot0 + p.rot) % 360 });
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'form-layer';
    el.appendChild(layer);
  }
  layer.dataset.key = layerKey;
  layer.replaceChildren();
  for (const w of widgets) {
    const key = formKey(p.src, w.fieldName);
    if (!(key in state.formDefaults)) state.formDefaults[key] = initialFormValue(w);
    if (w.options) state.formOptions[key] = w.options;
    const [x1, y1, x2, y2] = pdfjsLib.Util.normalizeRect(vp.convertToViewportRectangle(w.rect));
    const input = createFieldInput(w, key, y2 - y1);
    Object.assign(input.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    layer.appendChild(input);
  }
  el.dataset.formKey = '';
  syncFormLayer(layer);
}

function createFieldInput(w, key, height) {
  let input;
  const daSize = w.defaultAppearanceData && w.defaultAppearanceData.fontSize;
  const fontSize = daSize ? daSize * state.zoom : Math.max(8, Math.min(height * 0.68, 13 * state.zoom));

  if (w.fieldType === 'Tx') {
    input = document.createElement(w.multiLine ? 'textarea' : 'input');
    if (!w.multiLine) input.type = w.password ? 'password' : 'text';
    if (w.maxLen) input.maxLength = w.maxLen;
    input.dataset.kind = 'text';
    input.style.fontSize = `${fontSize}px`;
    if (w.textAlignment === 1) input.style.textAlign = 'center';
    if (w.textAlignment === 2) input.style.textAlign = 'right';
    let snap = null;
    let start = null;
    input.addEventListener('focus', () => { snap = snapshot(); start = formValue(key); });
    input.addEventListener('input', () => setFormValue(key, input.value, input));
    input.addEventListener('change', () => { if (snap && formValue(key) !== start) pushHistory(snap); snap = null; });
  } else if (w.fieldType === 'Btn') {
    input = document.createElement('input');
    input.type = w.radioButton ? 'radio' : 'checkbox';
    input.dataset.kind = 'check';
    input.dataset.on = w.radioButton ? w.buttonValue : w.exportValue;
    input.addEventListener('change', () => {
      const snap = snapshot();
      const value = input.checked ? input.dataset.on : (w.radioButton ? formValue(key) : 'Off');
      setFormValue(key, value, null);
      pushHistory(snap);
    });
  } else {
    input = document.createElement('select');
    input.dataset.kind = 'select';
    input.multiple = !!w.multiSelect;
    input.style.fontSize = `${fontSize}px`;
    if (!w.multiSelect && !w.options.some((o) => o.exportValue === '')) input.add(new Option('', ''));
    for (const o of w.options) input.add(new Option(o.displayValue, o.exportValue));
    input.addEventListener('change', () => {
      const snap = snapshot();
      const value = input.multiple ? [...input.selectedOptions].map((o) => o.value) : input.value;
      setFormValue(key, value, input);
      pushHistory(snap);
    });
  }
  input.classList.add('form-field');
  input.dataset.field = key;
  input.title = w.alternativeText || w.fieldName;
  if (w.readOnly) input.disabled = true;
  return input;
}

function setFormValue(key, value, source) {
  state.forms[key] = value;
  dirty = true;
  // The same field can appear on several pages (or duplicated pages): keep them all in sync.
  pagesEl.querySelectorAll('.form-layer').forEach((layer) => syncFormLayer(layer, source));
}

function syncFormLayer(layer, except) {
  for (const input of layer.children) {
    if (input === except) continue;
    const v = formValue(input.dataset.field);
    switch (input.dataset.kind) {
      case 'text':
        if (input.value !== (v ?? '')) input.value = v ?? '';
        break;
      case 'check':
        input.checked = v === input.dataset.on;
        break;
      case 'select':
        if (input.multiple) for (const o of input.options) o.selected = Array.isArray(v) && v.includes(o.value);
        else input.value = v ?? '';
        break;
    }
  }
}

// Writes changed answers into a pdf-lib copy of source `src` and regenerates field appearances.
async function applyFormValues(doc, src) {
  const entries = Object.entries(state.forms).filter(([k]) => k.startsWith(`${src}|`));
  if (!entries.length) return;
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = PDFLib;
  const form = doc.getForm();
  let text = '';

  for (const [key, value] of entries) {
    const name = key.slice(key.indexOf('|') + 1);
    try {
      const field = form.getField(name);
      if (field instanceof PDFTextField) {
        field.setText(value || undefined);
        text += value || '';
      } else if (field instanceof PDFCheckBox) {
        if (value && value !== 'Off') field.check(); else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (!value || value === 'Off') field.clear();
        else {
          // Groups with an /Opt array name their on-states by index ("0", "1", ...).
          const options = field.getOptions();
          field.select(!options.includes(value) && /^\d+$/.test(value) && options[+value] ? options[+value] : value);
        }
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        // pdf-lib matches options by their display text.
        const options = state.formOptions[key] || [];
        const toDisplay = (v) => (options.find((o) => o.exportValue === v) || {}).displayValue ?? v;
        const values = (Array.isArray(value) ? value : value ? [value] : []).map(toDisplay);
        if (values.length) field.select(values.length > 1 ? values : values[0]);
        else field.clear();
        text += values.join('');
      }
    } catch (err) {
      console.warn(`Couldn't set form field "${name}"`, err);
    }
  }

  const font = await doc.embedFont(await fetchFontBytes(await fontCoveringText(text)), { subset: true });
  try {
    form.updateFieldAppearances(font);
  } catch (err) {
    console.warn('Could not update form appearances', err);
  }
  // Fonts are normally written when a document is saved; this copy is never saved, so embed now.
  await font.embed();
}
