'use strict';

// Fonts are shared by the screen (via @font-face) and exported PDFs (embedded with pdf-lib),
// so what you see while editing matches the downloaded file.
const FONT_DIR = 'fonts/';

const FONT_FAMILIES = {
  sans: { css: 'EdSans', files: { r: 'NotoSans-Regular.ttf', b: 'NotoSans-Bold.ttf', i: 'NotoSans-Italic.ttf', bi: 'NotoSans-BoldItalic.ttf' } },
  serif: { css: 'EdSerif', files: { r: 'NotoSerif-Regular.ttf', b: 'NotoSerif-Bold.ttf', i: 'NotoSerif-Italic.ttf', bi: 'NotoSerif-BoldItalic.ttf' } },
  mono: { css: 'EdMono', files: { r: 'NotoSansMono-Regular.ttf', b: 'NotoSansMono-Bold.ttf' } },
  // Metric-compatible with common document fonts, so edited text takes the same space as the original.
  arial: { css: 'EdArial', files: { r: 'LiberationSans-Regular.ttf', b: 'LiberationSans-Bold.ttf', i: 'LiberationSans-Italic.ttf', bi: 'LiberationSans-BoldItalic.ttf' } },
  times: { css: 'EdTimes', files: { r: 'LiberationSerif-Regular.ttf', b: 'LiberationSerif-Bold.ttf', i: 'LiberationSerif-Italic.ttf', bi: 'LiberationSerif-BoldItalic.ttf' } },
  courier: { css: 'EdCourier', files: { r: 'LiberationMono-Regular.ttf', b: 'LiberationMono-Bold.ttf', i: 'LiberationMono-Italic.ttf', bi: 'LiberationMono-BoldItalic.ttf' } },
  calibri: { css: 'EdCalibri', files: { r: 'Carlito-Regular.ttf', b: 'Carlito-Bold.ttf', i: 'Carlito-Italic.ttf', bi: 'Carlito-BoldItalic.ttf' } },
  cambria: { css: 'EdCambria', files: { r: 'Caladea-Regular.ttf', b: 'Caladea-Bold.ttf', i: 'Caladea-Italic.ttf', bi: 'Caladea-BoldItalic.ttf' } },
};

// Best available family for a PDF font name, e.g. "ABCDEF+Arial-BoldMT" -> arial.
function matchFontFamily(name, generic) {
  const n = String(name || '');
  if (/arial|helvetica|arimo|liberation ?sans|nimbus ?sans/i.test(n)) return 'arial';
  if (/times|tinos|liberation ?serif|nimbus ?rom/i.test(n)) return 'times';
  if (/courier|cousine|liberation ?mono|nimbus ?mono/i.test(n)) return 'courier';
  if (/calibri|carlito/i.test(n)) return 'calibri';
  if (/cambria|caladea/i.test(n)) return 'cambria';
  if (/mono|consol/i.test(n) || /monospace/.test(generic)) return 'mono';
  if ((/serif|georgia|garamond|roman|minion|palatino|book ?antiqua/i.test(n) && !/sans/i.test(n)) || generic === 'serif') return 'serif';
  return 'sans';
}

// Scripts the main families don't cover, in priority order. Only downloaded when text needs them.
const FALLBACK_FONTS = [
  { file: 'NotoSansArabic-Regular.ttf', ranges: [[0x0600, 0x06FF], [0x0750, 0x077F], [0x08A0, 0x08FF], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF]] },
  { file: 'NotoSansHebrew-Regular.ttf', ranges: [[0x0590, 0x05FF], [0xFB1D, 0xFB4F]] },
  { file: 'NotoSansDevanagari-Regular.ttf', ranges: [[0x0900, 0x097F], [0xA8E0, 0xA8FF], [0x1CD0, 0x1CFF]] },
  { file: 'NotoSansThai-Regular.ttf', ranges: [[0x0E00, 0x0E7F]] },
  { file: 'NotoSansKR.ttf', ranges: [[0x1100, 0x11FF], [0x3130, 0x318F], [0xA960, 0xA97F], [0xAC00, 0xD7FF]] },
  { file: 'NotoSansSC.ttf', ranges: [[0x2E80, 0x2FDF], [0x3000, 0x30FF], [0x3100, 0x312F], [0x31A0, 0x31FF], [0x3200, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFE30, 0xFE4F], [0xFF00, 0xFFEF], [0x20000, 0x2FA1F]] },
  { file: 'NotoSansMath-Regular.ttf', ranges: [[0x2100, 0x21FF], [0x2200, 0x22FF], [0x2300, 0x23FF], [0x25A0, 0x25FF], [0x27C0, 0x27EF], [0x27F0, 0x27FF], [0x2900, 0x2AFF], [0x1D400, 0x1D7FF]] },
  { file: 'NotoEmoji.ttf', ranges: [[0x2190, 0x21FF], [0x2300, 0x23FF], [0x2460, 0x24FF], [0x25A0, 0x27BF], [0x2900, 0x297F], [0x2B00, 0x2BFF], [0x3030, 0x3030], [0x303D, 0x303D], [0x3297, 0x3299], [0x1F000, 0x1FAFF]] },
  { file: 'NotoSansSymbols2-Regular.ttf', ranges: [[0x2000, 0x2BFF], [0x1F000, 0x1FBFF]] },
];

// fontkit bug workaround: font subsets pick the short 'loca' format (offsets stored halved)
// whenever they're small, which corrupts glyphs whose data isn't word-aligned — true for many
// glyphs in these Noto fonts. Forcing the long format keeps every offset exact.
// The subset class is only reachable through a loaded font, so fontkitFor() applies this.
let fontkitPatched = false;
function ensureFontkitPatched(fontkitFont) {
  if (fontkitPatched) return;
  const proto = Object.getPrototypeOf(fontkitFont.createSubset());
  const addGlyph = proto._addGlyph;
  if (typeof addGlyph !== 'function') return;
  proto._addGlyph = function (gid) {
    if (this.loca && this.loca.version == null) this.loca.version = 1;
    return addGlyph.call(this, gid);
  };
  fontkitPatched = true;
}

// Invisible joiners and variation selectors: dropped if no font has a glyph for them.
const IGNORABLE = /[​-‏⁠︀-️\u{E0020}-\u{E007F}]/u;

function installFontFaces() {
  const rules = [];
  const face = (family, file, weight, style, ranges) => rules.push(
    `@font-face{font-family:${family};src:url("${FONT_DIR}${file}") format("truetype");` +
    `font-weight:${weight};font-style:${style};font-display:swap;` +
    (ranges ? `unicode-range:${ranges.map(([a, b]) => `U+${a.toString(16)}-${b.toString(16)}`).join(',')};` : '') + '}');

  for (const fam of Object.values(FONT_FAMILIES)) {
    const f = fam.files;
    face(fam.css, f.r, 400, 'normal');
    if (f.b) face(fam.css, f.b, 700, 'normal');
    if (f.i) face(fam.css, f.i, 400, 'italic');
    if (f.bi) face(fam.css, f.bi, 700, 'italic');
  }
  // When unicode-ranges overlap, the browser tries the last-declared face first.
  [...FALLBACK_FONTS].reverse().forEach((fb) => face('EdFallback', fb.file, 400, 'normal', fb.ranges));
  face('EdScript', 'DancingScript.ttf', '400 700', 'normal');

  const style = document.createElement('style');
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
}

function cssFontStack(family) {
  return `${(FONT_FAMILIES[family] || FONT_FAMILIES.sans).css}, EdFallback, sans-serif`;
}

// Picks the font file for a style; italic is synthesized (skewed) when the family has no italic face.
function faceFile(family, bold, italic) {
  const files = (FONT_FAMILIES[family] || FONT_FAMILIES.sans).files;
  const key = `${bold ? 'b' : ''}${italic ? 'i' : ''}` || 'r';
  if (files[key]) return { file: files[key], synthItalic: false };
  return { file: files[bold ? 'b' : 'r'] || files.r, synthItalic: italic };
}

const fontBytesCache = new Map();
function fetchFontBytes(file) {
  if (!fontBytesCache.has(file)) {
    const job = fetch(FONT_DIR + file).then((res) => {
      if (!res.ok) throw new Error(`Couldn't download the font ${file}`);
      return res.arrayBuffer();
    });
    job.catch(() => fontBytesCache.delete(file));
    fontBytesCache.set(file, job);
  }
  return fontBytesCache.get(file);
}

const fontkitCache = new Map();
function fontkitFor(file) {
  if (!fontkitCache.has(file)) {
    const job = fetchFontBytes(file).then((buf) => {
      const font = fontkit.create(new Uint8Array(buf));
      ensureFontkitPatched(font);
      return font;
    });
    job.catch(() => fontkitCache.delete(file));
    fontkitCache.set(file, job);
  }
  return fontkitCache.get(file);
}

const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

// Splits a line into runs that can each be drawn with one font file.
// Characters stay with the previous run's font when it covers them, so spaces and
// punctuation inside Arabic or CJK text don't break the run apart.
async function splitRuns(text, primaryFile) {
  const runs = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const last = runs[runs.length - 1];
    const candidates = [];
    if (last) candidates.push(last.file);
    candidates.push(primaryFile);
    for (const fb of FALLBACK_FONTS) if (inRanges(cp, fb.ranges)) candidates.push(fb.file);

    let file = null;
    for (const f of candidates) {
      if ((await fontkitFor(f)).hasGlyphForCodePoint(cp)) { file = f; break; }
    }
    if (!file) {
      if (IGNORABLE.test(ch)) continue;
      file = last ? last.file : primaryFile; // draws the font's "missing glyph" box
    }
    if (last && last.file === file) last.text += ch;
    else runs.push({ file, text: ch });
  }
  return runs;
}

// ---- Right-to-left text ----
// A compact version of the Unicode bidi algorithm: enough for Arabic/Hebrew mixed with
// English and numbers on one line. The line's direction comes from its first strong letter
// (like dir="auto"). Returns the font runs in left-to-right drawing order. Runs in an RTL
// script keep their logical order because fontkit reverses (and shapes) those itself.
const RTL_RANGES = [[0x0590, 0x08FF], [0xFB1D, 0xFDFF], [0xFE70, 0xFEFF]];
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«', '‹': '›', '›': '‹' };

function bidiType(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06F0 && cp <= 0x06F9)) return 'A'; // Arabic-Indic digits
  if (/\p{M}/u.test(ch)) return 'M';
  if (inRanges(cp, RTL_RANGES)) return 'R';
  if (/\p{Nd}/u.test(ch)) return 'N';
  if (/\p{L}/u.test(ch)) return 'L';
  return 'O';
}

const hasRtl = (text) => [...text].some((ch) => bidiType(ch) === 'R');
const lineIsRtl = (text) => {
  for (const ch of text) {
    const t = bidiType(ch);
    if (t === 'R') return true;
    if (t === 'L') return false;
  }
  return false;
};

function bidiLevels(chars) {
  const types = chars.map(bidiType);
  const base = types.find((t) => t === 'R' || t === 'L') === 'R' ? 1 : 0;
  const baseDir = base ? 'R' : 'L';
  // Direction of each strong-ish character; numbers follow the preceding letters.
  const dirs = new Array(chars.length).fill(null);
  let prev = baseDir;
  types.forEach((t, i) => {
    if (t === 'R' || t === 'L') prev = dirs[i] = t;
    else if (t === 'N') dirs[i] = prev;
    else if (t === 'A') dirs[i] = 'R';
  });
  // Bracket pairs resolve together (rule N0): to the line's direction if that appears inside
  // them, else to the other direction when it's both inside and just before the pair.
  const stack = [];
  const pairs = [];
  chars.forEach((ch, i) => {
    if ('([{'.includes(ch)) stack.push([ch, i]);
    else if (')]}'.includes(ch)) {
      const k = stack.map(([c]) => c).lastIndexOf('([{'[')]}'.indexOf(ch)]);
      if (k >= 0) { pairs.push([stack[k][1], i]); stack.length = k; }
    }
  });
  pairs.sort((x, y) => x[0] - y[0]);
  for (const [open, close] of pairs) {
    const inside = new Set(dirs.slice(open + 1, close).filter(Boolean));
    if (!inside.size) continue;
    let dir = baseDir;
    if (!inside.has(baseDir)) {
      let before = baseDir;
      for (let k = open - 1; k >= 0; k--) if (dirs[k]) { before = dirs[k]; break; }
      if (before !== baseDir) dir = before;
    }
    dirs[open] = dirs[close] = dir;
  }
  const levelOf = (dir, t) => (dir === 'R' ? (t === 'N' || t === 'A' ? 2 : 1) : base ? 2 : 0);
  const levels = new Array(chars.length);
  for (let i = 0; i < chars.length; i++) {
    const t = types[i];
    if (dirs[i]) { levels[i] = levelOf(dirs[i], t); continue; }
    if (t === 'M') { levels[i] = i ? levels[i - 1] : base; continue; }
    // Neutral run: takes the direction of both sides when they agree, else the line's.
    let j = i;
    while (j < chars.length && !dirs[j]) j++;
    const before = i ? dirs[i - 1] || baseDir : baseDir;
    const after = j < chars.length ? dirs[j] : baseDir;
    const lvl = levelOf(before === after ? before : baseDir, 'O');
    for (let k = i; k < j; k++) levels[k] = types[k] === 'M' && k > i ? levels[k - 1] : lvl;
    i = j - 1;
  }
  return levels;
}

function visualRuns(runs) {
  const chars = [];
  for (const run of runs) for (const ch of run.text) chars.push({ ch, file: run.file });
  if (!chars.some((c) => bidiType(c.ch) === 'R')) return runs; // nothing to reorder
  const levels = bidiLevels(chars.map((c) => c.ch));
  chars.forEach((c, i) => { c.level = levels[i]; });
  // Group into (level, font) pieces in logical order, then reverse the pieces level by level.
  let pieces = [];
  for (const c of chars) {
    const last = pieces[pieces.length - 1];
    if (last && last.level === c.level && last.file === c.file) last.chars.push(c.ch);
    else pieces.push({ level: c.level, file: c.file, chars: [c.ch] });
  }
  const top = Math.max(...pieces.map((p) => p.level));
  for (let lvl = top; lvl >= 1; lvl--) {
    const outp = [];
    for (let i = 0; i < pieces.length;) {
      if (pieces[i].level < lvl) { outp.push(pieces[i++]); continue; }
      let j = i;
      while (j < pieces.length && pieces[j].level >= lvl) j++;
      outp.push(...pieces.slice(i, j).reverse());
      i = j;
    }
    pieces = outp;
  }
  return pieces.map((p) => {
    let chs = p.chars;
    // Odd (RTL) pieces fontkit won't reverse itself: flip them here and mirror brackets.
    if (p.level % 2 && !chs.some((ch) => bidiType(ch) === 'R')) chs = chs.map((ch) => MIRROR[ch] || ch).reverse();
    return { file: p.file, text: chs.join('') };
  });
}

// The single font that can draw the most of `text` (form field appearances can only use one font).
async function fontCoveringText(text) {
  const chars = [...new Set([...text])].filter((ch) => ch !== '\n' && !IGNORABLE.test(ch));
  const candidates = [FONT_FAMILIES.sans.files.r, ...FALLBACK_FONTS.map((f) => f.file)];
  let best = candidates[0];
  let bestCount = -1;
  for (const file of candidates) {
    // Don't download a script font unless some character actually falls in its ranges.
    const fallback = FALLBACK_FONTS.find((f) => f.file === file);
    if (fallback && !chars.some((ch) => inRanges(ch.codePointAt(0), fallback.ranges))) continue;
    const fk = await fontkitFor(file);
    const count = chars.filter((ch) => fk.hasGlyphForCodePoint(ch.codePointAt(0))).length;
    if (count === chars.length) return file;
    if (count > bestCount) { best = file; bestCount = count; }
  }
  return best;
}
