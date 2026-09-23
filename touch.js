'use strict';

// Touch support for the editor and tool pages.
//
// The viewer uses `touch-action: none` on touch screens, so gestures are handled here:
//   - one finger on empty page areas scrolls (with momentum) in tap-style tools,
//     and a quick tap still does what a click would (add text, place a stamp, deselect…);
//   - one finger in drawing tools draws, and on items/handles moves or resizes them;
//   - two fingers pinch-zoom and pan in any tool (cancelling a stroke just started);
//   - double-tap edits text and comments;
//   - long-press then drag reorders page thumbnails and tool-page cards.

// Tools where one finger should scroll unless it lands on something to grab.
const PAN_TOOLS = new Set(['select', 'edittext', 'text', 'note', 'stamp', 'image', 'sign']);
const TAP_SLOP = 9; // px a finger may wander and still count as a tap

const fingers = new Map(); // pointerId -> { x, y }
let gesture = null;
let momentumFrame = 0;
let lastTap = { time: 0, aid: null };

function stopMomentum() {
  cancelAnimationFrame(momentumFrame);
  momentumFrame = 0;
}

function startMomentum(vx, vy) {
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(48, now - last);
    last = now;
    viewer.scrollLeft -= vx * dt;
    viewer.scrollTop -= vy * dt;
    const decay = Math.pow(0.95, dt / 16);
    vx *= decay;
    vy *= decay;
    momentumFrame = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
  };
  momentumFrame = requestAnimationFrame(step);
}

// Undoes a stroke/shape/move that a second finger interrupted.
function cancelActiveDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (['draw', 'rect', 'line'].includes(d.mode)) d.p.annots = d.p.annots.filter((a) => a !== d.a);
  else if (d.orig) Object.assign(d.a, structuredClone(d.orig));
  renderOverlay(d.p);
}

// Something a finger should grab rather than scroll past.
function isGrabTarget(e) {
  if (e.target.closest('.handle, .text-editor, .note-editor, .form-field, input, textarea, select, button')) return true;
  if (state.tool === 'select' && e.target.closest('[data-aid]')) return true;
  if (state.tool === 'text' && e.target.closest('.annot-text')) return true;
  if (state.tool === 'note' && e.target.closest('.annot-note')) return true;
  return false;
}

function midpoint() {
  const [a, b] = [...fingers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
}

function onFingerDown(e) {
  if (e.pointerType !== 'touch' || !inEditor()) return;
  stopMomentum();
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (fingers.size === 2) {
    // Pinch/pan with two fingers, whatever the tool.
    cancelActiveDrag();
    finishEdit();
    const m = midpoint();
    const vr = viewer.getBoundingClientRect();
    gesture = {
      type: 'pinch', start: m, zoom: state.zoom,
      anchor: zoomAnchor(m.x, m.y),
      originX: viewer.scrollLeft + m.x - vr.left,
      originY: viewer.scrollTop + m.y - vr.top,
      scale: 1, now: m,
    };
    pagesEl.style.transformOrigin = `${gesture.originX}px ${gesture.originY}px`;
    pagesEl.style.willChange = 'transform';
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  if (fingers.size > 2) { e.stopPropagation(); return; }

  if (!e.target.closest('.page') || isGrabTarget(e) || !PAN_TOOLS.has(state.tool)) {
    // Let the editor handle it (draw, move, resize, type…); remember it for double-tap.
    gesture = { type: 'pass', start: { x: e.clientX, y: e.clientY }, time: performance.now(), target: e.target };
    return;
  }
  // Scroll, or a tap if the finger barely moves.
  gesture = {
    type: 'pan', down: e, start: { x: e.clientX, y: e.clientY }, time: performance.now(),
    scrollLeft: viewer.scrollLeft, scrollTop: viewer.scrollTop, moved: false,
    samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }],
  };
  e.stopPropagation();
}

function onFingerMove(e) {
  if (e.pointerType !== 'touch' || !fingers.has(e.pointerId)) return;
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;

  if (gesture.type === 'pinch' && fingers.size >= 2) {
    const m = midpoint();
    gesture.scale = clamp(m.d / gesture.start.d, 0.25 / gesture.zoom, 4 / gesture.zoom);
    gesture.now = m;
    pagesEl.style.transform = `translate(${m.x - gesture.start.x}px, ${m.y - gesture.start.y}px) scale(${gesture.scale})`;
    e.stopPropagation();
  } else if (gesture.type === 'pan') {
    const dx = e.clientX - gesture.start.x;
    const dy = e.clientY - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) > TAP_SLOP) gesture.moved = true;
    if (gesture.moved) {
      viewer.scrollLeft = gesture.scrollLeft - dx;
      viewer.scrollTop = gesture.scrollTop - dy;
      const now = performance.now();
      gesture.samples.push({ t: now, x: e.clientX, y: e.clientY });
      while (gesture.samples.length > 2 && now - gesture.samples[0].t > 100) gesture.samples.shift();
    }
    e.stopPropagation();
  }
}

function onFingerUp(e) {
  if (e.pointerType !== 'touch' || !fingers.has(e.pointerId)) return;
  const finger = fingers.get(e.pointerId);
  fingers.delete(e.pointerId);
  if (!gesture) return;

  if (gesture.type === 'pinch') {
    if (fingers.size >= 2) return;
    const g = gesture;
    gesture = { type: 'done' }; // ignore the remaining finger until it lifts
    pagesEl.style.transform = '';
    pagesEl.style.willChange = '';
    if (Math.abs(g.scale - 1) > 0.02 && g.anchor) {
      setZoom(g.zoom * g.scale, { ...g.anchor, clientX: g.now.x, clientY: g.now.y });
    } else {
      viewer.scrollLeft -= g.now.x - g.start.x;
      viewer.scrollTop -= g.now.y - g.start.y;
    }
    e.stopPropagation();
    return;
  }

  if (gesture.type === 'pan') {
    const g = gesture;
    gesture = null;
    e.stopPropagation();
    if (!g.moved && e.type === 'pointerup') {
      // A tap: run it through the editor as if it were a click.
      onPagePointerDown(g.down);
      endDrag();
      return;
    }
    const first = g.samples[0];
    const last = g.samples[g.samples.length - 1];
    const dt = last.t - first.t;
    if (dt > 0 && performance.now() - last.t < 80) startMomentum((last.x - first.x) / dt, (last.y - first.y) / dt);
    return;
  }

  if (gesture.type === 'pass') {
    const g = gesture;
    gesture = null;
    const quick = performance.now() - g.time < 300 && Math.hypot(finger.x - g.start.x, finger.y - g.start.y) < TAP_SLOP;
    const aid = g.target.closest && g.target.closest('[data-aid]')?.dataset.aid;
    if (quick && aid) {
      if (lastTap.aid === aid && performance.now() - lastTap.time < 350) {
        // The first tap re-renders the overlay, so aim at whatever is under the finger now.
        const target = document.elementFromPoint(finger.x, finger.y) || g.target;
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: finger.x, clientY: finger.y }));
        lastTap = { time: 0, aid: null };
      } else {
        lastTap = { time: performance.now(), aid };
      }
    }
    return;
  }
  if (!fingers.size) gesture = null;
}

/* ---------------- long-press reordering ---------------- */

// Lets fingers reorder items that use HTML drag-and-drop with a mouse.
// onDrop(dragId, targetId, after) does the actual move.
function touchSortable(container, itemSelector, { axis = 'x', onDrop }) {
  let pending = null;
  let active = null;
  const clearMarks = () => container.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { pending && clearTimeout(pending.timer); pending = null; return; }
    const item = e.target.closest(itemSelector);
    if (!item || e.target.closest('button, input, label')) return;
    const t = e.touches[0];
    pending = {
      item, x: t.clientX, y: t.clientY,
      timer: setTimeout(() => {
        active = { item, target: null, after: false };
        item.classList.add('dragging');
        if (navigator.vibrate) navigator.vibrate(15);
        pending = null;
      }, 380),
    };
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (pending && Math.hypot(t.clientX - pending.x, t.clientY - pending.y) > 10) {
      clearTimeout(pending.timer);
      pending = null;
    }
    if (!active) return;
    e.preventDefault(); // we're dragging, not scrolling
    clearMarks();
    const under = document.elementFromPoint(t.clientX, t.clientY);
    const target = under && under.closest(itemSelector);
    active.target = null;
    if (target && target !== active.item && container.contains(target)) {
      const r = target.getBoundingClientRect();
      active.after = axis === 'y' ? t.clientY > r.top + r.height / 2 : t.clientX > r.left + r.width / 2;
      target.classList.add(active.after ? 'drop-after' : 'drop-before');
      active.target = target;
    }
    // Scroll the list when dragging near its edges.
    const scroller = container.closest('#thumbs, .site-scroll') || container;
    const sr = scroller.getBoundingClientRect();
    if (t.clientY < sr.top + 40) scroller.scrollTop -= 12;
    else if (t.clientY > sr.bottom - 40) scroller.scrollTop += 12;
  }, { passive: false });

  const finish = () => {
    if (pending) { clearTimeout(pending.timer); pending = null; }
    if (!active) return;
    const { item, target, after } = active;
    active = null;
    item.classList.remove('dragging');
    clearMarks();
    if (target) onDrop(item.dataset.id, target.dataset.id, after);
  };
  container.addEventListener('touchend', finish);
  container.addEventListener('touchcancel', finish);
  // A long press would otherwise open the browser's context menu.
  container.addEventListener('contextmenu', (e) => { if (e.target.closest(itemSelector)) e.preventDefault(); });
}

function initTouch() {
  viewer.addEventListener('pointerdown', onFingerDown, { capture: true });
  window.addEventListener('pointermove', onFingerMove, { capture: true });
  window.addEventListener('pointerup', onFingerUp, { capture: true });
  window.addEventListener('pointercancel', onFingerUp, { capture: true });
  touchSortable(thumbsEl, '.thumb', { axis: 'y', onDrop: movePagesTo });
  touchSortable($('tvMain'), '.pg-card, .file-card:not(.add-card)', { axis: 'x', onDrop: (dragId, targetId, after) => hubMoveItem(dragId, targetId, after) });
}
