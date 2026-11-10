/*
 * Minimal drag and drop built on pointer events, so the same code handles
 * mouse, pen and touch. On touch, a long press (~350 ms) picks the card up;
 * a quick swipe still scrolls the page as normal.
 */

export interface DragOptions {
  /** Elements that accept a drop: a CSS selector, or a function that maps the element under the pointer to a target. */
  dropSelector: string | ((hit: HTMLElement | null) => HTMLElement | null);
  /** Called on every move with the current target and pointer position (e.g. to show an insertion line). */
  onMove?: (target: HTMLElement | null, x: number, y: number) => void;
  /** Called with the drop target (or null if dropped elsewhere). */
  onDrop: (target: HTMLElement | null, x: number, y: number) => void;
  /** Called after every drag ends, dropped or cancelled. */
  onEnd?: () => void;
}

const LONG_PRESS_MS = 350;
const MOUSE_THRESHOLD = 5;
const TOUCH_CANCEL_DISTANCE = 8;

export function makeDraggable(card: HTMLElement, opts: DragOptions): () => void {
  let pointerId: number | null = null;
  let startX = 0, startY = 0, offsetX = 0, offsetY = 0;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let over: HTMLElement | null = null;
  let timer: number | null = null;
  let isTouch = false;
  let lastX = 0, lastY = 0;

  const clearTimer = () => { if (timer !== null) { window.clearTimeout(timer); timer = null; } };

  const begin = () => {
    dragging = true;
    const rect = card.getBoundingClientRect();
    ghost = card.cloneNode(true) as HTMLElement;
    ghost.classList.add("ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${startX - offsetX}px`;
    ghost.style.top = `${startY - offsetY}px`;
    document.body.appendChild(ghost);
    card.classList.add("dragging");
    // Capture only once a drag starts: capturing on pointerdown would retarget
    // the click of a plain press, so links and click handlers inside the
    // draggable element would stop working.
    if (pointerId !== null) card.setPointerCapture(pointerId);
    if (isTouch && navigator.vibrate) navigator.vibrate(15);
  };

  const move = (x: number, y: number) => {
    if (!ghost) return;
    ghost.style.left = `${x - offsetX}px`;
    ghost.style.top = `${y - offsetY}px`;
    lastX = x; lastY = y;
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const target = typeof opts.dropSelector === "function"
      ? opts.dropSelector(el)
      : el?.closest<HTMLElement>(opts.dropSelector) ?? null;
    if (target !== over) {
      over?.classList.remove("drop-over");
      target?.classList.add("drop-over");
      over = target;
    }
    opts.onMove?.(target, x, y);
  };

  const end = (drop: boolean) => {
    clearTimer();
    const target = over;
    over?.classList.remove("drop-over");
    ghost?.remove();
    card.classList.remove("dragging");
    const wasDragging = dragging;
    if (pointerId !== null && card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    pointerId = null; ghost = null; over = null; dragging = false;
    if (wasDragging) {
      // Swallow the click that follows a drag.
      const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
      card.addEventListener("click", stop, { capture: true, once: true });
      window.setTimeout(() => card.removeEventListener("click", stop, { capture: true }), 0);
      if (drop) opts.onDrop(target, lastX, lastY);
      opts.onEnd?.();
    }
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || pointerId !== null) return;
    if ((e.target as HTMLElement).closest("button, input, a, textarea, select, .no-drag")) return;
    pointerId = e.pointerId;
    isTouch = e.pointerType === "touch";
    startX = e.clientX; startY = e.clientY;
    const rect = card.getBoundingClientRect();
    offsetX = startX - rect.left; offsetY = startY - rect.top;
    // Until a drag starts, follow the pointer at window level (no capture).
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    if (isTouch) timer = window.setTimeout(() => { timer = null; begin(); }, LONG_PRESS_MS);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (!dragging) {
      if (isTouch) { if (dist > TOUCH_CANCEL_DISTANCE) end(false); return; }
      if (dist < MOUSE_THRESHOLD) return;
      begin();
    }
    move(e.clientX, e.clientY);
  };

  const onUp = (e: PointerEvent) => { if (e.pointerId === pointerId) end(true); };
  const onCancel = (e: PointerEvent) => { if (e.pointerId === pointerId) end(false); };
  // While dragging on touch, stop the page from scrolling underneath.
  const onTouchMove = (e: TouchEvent) => { if (dragging) e.preventDefault(); };
  const onContext = (e: Event) => { if (dragging || timer !== null) e.preventDefault(); };

  card.addEventListener("pointerdown", onDown);
  card.addEventListener("touchmove", onTouchMove, { passive: false });
  card.addEventListener("contextmenu", onContext);

  return () => { end(false); };
}
