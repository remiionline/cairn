// Small DOM helpers, icons, popup menus, modals and toasts.

type Opts = { cls?: string; text?: string; attr?: Record<string, string>; title?: string };

export function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement | null, tag: K, o: Opts | string = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const opts = typeof o === "string" ? { cls: o } : o;
  if (opts.cls) e.className = opts.cls;
  if (opts.text !== undefined) e.textContent = opts.text;
  if (opts.title) e.title = opts.title;
  // Buttons default to type="submit", which makes Enter in a form trigger the
  // first button (e.g. Cancel). Only explicit submit buttons should submit.
  if (tag === "button") e.setAttribute("type", "button");
  if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

export const div = (parent: HTMLElement | null, cls = "", text?: string) => el(parent, "div", { cls, text });
export const span = (parent: HTMLElement | null, cls = "", text?: string) => el(parent, "span", { cls, text });

export function button(parent: HTMLElement, text: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
  const b = el(parent, "button", { cls, text });
  b.addEventListener("click", onClick);
  return b;
}

export function iconButton(parent: HTMLElement, name: IconName, label: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
  const b = el(parent, "button", { cls: `icon-button ${cls}`, attr: { "aria-label": label }, title: label });
  b.appendChild(icon(name));
  b.addEventListener("click", onClick);
  return b;
}

// Icons (paths adapted from the Lucide icon set, ISC licence).
const ICONS = {
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  kanban: '<path d="M6 5v11M12 5v6M18 5v14"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  sub: '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  reopen: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  listPlus: '<path d="M11 12H3M16 6H3M16 18H3M18 9v6M21 12h-6"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  notes: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M8 13h8M8 17h5"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
  move: '<path d="M5 9 2 12l3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.33 2q2 0 3.67-1.33a1 1 0 0 1 1.6.8v10.6a1 1 0 0 1-.4.8A6 6 0 0 1 16.67 16c-3 0-5-2-7.33-2Q7.33 14 4 15.33"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
};
export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", "icon");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.innerHTML = ICONS[name];
  return s;
}

/** Render task text, turning web addresses into links. */
export function renderText(parent: HTMLElement, text: string) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      const a = el(parent, "a", { text: p, attr: { href: p, target: "_blank", rel: "noreferrer" } });
      a.addEventListener("click", (e) => e.stopPropagation());
    } else if (p) {
      parent.appendChild(document.createTextNode(p));
    }
  });
}

// ---- Popup menu -------------------------------------------------------------

export interface MenuItem { label: string; icon?: IconName; danger?: boolean; onClick: () => void }

export function showMenu(anchor: HTMLElement | MouseEvent, items: (MenuItem | "-")[]) {
  closeMenu();
  const m = div(document.body, "menu");
  for (const it of items) {
    if (it === "-") { div(m, "menu-sep"); continue; }
    const row = el(m, "button", { cls: `menu-item${it.danger ? " menu-danger" : ""}` });
    if (it.icon) row.appendChild(icon(it.icon));
    span(row, "", it.label);
    row.addEventListener("click", () => { closeMenu(); it.onClick(); });
  }
  const r = anchor instanceof MouseEvent
    ? { left: anchor.clientX, right: anchor.clientX, top: anchor.clientY, bottom: anchor.clientY }
    : anchor.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(r.left, innerWidth - mr.width - 4))}px`;
  m.style.top = `${r.bottom + mr.height + 4 > innerHeight ? Math.max(4, r.top - mr.height - 4) : r.bottom + 4}px`;
  (m.querySelector(".menu-item") as HTMLElement | null)?.focus();
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

function onOutside(e: Event) { if (!(e.target as HTMLElement).closest(".menu")) closeMenu(); }
function onKey(e: KeyboardEvent) { if (e.key === "Escape") { e.preventDefault(); closeMenu(); } }

export function closeMenu() {
  document.querySelector(".menu")?.remove();
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
}

// ---- Modals ----------------------------------------------------------------

export function modal(title: string, build: (body: HTMLElement, close: () => void) => void) {
  const bg = div(document.body, "modal-bg");
  const box = div(bg, "modal");
  el(box, "h2", { text: title });
  const body = div(box, "modal-body");
  const close = () => { bg.remove(); document.removeEventListener("keydown", esc, true); };
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  document.addEventListener("keydown", esc, true);
  bg.addEventListener("pointerdown", (e) => { if (e.target === bg) close(); });
  build(body, close);
  (box.querySelector("input, textarea, button.primary") as HTMLElement | null)?.focus();
}

export function confirmDialog(title: string, message: string, confirmText: string, onConfirm: () => void) {
  modal(title, (body, close) => {
    el(body, "p", { text: message });
    const row = div(body, "modal-buttons");
    button(row, "Cancel", close);
    button(row, confirmText, () => { close(); onConfirm(); }, "danger");
  });
}

export interface Field { key: string; label: string; value?: string; placeholder?: string; multiline?: boolean; type?: string }

export function formDialog(title: string, fields: Field[], submitText: string, onSubmit: (v: Record<string, string>) => void) {
  modal(title, (body, close) => {
    const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
    const form = el(body, "form");
    for (const f of fields) {
      const label = el(form, "label", { cls: "field" });
      span(label, "field-label", f.label);
      const input = f.multiline ? el(label, "textarea", { attr: { rows: "3" } }) : el(label, "input", { attr: { type: f.type ?? "text" } });
      input.value = f.value ?? "";
      if (f.placeholder) input.placeholder = f.placeholder;
      inputs[f.key] = input;
    }
    const row = div(form, "modal-buttons");
    button(row, "Cancel", (e) => { e.preventDefault(); close(); });
    el(row, "button", { cls: "primary", text: submitText, attr: { type: "submit" } });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values: Record<string, string> = {};
      for (const [k, i] of Object.entries(inputs)) values[k] = i.value;
      close();
      onSubmit(values);
    });
  });
}

// ---- Toasts ----------------------------------------------------------------

export function toast(message: string, action?: { label: string; onClick: () => void }) {
  let box = document.querySelector<HTMLElement>(".toasts");
  if (!box) box = div(document.body, "toasts");
  const t = div(box, "toast");
  span(t, "toast-text", message);
  if (action) {
    button(t, action.label, () => { t.remove(); action.onClick(); }, "toast-action");
  }
  setTimeout(() => t.remove(), action ? 8000 : 4000);
}
