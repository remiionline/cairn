import type { Api, FileState } from "../shared/api";
import {
  Completion, Data, Op, Project, Status, Task, archivedTasks, completions, countSubtasks, isoDate, newId, openTasks,
  Repeat, RepeatUnit, describeRepeat, dueState, isWaiting, tasksWithDeadlines, locate, nextRepeat, parseIso, today, undoFor, waitingTasks,
} from "../shared/model";
import {
  IconName, button, closeMenu, confirmDialog, div, el, formDialog, icon, iconButton, modal, renderText, showMenu, span, toast,
} from "./dom";
import { makeDraggable } from "./drag";
import { formatDay, renderHeatmap } from "./heatmap";
import { createMockApi } from "./mock";

type Mode = "overview" | "project" | "board" | "history";

interface UiState {
  mode: Mode;
  projectId: string | null;
  /** "all" or a project id. */
  boardProject: string;
  month: string;
  historyDay: string | null;
  projectDay: string | null;
  archiveOpen: boolean;
  /** Sidebar: show archived projects. */
  showArchived: boolean;
}

interface Draft {
  key: string;
  kind: "edit" | "add" | "add-sub";
  value: string;
}

const MODES: { mode: Mode; label: string; icon: IconName }[] = [
  { mode: "overview", label: "Overview", icon: "dashboard" },
  { mode: "board", label: "Board", icon: "kanban" },
  { mode: "history", label: "Calendar", icon: "calendar" },
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UI_KEY = "project-dashboard-ui";

const api: Api = window.api ?? createMockApi();
const root = document.getElementById("app")!;

let fileState: FileState = { status: "nofile" };
let ui: UiState = loadUi();
let draft: Draft | null = null;
let rendering = false;
let cleanups: (() => void)[] = [];
/** Task shown in the details panel, if any. */
let detailId: string | null = null;

const activeProjects = (data: Data) => data.projects.filter((p) => !p.archived);

function loadUi(): UiState {
  const defaults: UiState = {
    mode: "overview", projectId: null, boardProject: "all", month: today().slice(0, 7),
    historyDay: null, projectDay: null, archiveOpen: false, showArchived: false,
  };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(UI_KEY) ?? "{}"), month: defaults.month }; } catch { return defaults; }
}

/** Set when navigating to a different page, so it opens at the top. */
let scrollToTop = false;

function go(patch: Partial<UiState>) {
  if ((patch.mode && patch.mode !== ui.mode) || (patch.projectId !== undefined && patch.projectId !== ui.projectId)) scrollToTop = true;
  ui = { ...ui, ...patch };
  draft = null;
  localStorage.setItem(UI_KEY, JSON.stringify(ui));
  render();
}

// ---- Undo / redo -------------------------------------------------------------
// Each entry is the op that reverses a change (a snapshot of the one project
// it touched), so undo never disturbs other projects edited elsewhere.

interface UndoEntry { op: Op; label: string }
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
const UNDO_LIMIT = 100;

function currentData(): Data | null {
  return fileState.status === "ready" ? fileState.data : null;
}

function taskName(data: Data, id: string): string {
  let found: string | null = null;
  const search = (ts: Task[]) => { for (const t of ts) { if (t.id === id) found = t.text; else search(t.subtasks); } };
  data.projects.forEach((p) => search(p.tasks));
  return found ? `"${found}"` : "task";
}

function describe(op: Op, data: Data): string {
  const proj = (id: string) => `"${data.projects.find((p) => p.id === id)?.name ?? "project"}"`;
  switch (op.type) {
    case "addProject": return `create project "${op.name}"`;
    case "moveProject": return `reorder project ${proj(op.projectId)}`;
    case "updateProject":
      if (op.color !== undefined) return `change the colour of ${proj(op.projectId)}`;
      if (op.archived !== undefined) return `${op.archived ? "archive" : "unarchive"} project ${proj(op.projectId)}`;
      return `edit project ${proj(op.projectId)}`;
    case "deleteProject": return `delete project ${proj(op.projectId)}`;
    case "addTask": return `add "${op.text}"`;
    case "editTask":
      if (op.due !== undefined) return `${op.due ? "set deadline on" : "clear deadline on"} ${taskName(data, op.taskId)}`;
      return op.text === undefined ? `edit notes of ${taskName(data, op.taskId)}` : `rename ${taskName(data, op.taskId)}`;
    case "deleteTask": return `delete ${taskName(data, op.taskId)}`;
    case "setStatus": return `${op.status === "done" ? "complete" : op.status === "doing" ? "start" : "reopen"} ${taskName(data, op.taskId)}`;
    case "moveTask": return `move ${taskName(data, op.taskId)}`;
    case "setRepeat": return op.repeat ? `set ${taskName(data, op.taskId)} to repeat` : `stop repeating ${taskName(data, op.taskId)}`;
    case "wakeTask": return `bring back ${taskName(data, op.taskId)}`;
    default: return "change";
  }
}

async function run(op: Op): Promise<boolean> {
  const before = currentData();
  const inverse = before ? undoFor(before, op) : null;
  const label = before ? describe(op, before) : "change";
  const r = await api.apply(op);
  if (!r.ok) { toast(r.message); return false; }
  if (inverse) {
    undoStack.push({ op: inverse, label });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  if (op.type === "setStatus" && op.status === "done" && before) {
    const l = locate(before, op.taskId);
    if (l && !l.ancestors.length && l.task.repeat && l.task.status !== "done") {
      toast(`"${l.task.text}" will come back ${whenBack(nextRepeat(today(), l.task.repeat))}`, { label: "Undo", onClick: () => undo() });
    }
  }
  if (op.type === "deleteTask" || op.type === "deleteProject") {
    toast(`Deleted ${label.replace(/^delete (project )?/, "")}`, { label: "Undo", onClick: () => undo() });
  }
  refreshHistoryButtons();
  return true;
}

async function stepHistory(from: UndoEntry[], to: UndoEntry[], verb: string) {
  const data = currentData();
  const entry = from[from.length - 1];
  if (!entry || !data) return;
  from.pop();
  const reverse = undoFor(data, entry.op);
  const r = await api.apply(entry.op);
  if (!r.ok) { toast(r.message); refreshHistoryButtons(); return; }
  if (reverse) to.push({ op: reverse, label: entry.label });
  draft = null;
  toast(`${verb}: ${entry.label}`);
  refreshHistoryButtons();
}
const undo = () => stepHistory(undoStack, redoStack, "Undone");
const redo = () => stepHistory(redoStack, undoStack, "Redone");

/** The undo/redo buttons live in the top bar; update them without a re-render. */
function refreshHistoryButtons() {
  const u = root.querySelector<HTMLButtonElement>(".undo-button");
  const r = root.querySelector<HTMLButtonElement>(".redo-button");
  const top = (st: UndoEntry[]) => st[st.length - 1];
  if (u) { u.disabled = !undoStack.length; u.title = undoStack.length ? `Undo ${top(undoStack).label} (Ctrl+Z)` : "Nothing to undo"; }
  if (r) { r.disabled = !redoStack.length; r.title = redoStack.length ? `Redo ${top(redoStack).label} (Ctrl+Y)` : "Nothing to redo"; }
}

/** Colours offered in the picker: distinct in both themes. */
const PROJECT_COLORS: [string, string][] = [
  ["#6c7cf0", "Blue"], ["#9b6cf0", "Violet"], ["#e05cc2", "Pink"], ["#ef5b5b", "Red"],
  ["#f08a4b", "Orange"], ["#e8b93c", "Amber"], ["#8cc63f", "Lime"], ["#3cc47c", "Green"],
  ["#2bb7a8", "Teal"], ["#3aa6e8", "Sky"], ["#a0785a", "Brown"], ["#8a94a6", "Slate"],
];

function projectColor(p: Project): string {
  if (p.color) return p.color;
  let h = 0;
  for (const ch of p.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 55%, 58%)`;
}

function shortDate(iso: string): string {
  const d = parseIso(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

/** "today", "tomorrow", "in 5 days" (or a date further out). */
function whenBack(iso: string): string {
  const days = Math.round((parseIso(iso).getTime() - parseIso(today()).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  return `on ${shortDate(iso)}`;
}

const DAY_MS = 86400000;
const daysBetween = (from: string, to: string) => Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / DAY_MS);
const addDays = (iso: string, n: number) => { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoDate(d); };

/** Short deadline label for badges: "Today", "Tomorrow", "Fri", "Nov 20", "3d overdue". */
function dueLabel(due: string): string {
  const n = daysBetween(today(), due);
  if (n < 0) return n === -1 ? "1d overdue" : `${-n}d overdue`;
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n < 7) return parseIso(due).toLocaleDateString(undefined, { weekday: "short" });
  return shortDate(due);
}

function dueBadge(parent: HTMLElement, due: string) {
  const b = el(parent, "span", { cls: `badge due due-${dueState(due)}`, title: `Deadline: ${formatDay(due)}` });
  b.appendChild(icon("flag"));
  span(b, "", dueLabel(due));
  return b;
}

function shortRepeat(r: Repeat): string {
  if (r.every === 1) return { day: "Daily", week: "Weekly", month: "Monthly" }[r.unit];
  return `${r.every}${{ day: "d", week: "w", month: "mo" }[r.unit]}`;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Top-level rendering
// ---------------------------------------------------------------------------

function render() {
  rendering = true;
  const scroll = scrollToTop ? 0 : root.querySelector(".main")?.scrollTop ?? 0;
  scrollToTop = false;
  cleanups.forEach((f) => f());
  cleanups = [];
  root.replaceChildren();

  if (fileState.status !== "ready") {
    closeDrawer();
    renderFileScreen(fileState);
    rendering = false;
    return;
  }
  const data = fileState.data;
  const shell = div(root, "shell");
  renderSidebar(shell, data, fileState.file);
  const col = div(shell, "main-col");
  const top = div(col, "topbar");
  const main = div(col, "main");
  const body = div(main, `body body-${ui.mode}`);
  if (data.projects.length === 0) { renderTopbar(top, "Welcome"); renderEmpty(body); }
  else if (ui.mode === "overview") renderOverview(top, body, data);
  else if (ui.mode === "project") renderProject(top, body, data);
  else if (ui.mode === "board") renderBoard(top, body, data);
  else { renderTopbar(top, "Calendar", "What you finished, and deadlines coming up"); renderHistory(body, data); }
  refreshHistoryButtons();
  renderDrawer();

  main.scrollTop = scroll;
  const focus = root.querySelector<HTMLInputElement>("[data-focus]");
  if (focus) { focus.focus(); focus.setSelectionRange(focus.value.length, focus.value.length); }
  rendering = false;
}

function renderFileScreen(s: Exclude<FileState, { status: "ready" }>) {
  const box = div(div(root, "setup"), "setup-box");
  el(box, "h1", { text: "Cairn" });
  if (s.status === "nofile") {
    el(box, "p", { text: "All your projects and tasks are kept in a single data file. Put it somewhere every computer you use can reach, like a shared drive (e.g. D:\\) or a USB stick, and point the app at it on each machine." });
  } else if (s.status === "missing") {
    el(box, "p", { cls: "warn", text: "Can't find your data file:" });
    el(box, "code", { text: s.file });
    el(box, "p", { text: "If it's on a drive that isn't connected or mounted yet, connect it and click Try again." });
  } else {
    el(box, "p", { cls: "warn", text: "Couldn't open your data file:" });
    el(box, "code", { text: s.file });
    el(box, "p", { text: s.message });
    el(box, "p", { cls: "muted small", text: "Dated backups are kept in the \".backups\" folder next to the file." });
  }
  const row = div(box, "setup-buttons");
  if (s.status !== "nofile") button(row, "Try again", () => api.retry(), "primary");
  button(row, "Create new data file…", async () => { const r = await api.createFile(); if (!r.ok) toast(r.message); }, s.status === "nofile" ? "primary" : "");
  button(row, s.status === "nofile" ? "Open existing data file…" : "Locate data file…", async () => {
    const r = await api.openFile(); if (!r.ok) toast(r.message);
  });
}

function renderSidebar(parent: HTMLElement, data: Data, file: string) {
  const side = div(parent, "sidebar");
  const brand = div(side, "brand");
  el(brand, "img", { cls: "brand-mark", attr: { src: "icon.png", alt: "" } });
  span(brand, "brand-name label", "Cairn");

  const nav = div(side, "side-nav");
  for (const m of MODES) {
    const b = el(nav, "button", { cls: `side-item${ui.mode === m.mode ? " active" : ""}`, attr: { "data-mode": m.mode }, title: m.label });
    b.appendChild(icon(m.icon));
    span(b, "label", m.label);
    b.addEventListener("click", () => go({ mode: m.mode }));
  }

  const head = div(side, "side-head");
  span(head, "label", "Projects");
  iconButton(head, "plus", "New project (Shift+N)", () => newProject(), "side-add");
  const list = div(side, "side-projects");
  const current = data.projects.find((q) => q.id === ui.projectId) ?? data.projects[0];
  const projectItem = (p: Project) => {
    const active = ui.mode === "project" && p === current;
    const b = el(list, "button", {
      cls: `side-item side-project${active ? " active" : ""}${p.archived ? " archived" : ""}`,
      attr: { "data-mode": "project", "data-project": p.id }, title: p.name,
    });
    b.style.setProperty("--project-color", projectColor(p));
    span(b, "project-dot");
    span(b, "label side-project-name", p.name);
    const n = openTasks(p).length;
    if (n && !p.archived) span(b, "label side-count", String(n));
    b.addEventListener("click", () => go({ mode: "project", projectId: p.id, projectDay: null }));
    enableProjectDrag(b, p);
  };
  activeProjects(data).forEach(projectItem);
  if (!data.projects.length) div(list, "label side-empty", "No projects yet");
  const archived = data.projects.filter((p) => p.archived);
  if (archived.length) {
    const toggle = el(list, "button", { cls: "side-item side-archived-toggle", title: "Archived projects" });
    toggle.appendChild(icon(ui.showArchived ? "chevronDown" : "right"));
    span(toggle, "label", `Archived (${archived.length})`);
    toggle.addEventListener("click", () => go({ showArchived: !ui.showArchived }));
    if (ui.showArchived || (ui.mode === "project" && current?.archived)) archived.forEach(projectItem);
  }

  const foot = div(side, "side-foot");
  const jump = el(foot, "button", { cls: "side-item", title: "Jump to a project or task (Ctrl+K)" });
  jump.appendChild(icon("search"));
  span(jump, "label", "Jump to…");
  span(jump, "label kbd", "Ctrl K");
  jump.addEventListener("click", () => openSwitcher());
  const fileBtn = el(foot, "button", { cls: "side-item file-button", title: file });
  fileBtn.appendChild(icon("file"));
  span(fileBtn, "label file-name", file.split(/[\\/]/).pop() ?? file);
  fileBtn.addEventListener("click", () => showMenu(fileBtn, [
    { label: "Show data file in folder", icon: "folder", onClick: () => api.revealFile() },
    { label: "Open another data file…", icon: "file", onClick: async () => { const r = await api.openFile(); if (!r.ok) toast(r.message); } },
    { label: "Create new data file…", icon: "plus", onClick: async () => { const r = await api.createFile(); if (!r.ok) toast(r.message); } },
    "-",
    { label: "Keyboard shortcuts", icon: "keyboard", onClick: () => shortcutsDialog() },
    { label: "Settings…", icon: "sliders", onClick: () => settingsDialog(data) },
  ]));
}

/** Page title on the left; returns the actions slot. Undo/redo sit at the far right. */
function renderTopbar(top: HTMLElement, title: string, sub?: string, color?: string, onDot?: () => void): HTMLElement {
  const t = div(top, "page-title");
  if (color) {
    t.style.setProperty("--project-color", color);
    const dot = span(t, "project-dot big");
    if (onDot) { dot.classList.add("clickable"); dot.title = "Change colour"; dot.addEventListener("click", onDot); }
  }
  const words = div(t, "page-words");
  el(words, "h1", { text: title, title });
  if (sub) span(words, "page-sub", sub);
  const actions = div(top, "top-actions");
  const history = div(top, "history-buttons");
  iconButton(history, "undo", "Undo (Ctrl+Z)", () => undo(), "undo-button");
  iconButton(history, "redo", "Redo (Ctrl+Y)", () => redo(), "redo-button");
  return actions;
}

function renderEmpty(body: HTMLElement) {
  const e = div(body, "empty");
  el(e, "h2", { text: "No projects yet" });
  el(e, "p", { text: "A project can be anything: a game, a program, a renovation, chores, a photo edit." });
  button(e, "New project", () => newProject(), "primary");
}

function newProject() {
  formDialog("New project", [
    { key: "name", label: "Name", placeholder: "e.g. Kitchen repaint" },
    { key: "description", label: "Description (optional)", multiline: true },
  ], "Create", async (v) => {
    const id = newId();
    const r = await api.apply({ type: "addProject", id, name: v.name, description: v.description });
    if (!r.ok) { toast(r.message); return; }
    go({ mode: "project", projectId: id, projectDay: null });
    // Put the cursor straight into the new project's "Add a task" box.
    draft = { key: `new:${id}`, kind: "add", value: "" };
    render();
  });
}

function settingsDialog(data: Data) {
  formDialog("Settings", [
    { key: "days", label: "Board: show tasks completed in the last N days", value: String(data.settings.boardDoneDays), type: "number" },
  ], "Save", (v) => {
    const n = parseInt(v.days, 10);
    if (isNaN(n) || n < 0) { toast("Please enter a number of days (0 or more)."); return; }
    run({ type: "updateSettings", settings: { boardDoneDays: n } });
  });
}

function sectionTitle(parent: HTMLElement, text: string, extra?: string) {
  const h = div(parent, "section-title");
  span(h, "", text);
  if (extra) span(h, "muted", extra);
  return h;
}

// ---------------------------------------------------------------------------
// Inline inputs (add / edit tasks without dialogs)
// ---------------------------------------------------------------------------

function inlineInput(parent: HTMLElement, key: string, kind: Draft["kind"], placeholder: string, initial: string,
  onSubmit: (value: string) => void, persistent = false): HTMLInputElement {
  const input = el(parent, "input", { cls: "inline-input", attr: { type: "text", placeholder } });
  const mine = draft !== null && draft.key === key && draft.kind === kind;
  input.value = mine ? draft!.value : initial;
  if (mine) input.setAttribute("data-focus", "");
  const close = () => { draft = null; render(); };

  input.addEventListener("focus", () => {
    if (!draft || draft.key !== key || draft.kind !== kind) draft = { key, kind, value: input.value };
  });
  input.addEventListener("input", () => { if (draft) draft.value = input.value; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { if (!persistent) close(); return; }
      if (kind === "edit") draft = null;
      else { draft = { key, kind, value: "" }; input.value = ""; } // stay open for the next one
      onSubmit(v);
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      close();
    }
  });
  input.addEventListener("blur", () => {
    if (rendering || !draft || draft.key !== key) return;
    const v = input.value.trim();
    if (kind === "edit" && v && v !== initial) { draft = null; onSubmit(v); return; }
    if (persistent && v) return; // keep half-typed text
    draft = null;
    if (!persistent) render();
  });
  return input;
}

function addTaskInput(parent: HTMLElement, p: Project, placeholder = "Add a task…") {
  const row = div(parent, "add-row");
  row.appendChild(icon("plus"));
  inlineInput(row, `new:${p.id}`, "add", placeholder, "", (v) => run({ type: "addTask", projectId: p.id, id: newId(), text: v }), true);
}

// ---------------------------------------------------------------------------
// Task rows
// ---------------------------------------------------------------------------

function renderTask(container: HTMLElement, p: Project, t: Task, hideDone: boolean, reorder = true) {
  if (hideDone && t.status === "done") return;
  const row = div(container, "task");
  row.dataset.status = t.status;
  row.dataset.id = t.id;
  const line = div(row, "task-line");
  if (reorder) {
    row.dataset.drop = "1";
    row.dataset.project = p.id;
    span(line, "grip", "").appendChild(icon("grip"));
    enableTaskDrag(row, line, t);
  }

  const cb = el(line, "input", { cls: "check", attr: { type: "checkbox", "aria-label": "Done" } });
  cb.checked = t.status === "done";
  cb.addEventListener("change", () => run({ type: "setStatus", taskId: t.id, status: cb.checked ? "done" : "todo" }));

  if (draft?.kind === "edit" && draft.key === t.id) {
    inlineInput(line, t.id, "edit", "Task", t.text, (v) => run({ type: "editTask", taskId: t.id, text: v }));
  } else {
    const text = span(line, "task-text clickable", "");
    text.title = "Open details";
    renderText(text, t.text);
    text.addEventListener("click", () => openDetails(t.id));
  }

  const meta = div(line, "task-meta");
  if (t.notes) {
    const n = el(meta, "span", { cls: "notes-mark clickable", title: t.notes.slice(0, 300) });
    n.appendChild(icon("notes"));
    n.addEventListener("click", () => openDetails(t.id));
  }
  if (t.due && t.status !== "done") dueBadge(meta, t.due);
  if (t.repeat && t.status !== "done") {
    const b = el(meta, "span", { cls: "badge repeat", title: describeRepeat(t.repeat) });
    b.appendChild(icon("repeat"));
    span(b, "", shortRepeat(t.repeat));
  }
  if (t.status === "doing") el(meta, "span", { cls: "badge doing", text: "In progress", title: "In progress" });
  if (t.subtasks.length) {
    const c = countSubtasks(t);
    el(meta, "span", { cls: "badge", text: `${c.done}/${c.total}`, title: "Subtasks done" });
  }
  if (t.status === "done" && t.completed) span(meta, "date", shortDate(t.completed));
  if (reorder && t.status !== "done") {
    iconButton(line, "listPlus", "Add subtask", () => { draft = { key: t.id, kind: "add-sub", value: "" }; render(); }, "row-action add-sub-button");
  }
  iconButton(line, "more", "Task actions", (e) => taskMenu(e, p, t), "more");

  const kids = t.subtasks.filter((c) => !(hideDone && c.status === "done"));
  const addingHere = draft?.kind === "add-sub" && draft.key === t.id;
  if (kids.length || addingHere) {
    const childEl = div(row, "children");
    for (const c of kids) renderTask(childEl, p, c, hideDone, reorder);
    if (addingHere) {
      const r = div(childEl, "add-row");
      r.appendChild(icon("sub"));
      inlineInput(r, t.id, "add-sub", "Add a subtask…", "", (v) => run({ type: "addTask", projectId: p.id, id: newId(), text: v, parentId: t.id }));
    }
  }
}

/** Drag a project in the sidebar up or down to reorder it. */
function enableProjectDrag(item: HTMLElement, p: Project) {
  let place: { id: string; after: boolean } | null = null;
  cleanups.push(makeDraggable(item, {
    dropSelector: (hit) => {
      const target = hit?.closest<HTMLElement>(".side-project") ?? null;
      return target && target !== item && !!target.classList.contains("archived") === !!p.archived ? target : null;
    },
    onMove: (target, _x, y) => {
      clearDropMarks();
      place = null;
      if (!target) return;
      const r = target.getBoundingClientRect();
      const after = y > r.top + r.height / 2;
      place = { id: target.dataset.project!, after };
      target.classList.remove("drop-over");
      target.classList.add(after ? "drop-after" : "drop-before");
    },
    onDrop: () => {
      const data = currentData();
      if (!place || !data) return;
      const list = data.projects;
      const i = list.findIndex((x) => x.id === place!.id);
      const beforeId = place.after ? list[i + 1]?.id ?? null : place.id;
      const own = list.findIndex((x) => x.id === p.id);
      if (beforeId === p.id || beforeId === (list[own + 1]?.id ?? null)) return;
      run({ type: "moveProject", projectId: p.id, beforeId });
    },
    onEnd: clearDropMarks,
  }));
}

/** Pick a project's colour: a palette plus "Automatic". */
function colorDialog(p: Project) {
  modal(`Colour for "${p.name}"`, (body, close) => {
    const grid = div(body, "swatches");
    const pick = (color: string | null) => {
      close();
      if ((color ?? undefined) !== p.color) run({ type: "updateProject", projectId: p.id, color });
    };
    for (const [hex, name] of PROJECT_COLORS) {
      const b = el(grid, "button", { cls: `swatch${p.color === hex ? " selected" : ""}`, attr: { "aria-label": name }, title: name });
      b.style.setProperty("--swatch", hex);
      b.addEventListener("click", () => pick(hex));
    }
    const row = div(body, "modal-buttons swatch-buttons");
    const auto = button(row, "Automatic", () => pick(null), p.color ? "" : "active");
    auto.title = "A colour picked from the project's id";
    const custom = el(row, "label", { cls: "swatch-custom", title: "Any colour" });
    span(custom, "", "Custom…");
    const input = el(custom, "input", { attr: { type: "color", "aria-label": "Custom colour" } });
    input.value = p.color ?? "#6c7cf0";
    input.addEventListener("change", () => pick(input.value));
    button(row, "Cancel", close);
  });
}

type DropPlace =
  | { kind: "row"; id: string; where: "before" | "after" | "into" }
  | { kind: "project"; projectId: string };

/** Turn a drop position into a moveTask op, or null when nothing would change. */
function moveOpFor(t: Task, place: DropPlace): Op | null {
  const data = currentData();
  const me = data && locate(data, t.id);
  if (!data || !me) return null;
  const myParent = me.ancestors[me.ancestors.length - 1]?.id ?? null;
  if (place.kind === "project") {
    if (place.projectId === me.project.id && myParent === null) return null;
    return { type: "moveTask", taskId: t.id, projectId: place.projectId, parentId: null, beforeId: null };
  }
  const target = locate(data, place.id);
  if (!target || target.task === t || target.ancestors.includes(me.task)) return null;
  if (place.where === "into") {
    if (target.task.id === myParent) return null;
    return { type: "moveTask", taskId: t.id, projectId: target.project.id, parentId: target.task.id, beforeId: null };
  }
  const parentId = target.ancestors[target.ancestors.length - 1]?.id ?? null;
  const i = target.siblings.indexOf(target.task);
  const beforeId = place.where === "before" ? target.task.id : target.siblings[i + 1]?.id ?? null;
  if (target.siblings === me.siblings) {
    const own = me.siblings.indexOf(me.task);
    if (beforeId === t.id || beforeId === (me.siblings[own + 1]?.id ?? null)) return null;
    return { type: "moveTask", taskId: t.id, beforeId };
  }
  return { type: "moveTask", taskId: t.id, projectId: target.project.id, parentId, beforeId };
}

const clearDropMarks = () => document.querySelectorAll(".drop-before, .drop-after, .drop-into")
  .forEach((e) => e.classList.remove("drop-before", "drop-after", "drop-into"));

/**
 * Drag a task row: drop above/below another task to put it there (any level,
 * any project), onto the middle of a task to make it a subtask, or onto a
 * project (sidebar entry, overview card) to move it to that project.
 */
function enableTaskDrag(row: HTMLElement, line: HTMLElement, t: Task) {
  let op: Op | null = null;
  cleanups.push(makeDraggable(line, {
    dropSelector: (hit) => {
      if (!hit) return null;
      const target = hit.closest<HTMLElement>(".task[data-drop]");
      if (target) return row.contains(target) ? null : target;
      return hit.closest<HTMLElement>("[data-drop-project], .side-project");
    },
    onMove: (target, _x, y) => {
      clearDropMarks();
      op = null;
      if (!target) return;
      let place: DropPlace;
      let mark: HTMLElement = target;
      if (target.classList.contains("task")) {
        mark = target.querySelector<HTMLElement>(":scope > .task-line")!;
        const r = mark.getBoundingClientRect();
        const f = (y - r.top) / r.height;
        place = { kind: "row", id: target.dataset.id!, where: f < 0.3 ? "before" : f > 0.7 ? "after" : "into" };
      } else {
        place = { kind: "project", projectId: target.dataset.project ?? target.dataset.dropProject! };
      }
      op = moveOpFor(t, place);
      if (op && place.kind === "row") mark.classList.add(`drop-${place.where}`);
      if (!op) target.classList.remove("drop-over");
    },
    onDrop: () => { if (op) run(op); },
    onEnd: () => { clearDropMarks(); op = null; },
  }));
}

/** Same-list position for board cards (reorder within a column). */
function beforeIdFor(taskId: string, targetId: string, after: boolean): string | null | undefined {
  const data = currentData();
  const l = data && locate(data, targetId);
  if (!l || targetId === taskId) return undefined;
  const i = l.siblings.indexOf(l.task);
  const beforeId = after ? l.siblings[i + 1]?.id ?? null : targetId;
  const own = l.siblings.findIndex((x) => x.id === taskId);
  if (own < 0) return undefined;
  if (beforeId === taskId || beforeId === (l.siblings[own + 1]?.id ?? null)) return undefined;
  return beforeId;
}

function taskMenu(e: MouseEvent, p: Project, t: Task) {
  const set = (status: Status) => () => run({ type: "setStatus", taskId: t.id, status });
  const startEditing = (kind: Draft["kind"]) => () => {
    if (ui.mode === "board") go({ mode: "project", projectId: p.id });
    draft = { key: t.id, kind, value: kind === "edit" ? t.text : "" };
    render();
  };
  showMenu(e, [
    ...(t.status === "done"
      ? [{ label: "Reopen", icon: "reopen" as IconName, onClick: set("todo") }]
      : [
        { label: "Complete", icon: "check" as IconName, onClick: set("done") },
        t.status === "doing"
          ? { label: "Stop working on it", icon: "pause" as IconName, onClick: set("todo") }
          : { label: "Start working on it", icon: "play" as IconName, onClick: set("doing") },
      ]),
    "-",
    { label: "Details & notes", icon: "notes", onClick: () => openDetails(t.id) },
    { label: "Add subtask", icon: "listPlus", onClick: startEditing("add-sub") },
    { label: "Rename", icon: "pencil", onClick: startEditing("edit") },
    { label: "Move to…", icon: "move", onClick: () => moveDialog(t) },
    "-",
    {
      // No confirmation: deleting can be undone (toast button or Ctrl+Z).
      label: "Delete", icon: "trash", danger: true, onClick: () => { run({ type: "deleteTask", taskId: t.id }); },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function countByDay(cs: Completion[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cs) m.set(c.date, (m.get(c.date) ?? 0) + 1);
  return m;
}

function renderCompletionList(parent: HTMLElement, cs: Completion[], showProject: boolean) {
  const list = div(parent, "completion-list");
  for (const c of cs) {
    const item = div(list, "completion");
    span(item, "completion-check").appendChild(icon("check"));
    const body = div(item, "completion-body");
    renderText(span(body, "task-text"), c.task.text);
    const sub = div(body, "muted small completion-sub");
    if (showProject) {
      const chip = span(sub, "chip clickable", c.project.name);
      chip.style.setProperty("--project-color", projectColor(c.project));
      chip.addEventListener("click", () => go({ mode: "project", projectId: c.project.id }));
    }
    if (c.parent) span(sub, "", `subtask of ${c.parent.text}`);
  }
}

function projectStats(p: Project): string {
  const open = openTasks(p);
  const doing = open.filter((t) => t.status === "doing").length;
  const waiting = waitingTasks(p).length;
  return `${open.length} open${doing ? ` · ${doing} in progress` : ""}${waiting ? ` · ${waiting} coming back` : ""}`;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function renderOverview(top: HTMLElement, body: HTMLElement, data: Data) {
  const projects = activeProjects(data);
  const totalOpen = projects.reduce((n, p) => n + openTasks(p).length, 0);
  const actions = renderTopbar(top, "Overview", `${plural(projects.length, "project")} · ${plural(totalOpen, "open task")}`);
  const add = button(actions, "", () => newProject(), "primary");
  add.appendChild(icon("plus"));
  span(add, "", "New project");

  const cs = completions(data.projects);
  sectionTitle(body, "Activity");
  renderHeatmap(body, { counts: countByDay(cs), onSelect: (day) => go({ mode: "history", month: day.slice(0, 7), historyDay: day }) });

  const soon = tasksWithDeadlines(projects).filter((x) => dueState(x.task.due!) !== "later");
  if (soon.length) {
    sectionTitle(body, "Due soon", `${soon.length} in the next 7 days or overdue`);
    const list = div(body, "due-list");
    for (const { project, task, path } of soon) {
      const row = div(list, "due-row");
      row.style.setProperty("--project-color", projectColor(project));
      const cb = el(row, "input", { cls: "check", attr: { type: "checkbox", "aria-label": "Done" } });
      cb.addEventListener("change", () => run({ type: "setStatus", taskId: task.id, status: "done" }));
      const words = div(row, "due-words");
      const name = span(words, "task-text clickable", "");
      renderText(name, task.text);
      name.addEventListener("click", () => openDetails(task.id));
      const where = div(words, "due-where");
      span(where, "chip", project.name);
      if (path.length) span(where, "", `› ${path.map((x) => x.text).join(" › ")}`);
      dueBadge(row, task.due!);
    }
  }

  sectionTitle(body, "Projects");
  if (!projects.length) div(body, "muted nothing", "All projects are archived. Open one from the sidebar, or create a new one.");
  const grid = div(body, "project-grid");
  for (const p of projects) {
    const card = div(grid, "card");
    card.dataset.dropProject = p.id;
    card.style.setProperty("--project-color", projectColor(p));
    const head = div(card, "card-head");
    const title = div(head, "card-title clickable");
    span(title, "project-dot");
    span(title, "", p.name);
    title.addEventListener("click", () => go({ mode: "project", projectId: p.id, projectDay: null }));
    div(head, "card-stats", projectStats(p));
    const list = div(card, "task-list");
    const open = openTasks(p);
    for (const t of open) renderTask(list, p, t, true);
    if (!open.length) div(list, "muted small nothing", "No open tasks.");
    addTaskInput(card, p);
  }
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

function renderProject(top: HTMLElement, body: HTMLElement, data: Data) {
  const p = data.projects.find((x) => x.id === ui.projectId) ?? data.projects[0];
  const actions = renderTopbar(top, p.name, p.archived ? "Archived" : projectStats(p), projectColor(p), () => colorDialog(p));
  const setArchived = async (archived: boolean) => {
    if (await run({ type: "updateProject", projectId: p.id, archived })) {
      toast(archived ? `Archived "${p.name}"` : `Restored "${p.name}"`, { label: "Undo", onClick: () => undo() });
    }
  };
  if (!p.archived) {
    const boardBtn = button(actions, "", () => go({ mode: "board", boardProject: p.id }));
    boardBtn.appendChild(icon("kanban"));
    span(boardBtn, "", "Board");
  }
  iconButton(actions, "more", "Project actions", (e) => showMenu(e, [
    {
      label: "Rename / edit description", icon: "pencil", onClick: () => formDialog("Edit project", [
        { key: "name", label: "Name", value: p.name },
        { key: "description", label: "Description", value: p.description, multiline: true },
      ], "Save", (v) => run({ type: "updateProject", projectId: p.id, name: v.name, description: v.description })),
    },
    { label: "Change colour…", icon: "palette", onClick: () => colorDialog(p) },
    p.archived
      ? { label: "Unarchive project", icon: "reopen", onClick: () => setArchived(false) }
      : { label: "Archive project", icon: "archive", onClick: () => setArchived(true) },
    "-",
    {
      label: "Delete project", icon: "trash", danger: true, onClick: () => {
        const n = p.tasks.length;
        confirmDialog("Delete project", `Delete "${p.name}"${n ? ` and all ${plural(n, "task")} in it, including its completion history` : ""}? You can undo this right afterwards with Ctrl+Z.`,
          "Delete project", () => { run({ type: "deleteProject", projectId: p.id }); go({ mode: "overview", projectId: null }); });
      },
    },
  ]));

  if (p.archived) {
    const banner = div(body, "archived-banner");
    banner.appendChild(icon("archive"));
    span(banner, "", "This project is archived. It's hidden from the overview and board, and its history stays in the calendar.");
    button(banner, "Unarchive", () => setArchived(false));
  }
  if (p.description) div(body, "description", p.description);

  const cs = completions([p]);
  sectionTitle(body, "Activity");
  renderHeatmap(body, {
    counts: countByDay(cs),
    selected: ui.projectDay,
    onSelect: (day) => go({ projectDay: ui.projectDay === day ? null : day }),
  });
  if (ui.projectDay) {
    const day = ui.projectDay;
    const box = div(body, "day-detail");
    const h = div(box, "day-title", formatDay(day));
    iconButton(h, "x", "Close", () => go({ projectDay: null }));
    const onDay = cs.filter((c) => c.date === day);
    if (onDay.length) renderCompletionList(box, onDay, false);
    else div(box, "muted small", "Nothing completed this day.");
  }

  const open = openTasks(p);
  sectionTitle(body, "Tasks", projectStats(p));
  const list = div(body, "task-list");
  list.dataset.dropProject = p.id;
  for (const t of open) renderTask(list, p, t, false);
  if (!open.length) div(list, "muted small nothing", "No open tasks. Add one below.");
  addTaskInput(body, p);

  const waiting = waitingTasks(p);
  if (waiting.length) {
    sectionTitle(body, "Coming back", "Repeating tasks reappear here on their day");
    const wl = div(body, "waiting-list");
    for (const t of waiting) {
      const row = div(wl, "waiting-row");
      row.appendChild(icon("repeat"));
      const name = span(row, "task-text clickable", "");
      renderText(name, t.text);
      name.addEventListener("click", () => openDetails(t.id));
      el(row, "span", { cls: "waiting-when", text: `back ${whenBack(t.waitUntil!)}`, title: `${describeRepeat(t.repeat ?? { every: 1, unit: "day" })} · back ${shortDate(t.waitUntil!)}` });
      button(row, "Bring back now", () => run({ type: "wakeTask", taskId: t.id }), "small-button");
    }
  }

  const archive = archivedTasks(p);
  const details = el(body, "details", { cls: "archive" });
  details.open = ui.archiveOpen;
  details.addEventListener("toggle", () => { ui.archiveOpen = details.open; localStorage.setItem(UI_KEY, JSON.stringify(ui)); });
  el(details, "summary", { text: `Completed (${archive.length})` });
  const alist = div(details, "task-list");
  for (const t of archive) renderTask(alist, p, t, false, false);
  if (!archive.length) div(alist, "muted small nothing", "Completed tasks are archived here with their completion date.");
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function renderBoard(top: HTMLElement, body: HTMLElement, data: Data) {
  const bar = renderTopbar(top, "Board", "Drag cards between columns, or up and down to reorder");
  const select = el(bar, "select", { attr: { "aria-label": "Project" } });
  el(select, "option", { text: "All projects", attr: { value: "all" } });
  for (const q of activeProjects(data)) el(select, "option", { text: q.name, attr: { value: q.id } });
  const single = activeProjects(data).find((p) => p.id === ui.boardProject);
  select.value = single ? single.id : "all";
  select.addEventListener("change", () => go({ boardProject: select.value }));

  const projects = single ? [single] : activeProjects(data);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - data.settings.boardDoneDays);
  const cutoffIso = isoDate(cutoff);

  // Only "leaf" tasks go on the board: a task that has been split into
  // subtasks is represented by its subtasks, which carry the master's name.
  type Card = { p: Project; t: Task; path: Task[] };
  const cols: { status: Status; title: string; cards: Card[] }[] = [
    { status: "todo", title: "To do", cards: [] },
    { status: "doing", title: "In progress", cards: [] },
    { status: "done", title: "Done", cards: [] },
  ];
  const place = (p: Project, t: Task, path: Task[]) => {
    if (isWaiting(t)) return;
    if (t.subtasks.length) { for (const c of t.subtasks) place(p, c, [...path, t]); return; }
    if (t.status === "done") { if (t.completed && t.completed >= cutoffIso) cols[2].cards.push({ p, t, path }); }
    else cols[t.status === "doing" ? 1 : 0].cards.push({ p, t, path });
  };
  for (const p of projects) for (const t of p.tasks) place(p, t, []);
  cols[2].cards.sort((a, b) => (b.t.completed ?? "").localeCompare(a.t.completed ?? ""));

  const board = div(body, "board");
  for (const col of cols) {
    const colEl = div(board, "col");
    colEl.dataset.status = col.status;
    const h = div(colEl, "col-head");
    span(h, "col-title", col.title);
    span(h, "col-count", String(col.cards.length));
    const list = div(colEl, "col-list");
    for (const { p, t, path } of col.cards) renderCard(list, p, t, path, !single);
    if (!col.cards.length) div(list, "col-empty", col.status === "doing" ? "Drag a card here when you start on it" : col.status === "done" ? "Nothing finished recently" : "Nothing to do");
    if (col.status === "done") div(list, "col-foot", `Completed in the last ${plural(data.settings.boardDoneDays, "day")}`);
    if (col.status === "todo" && single) addTaskInput(colEl, single);
  }
}

function renderCard(list: HTMLElement, p: Project, t: Task, path: Task[], showProject: boolean) {
  const card = div(list, `kcard${path.length ? " sub" : ""}`);
  card.style.setProperty("--project-color", projectColor(p));
  card.dataset.status = t.status;
  card.dataset.id = t.id;
  if (path.length) {
    // Full-width bar naming the master task (and any middle levels).
    const master = path[0];
    const names = path.map((x) => x.text).join("  ›  ");
    const bar = el(card, "div", { cls: "kcard-parent", title: names });
    bar.appendChild(icon("sub"));
    span(bar, "kcard-parent-name", names);
    const mc = countSubtasks(master);
    el(bar, "span", { cls: "kcard-parent-count", text: `${mc.done}/${mc.total}`, title: "Subtasks of the master task done" });
  }
  const top = div(card, "kcard-top");
  if (showProject) span(top, "chip", p.name);
  if (t.notes) el(top, "span", { cls: "notes-mark", title: t.notes.slice(0, 300) }).appendChild(icon("notes"));
  card.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("button, a")) openDetails(t.id); });
  if (t.status !== "done") {
    iconButton(top, "listPlus", "Add subtask", () => { draft = { key: `drawer:${t.id}`, kind: "add-sub", value: "" }; openDetails(t.id); }, "row-action add-sub-button");
  }
  iconButton(top, "more", "Task actions", (e) => taskMenu(e, p, t), "more");
  renderText(div(card, "kcard-text task-text"), t.text);

  const c = countSubtasks(t);
  const showDue = !!t.due && t.status !== "done";
  if (c.total || t.completed || showDue) {
    const foot = div(card, "kcard-foot");
    if (showDue) dueBadge(foot, t.due!);
    if (c.total) {
      const prog = el(foot, "div", { cls: "progress", title: `${c.done} of ${c.total} subtasks done` });
      div(prog, "progress-fill").style.width = `${(c.done / c.total) * 100}%`;
      span(foot, "small muted", `${c.done}/${c.total}`);
    }
    if (t.status === "done" && t.completed) span(foot, "date", shortDate(t.completed));
  }

  // Between columns: change status. Within To do / In progress: reorder among
  // siblings (cards from the same list in the same project).
  let place: { id: string; after: boolean } | null = null;
  cleanups.push(makeDraggable(card, {
    dropSelector: ".col",
    onMove: (target, x, y) => {
      clearDropMarks();
      place = null;
      if (!target || target.dataset.status !== t.status || t.status === "done") return;
      const other = document.elementFromPoint(x, y)?.closest<HTMLElement>(".kcard");
      if (!other || other === card || !target.contains(other)) return;
      const r = other.getBoundingClientRect();
      const after = y > r.top + r.height / 2;
      if (beforeIdFor(t.id, other.dataset.id!, after) === undefined) return;
      place = { id: other.dataset.id!, after };
      other.classList.add(after ? "drop-after" : "drop-before");
    },
    onDrop: (target) => {
      const status = target?.dataset.status as Status | undefined;
      if (status && status !== t.status) { run({ type: "setStatus", taskId: t.id, status }); return; }
      if (place) {
        const beforeId = beforeIdFor(t.id, place.id, place.after);
        if (beforeId !== undefined) run({ type: "moveTask", taskId: t.id, beforeId });
      }
    },
    onEnd: clearDropMarks,
  }));
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function renderHistory(body: HTMLElement, data: Data) {
  const cs = completions(data.projects);
  const byDay = new Map<string, Completion[]>();
  for (const c of cs) {
    if (!byDay.has(c.date)) byDay.set(c.date, []);
    byDay.get(c.date)!.push(c);
  }

  const dueByDay = new Map<string, ReturnType<typeof tasksWithDeadlines>>();
  for (const x of tasksWithDeadlines(activeProjects(data))) {
    if (!dueByDay.has(x.task.due!)) dueByDay.set(x.task.due!, []);
    dueByDay.get(x.task.due!)!.push(x);
  }

  sectionTitle(body, "Activity");
  renderHeatmap(body, { counts: countByDay(cs), selected: ui.historyDay, onSelect: (day) => go({ month: day.slice(0, 7), historyDay: day }) });

  const [y, m] = ui.month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const shift = (delta: number) => go({ month: isoDate(new Date(y, m - 1 + delta, 1)).slice(0, 7) });

  const head = div(body, "cal-head");
  iconButton(head, "left", "Previous month", () => shift(-1));
  div(head, "cal-title", first.toLocaleDateString(undefined, { month: "long", year: "numeric" }));
  iconButton(head, "right", "Next month", () => shift(1));
  button(head, "Today", () => go({ month: today().slice(0, 7), historyDay: today() }));
  let monthTotal = 0;
  for (let d = 1; d <= daysInMonth; d++) monthTotal += byDay.get(isoDate(new Date(y, m - 1, d)))?.length ?? 0;
  div(head, "muted small", `${monthTotal} completed`);

  const cal = div(body, "cal");
  for (const w of WEEKDAYS) div(cal, "cal-weekday", w);
  for (let i = 0; i < first.getDay(); i++) div(cal, "cal-cell blank");
  const todayIso = today();
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoDate(new Date(y, m - 1, d));
    const items = byDay.get(iso) ?? [];
    const cell = div(cal, "cal-cell clickable");
    if (iso === todayIso) cell.classList.add("today");
    if (iso === ui.historyDay) cell.classList.add("selected");
    if (items.length) cell.classList.add("has-items");
    const num = div(cell, "cal-num");
    span(num, "day", String(d));
    if (items.length) span(num, "cal-count", String(items.length));
    const dues = dueByDay.get(iso) ?? [];
    if (dues.length) cell.classList.add(iso < todayIso ? "has-overdue" : "has-due");
    const list = div(cell, "cal-items");
    const MAX = 3;
    for (const x of dues.slice(0, MAX)) {
      const it = el(list, "div", { cls: `cal-item cal-due${iso < todayIso ? " overdue" : ""}`, title: `Deadline: ${x.task.text} · ${x.project.name}` });
      it.style.setProperty("--project-color", projectColor(x.project));
      it.appendChild(icon("flag"));
      span(it, "", x.task.text);
    }
    for (const c of items.slice(0, Math.max(0, MAX - dues.length))) {
      const it = el(list, "div", { cls: "cal-item", text: c.task.text, title: `${c.task.text} · ${c.project.name}` });
      it.style.setProperty("--project-color", projectColor(c.project));
    }
    const hidden = dues.length + items.length - Math.min(MAX, dues.length + items.length);
    if (hidden > 0) div(list, "cal-more", `+${hidden} more`);
    cell.addEventListener("click", () => go({ historyDay: ui.historyDay === iso ? null : iso }));
  }

  if (ui.historyDay) {
    const day = ui.historyDay;
    const items = byDay.get(day) ?? [];
    const box = div(body, "day-detail");
    const dues = dueByDay.get(day) ?? [];
    const h = div(box, "day-title", `${formatDay(day)} · ${items.length} completed${dues.length ? ` · ${dues.length} due` : ""}`);
    iconButton(h, "x", "Close", () => go({ historyDay: null }));
    if (dues.length) {
      const dl = div(box, "completion-list day-dues");
      for (const x of dues) {
        const item = div(dl, "completion");
        span(item, `completion-check due-${dueState(day)}`).appendChild(icon("flag"));
        const b = div(item, "completion-body");
        const name = span(b, "task-text clickable", "");
        renderText(name, x.task.text);
        name.addEventListener("click", () => openDetails(x.task.id));
        const sub = div(b, "muted small completion-sub");
        const chip = span(sub, "chip", x.project.name);
        chip.style.setProperty("--project-color", projectColor(x.project));
        span(sub, "", day < today() ? "Overdue" : "Deadline");
      }
    }
    if (items.length) renderCompletionList(box, items, true);
    else if (!dues.length) div(box, "muted small", "Nothing completed this day.");
  }
}

// ---------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.querySelector(".menu")) { closeMenu(); return; }
    if (!e.defaultPrevented && detailId && !document.querySelector(".modal-bg")) { e.preventDefault(); closeDrawer(); }
    return;
  }
  if (document.querySelector(".modal-bg") || e.altKey || fileState.status !== "ready") return;
  const typing = (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]");
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k === "k") { e.preventDefault(); openSwitcher(); return; }
  if (typing) return;
  if (ctrl) {
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    return;
  }
  const data = fileState.data;
  if (k === "1") go({ mode: "overview" });
  else if (k === "2") go({ mode: "board" });
  else if (k === "3") go({ mode: "history" });
  else if (k === "/") { e.preventDefault(); openSwitcher(); }
  else if (e.key === "?") shortcutsDialog();
  else if (k === "n" && e.shiftKey) { e.preventDefault(); newProject(); }
  else if (k === "n") {
    // New task: into the project on screen, else the first project.
    e.preventDefault();
    const inView = ui.mode === "project" ? data.projects.find((p) => p.id === ui.projectId) ?? data.projects[0]
      : ui.mode === "board" ? activeProjects(data).find((p) => p.id === ui.boardProject) : undefined;
    const p = inView ?? activeProjects(data)[0];
    if (!p) { newProject(); return; }
    if (ui.mode === "history" || (ui.mode === "board" && !inView)) go({ mode: "project", projectId: p.id });
    closeDrawer();
    draft = { key: `new:${p.id}`, kind: "add", value: "" };
    render();
  }
});

// ---------------------------------------------------------------------------
// Task details panel
// ---------------------------------------------------------------------------

function openDetails(id: string) {
  detailId = id;
  renderDrawer();
}

function closeDrawer() {
  // Blur first so a half-typed title or notes edit is saved.
  (document.activeElement as HTMLElement | null)?.closest(".drawer") && (document.activeElement as HTMLElement).blur();
  detailId = null;
  document.querySelector(".drawer-bg")?.remove();
}

// A press inside the panel can blur a field, which saves and would rebuild
// the panel before the click lands. Rebuilds wait for the button to come up.
let drawerPressed = false;
let drawerPending = false;
window.addEventListener("pointerup", () => {
  if (!drawerPressed) return;
  drawerPressed = false;
  if (drawerPending) { drawerPending = false; setTimeout(renderDrawer, 0); }
}, true);

function renderDrawer() {
  if (!detailId) return;
  if (drawerPressed && document.querySelector(".drawer-bg")) { drawerPending = true; return; }
  const data = currentData();
  const l = data && locate(data, detailId);
  if (!l) { closeDrawer(); return; }
  const existing = document.querySelector<HTMLElement>(".drawer-bg");
  // Don't rebuild under the user's cursor while they edit the title or notes.
  const focused = document.activeElement as HTMLElement | null;
  if (existing && focused && existing.contains(focused) && focused.matches(".drawer-title, .drawer-notes")) return;
  const scroll = existing?.querySelector(".drawer")?.scrollTop ?? 0;
  existing?.remove();

  const { project: p, task: t, ancestors } = l;
  const bg = div(document.body, "drawer-bg");
  bg.addEventListener("pointerdown", (e) => { if (e.target === bg) closeDrawer(); else drawerPressed = true; });
  const d = div(bg, "drawer");
  d.style.setProperty("--project-color", projectColor(p));

  const head = div(d, "drawer-head");
  const chip = span(head, "chip clickable", p.name);
  chip.addEventListener("click", () => { closeDrawer(); go({ mode: "project", projectId: p.id }); });
  iconButton(head, "more", "Task actions", (e) => taskMenu(e, p, t));
  iconButton(head, "x", "Close (Esc)", () => closeDrawer());

  if (ancestors.length) {
    const crumbs = div(d, "drawer-crumbs");
    crumbs.appendChild(icon("sub"));
    ancestors.forEach((a, i) => {
      if (i) span(crumbs, "crumb-sep", "›");
      const c = span(crumbs, "crumb clickable", a.text);
      c.addEventListener("click", () => openDetails(a.id));
    });
  }

  const title = el(d, "textarea", { cls: "drawer-title", attr: { rows: "1", "aria-label": "Task name", spellcheck: "true" } });
  title.value = t.text;
  const fit = () => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; };
  requestAnimationFrame(fit);
  title.addEventListener("input", fit);
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } if (e.key === "Escape") { e.preventDefault(); title.value = t.text; title.blur(); } });
  title.addEventListener("blur", () => {
    const v = title.value.trim();
    if (v && v !== t.text) run({ type: "editTask", taskId: t.id, text: v });
    else title.value = t.text;
  });

  const seg = div(d, "segmented");
  for (const [status, label] of [["todo", "To do"], ["doing", "In progress"], ["done", "Done"]] as [Status, string][]) {
    const b = button(seg, label, () => { if (t.status !== status) run({ type: "setStatus", taskId: t.id, status }); }, `seg-${status}${t.status === status ? " active" : ""}`);
    b.setAttribute("aria-pressed", String(t.status === status));
  }

  const dates = div(d, "drawer-dates");
  span(dates, "", `Created ${shortDate(t.created)}`);
  if (t.completed) span(dates, "", `Completed ${shortDate(t.completed)}`);

  renderDeadlineControls(d, t);
  if (!ancestors.length) renderRepeatControls(d, t);

  div(d, "drawer-label", "Notes");
  const notes = el(d, "textarea", { cls: "drawer-notes", attr: { rows: "6", placeholder: "Add notes, links, steps, measurements…", "aria-label": "Notes" } });
  notes.value = t.notes ?? "";
  const fitNotes = () => { notes.style.height = "auto"; notes.style.height = `${Math.max(120, notes.scrollHeight + 2)}px`; };
  requestAnimationFrame(fitNotes);
  notes.addEventListener("input", fitNotes);
  notes.addEventListener("blur", () => {
    if (notes.value.replace(/\s+$/, "") !== (t.notes ?? "")) run({ type: "editTask", taskId: t.id, notes: notes.value });
  });
  const links = (t.notes ?? "").match(/https?:\/\/[^\s<>"]+/g);
  if (links?.length) {
    const box = div(d, "drawer-links");
    for (const url of links.slice(0, 8)) renderText(div(box, "drawer-link"), url);
  }

  div(d, "drawer-label", t.subtasks.length ? `Subtasks · ${countSubtasks(t).done}/${countSubtasks(t).total} done` : "Subtasks");
  const subs = div(d, "task-list drawer-subtasks");
  for (const c of t.subtasks) renderTask(subs, p, c, false, false);
  const addRow = div(d, "add-row");
  addRow.appendChild(icon("plus"));
  inlineInput(addRow, `drawer:${t.id}`, "add-sub", "Add a subtask…", "", (v) => run({ type: "addTask", projectId: p.id, id: newId(), text: v, parentId: t.id }), true);

  d.scrollTop = scroll;
  const focus = d.querySelector<HTMLInputElement>("[data-focus]");
  if (focus) focus.focus();
}

function renderDeadlineControls(d: HTMLElement, t: Task) {
  div(d, "drawer-label", "Deadline");
  const row = div(d, "deadline-row");
  const input = el(row, "input", { attr: { type: "date", "aria-label": "Deadline" } });
  input.value = t.due ?? "";
  const set = (due: string | null) => { if ((due ?? undefined) !== t.due) run({ type: "editTask", taskId: t.id, due }); };
  input.addEventListener("change", () => { if (input.value) set(input.value); else set(null); });
  const now = today();
  for (const [label, iso] of [["Today", now], ["Tomorrow", addDays(now, 1)], ["Next week", addDays(now, 7)]] as [string, string][]) {
    button(row, label, () => set(iso), `small-button${t.due === iso ? " active" : ""}`);
  }
  if (t.due) {
    iconButton(row, "x", "Remove deadline", () => set(null), "deadline-clear");
    if (t.status !== "done") {
      const hint = div(d, `deadline-hint due-${dueState(t.due)}`);
      const n = daysBetween(now, t.due);
      span(hint, "", n < 0 ? `${plural(-n, "day")} overdue` : n === 0 ? "Due today" : n === 1 ? "Due tomorrow" : `Due in ${plural(n, "day")}, ${formatDay(t.due)}`);
    }
  }
}

const REPEAT_PRESETS: [string, Repeat | null][] = [
  ["Doesn't repeat", null],
  ["Daily", { every: 1, unit: "day" }],
  ["Every 2 days", { every: 2, unit: "day" }],
  ["Every 3 days", { every: 3, unit: "day" }],
  ["Weekly", { every: 1, unit: "week" }],
  ["Every 2 weeks", { every: 2, unit: "week" }],
  ["Monthly", { every: 1, unit: "month" }],
  ["Every 3 months", { every: 3, unit: "month" }],
  ["Every 6 months", { every: 6, unit: "month" }],
];

function renderRepeatControls(d: HTMLElement, t: Task) {
  div(d, "drawer-label", "Repeat");
  const row = div(d, "repeat-row");
  row.appendChild(icon("repeat"));
  const sel = el(row, "select", { attr: { "aria-label": "Repeat" } });
  const same = (a: Repeat | null, b: Repeat | undefined) => (!a && !b) || (!!a && !!b && a.every === b.every && a.unit === b.unit);
  let matched = false;
  REPEAT_PRESETS.forEach(([label, r], i) => {
    const o = el(sel, "option", { text: label, attr: { value: String(i) } });
    if (same(r, t.repeat)) { o.selected = true; matched = true; }
  });
  const customOpt = el(sel, "option", { text: "Custom…", attr: { value: "custom" } });
  if (!matched) customOpt.selected = true;

  const custom = div(row, "repeat-custom");
  span(custom, "", "every");
  const num = el(custom, "input", { attr: { type: "number", min: "1", max: "999", "aria-label": "Repeat interval" } });
  num.value = String(t.repeat?.every ?? 10);
  const unit = el(custom, "select", { attr: { "aria-label": "Repeat unit" } });
  for (const [v, label] of [["day", "days"], ["week", "weeks"], ["month", "months"]]) el(unit, "option", { text: label, attr: { value: v } });
  unit.value = t.repeat?.unit ?? "day";
  custom.hidden = matched;
  const saveCustom = () => {
    const every = parseInt(num.value, 10);
    if (!Number.isInteger(every) || every < 1 || every > 999) { toast("Enter a number from 1 to 999."); return; }
    const r: Repeat = { every, unit: unit.value as RepeatUnit };
    if (!same(r, t.repeat)) run({ type: "setRepeat", taskId: t.id, repeat: r });
  };
  num.addEventListener("change", saveCustom);
  unit.addEventListener("change", saveCustom);

  sel.addEventListener("change", () => {
    if (sel.value === "custom") { custom.hidden = false; num.focus(); num.select(); return; }
    const r = REPEAT_PRESETS[Number(sel.value)][1];
    if (!same(r, t.repeat)) run({ type: "setRepeat", taskId: t.id, repeat: r });
  });

  const hint = div(d, "repeat-hint");
  if (isWaiting(t)) {
    span(hint, "", `Hidden until it comes back ${whenBack(t.waitUntil!)} (${shortDate(t.waitUntil!)}).`);
    button(hint, "Bring back now", () => run({ type: "wakeTask", taskId: t.id }), "small-button");
  } else if (t.repeat) {
    span(hint, "", `When you complete it, a fresh copy comes back ${whenBack(nextRepeat(today(), t.repeat))}.`);
  } else {
    span(hint, "", "Repeating tasks come back by themselves some time after you finish them. Good for chores.");
  }
}

// ---------------------------------------------------------------------------
// Dialogs: move, jump-to switcher, shortcuts
// ---------------------------------------------------------------------------

function moveDialog(t: Task) {
  const data = currentData();
  const me = data && locate(data, t.id);
  if (!data || !me) return;
  modal(`Move "${t.text}"`, (body, close) => {
    const form = el(body, "form");
    const pl = el(form, "label", { cls: "field" });
    span(pl, "field-label", "Project");
    const projectSel = el(pl, "select");
    for (const q of data.projects) {
      if (q.archived && q !== me.project) continue;
      el(projectSel, "option", { text: q.name, attr: { value: q.id } });
    }
    projectSel.value = me.project.id;
    const parl = el(form, "label", { cls: "field" });
    span(parl, "field-label", "Put it");
    const parentSel = el(parl, "select");
    const fill = () => {
      parentSel.replaceChildren();
      el(parentSel, "option", { text: "At the top level", attr: { value: "" } });
      const q = data.projects.find((x) => x.id === projectSel.value)!;
      const add = (list: Task[], depth: number) => {
        for (const x of list) {
          if (x.id === t.id || x.status === "done") continue; // skip itself (and so its subtree) and finished tasks
          el(parentSel, "option", { text: `${"\u2003".repeat(depth)}Under: ${x.text}`, attr: { value: x.id } });
          add(x.subtasks, depth + 1);
        }
      };
      add(q.tasks, 0);
      const currentParent = me.ancestors[me.ancestors.length - 1];
      parentSel.value = q === me.project && currentParent ? currentParent.id : "";
    };
    fill();
    projectSel.addEventListener("change", fill);
    const row = div(form, "modal-buttons");
    button(row, "Cancel", (e) => { e.preventDefault(); close(); });
    el(row, "button", { cls: "primary", text: "Move", attr: { type: "submit" } });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      close();
      run({ type: "moveTask", taskId: t.id, projectId: projectSel.value, parentId: parentSel.value || null, beforeId: null });
    });
  });
}

interface JumpItem { label: string; sub: string; color?: string; iconName?: IconName; go: () => void }

function openSwitcher() {
  const data = currentData();
  if (!data || document.querySelector(".modal-bg")) return;
  const items: JumpItem[] = [
    ...MODES.map((m) => ({ label: m.label, sub: "View", iconName: m.icon, go: () => go({ mode: m.mode }) })),
    ...data.projects.map((p) => ({
      label: p.name, sub: p.archived ? "Archived project" : "Project", color: projectColor(p),
      go: () => go({ mode: "project", projectId: p.id, projectDay: null }),
    })),
  ];
  for (const p of data.projects) {
    if (p.archived) continue;
    const add = (list: Task[], path: string) => {
      for (const t of list) {
        if (t.status !== "done" && !isWaiting(t)) items.push({ label: t.text, sub: path, color: projectColor(p), go: () => { go({ mode: "project", projectId: p.id }); openDetails(t.id); } });
        add(t.subtasks, `${path} › ${t.text}`);
      }
    };
    add(p.tasks, p.name);
  }
  modal("", (body, close) => {
    body.parentElement!.classList.add("switcher");
    body.parentElement!.querySelector("h2")?.remove();
    const input = el(body, "input", { cls: "switcher-input", attr: { type: "text", placeholder: "Jump to a project, task or view…", "aria-label": "Search" } });
    const list = div(body, "switcher-list");
    let shown: JumpItem[] = [];
    let sel = 0;
    const pick = (it: JumpItem | undefined) => { if (!it) return; close(); it.go(); };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = q ? items.filter((it) => `${it.label} ${it.sub}`.toLowerCase().includes(q)).slice(0, 40) : items.slice(0, 14);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren();
      shown.forEach((it, i) => {
        const row = el(list, "button", { cls: `switcher-item${i === sel ? " selected" : ""}` });
        if (it.color) { row.style.setProperty("--project-color", it.color); span(row, "project-dot"); }
        else if (it.iconName) row.appendChild(icon(it.iconName));
        span(row, "switcher-label", it.label);
        span(row, "switcher-sub", it.sub);
        row.addEventListener("click", () => pick(it));
        row.addEventListener("pointermove", () => { if (sel !== i) { sel = i; draw(); } });
      });
      if (!shown.length) div(list, "switcher-empty", "No matches");
      list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => { sel = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
      else if (e.key === "Enter") { e.preventDefault(); pick(shown[sel]); }
    });
    draw();
  });
}

function shortcutsDialog() {
  modal("Keyboard shortcuts", (body, close) => {
    const rows: [string, string][] = [
      ["Ctrl K  or  /", "Jump to a project, task or view"],
      ["N", "New task in the current project"],
      ["Shift N", "New project"],
      ["1  2  3", "Overview, Board, Calendar"],
      ["Ctrl Z", "Undo"],
      ["Ctrl Y  or  Ctrl Shift Z", "Redo"],
      ["Esc", "Close a panel, menu or dialog"],
      ["?", "Show this list"],
    ];
    const table = div(body, "shortcuts");
    for (const [keys, what] of rows) {
      const r = div(table, "shortcut-row");
      const k = span(r, "shortcut-keys");
      for (const group of keys.split("  ")) {
        if (group === "or") span(k, "shortcut-or", "or");
        else group.split(" ").forEach((key) => el(k, "kbd", { text: key }));
      }
      span(r, "shortcut-what", what);
    }
    const row = div(body, "modal-buttons");
    button(row, "Close", close, "primary");
  });
}

let lastDay = today();
setInterval(() => {
  if (today() !== lastDay) { lastDay = today(); if (fileState.status === "ready") render(); }
}, 60_000);

(async () => {
  api.onState((s) => { fileState = s; render(); });
  fileState = await api.getState();
  render();
  api.ready();
})();
