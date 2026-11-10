/*
 * Data model and task rules. Pure functions, no Node/Electron/DOM imports,
 * so the same code runs in the main process, the UI, and the tests.
 *
 * The whole dashboard lives in one JSON file:
 *
 *   {
 *     "app": "project-dashboard",   (kept from the app's original name, so older files open)
 *     "version": 1,
 *     "settings": { "boardDoneDays": 7 },
 *     "projects": [
 *       { "id": "...", "name": "Bathroom Refresh", "description": "", "created": "2026-09-20",
 *         "tasks": [
 *           { "id": "...", "text": "Repaint walls", "status": "todo", "created": "2026-09-20",
 *             "completed": null, "notes": "optional", "subtasks": [ ... ] } ] } ]
 *   }
 *
 * Optional fields are left out of the file when empty: a task's "notes" and a
 * project's "archived": true.
 *
 * Optional deadline on any task: "due": "2026-11-20". Completing a repeating
 * task shifts the copy's deadlines forward by the repeat interval.
 *
 * Repeating tasks (top level only): "repeat": { "every": 7, "unit": "day" }.
 * Completing one creates a fresh copy right away with "waitUntil" set to the
 * day it comes back and "repeatFrom" pointing at the finished one. Until then
 * the copy is hidden from open lists and the board ("Coming back" instead).
 *
 * Rules:
 *   - status is "todo", "doing" (in progress, shown on the board) or "done".
 *   - Completing a task stamps today's date on it and on its open subtasks.
 *   - When every subtask is done, the parent completes automatically.
 *   - Reopening a subtask reopens its completed parents.
 *   - A completed top-level task is "archived": it leaves the open list and
 *     shows in the project's Completed list and the calendars.
 */

export type Status = "todo" | "doing" | "done";

export interface Task {
  id: string;
  text: string;
  status: Status;
  created: string;
  completed: string | null;
  /** Free-form notes; absent when empty. */
  notes?: string;
  /** Optional deadline (YYYY-MM-DD). */
  due?: string;
  /** Top-level tasks only: make a fresh copy each time this is completed. */
  repeat?: Repeat;
  /** A repeat copy stays hidden until this day. */
  waitUntil?: string;
  /** The finished task this repeat copy was made from. */
  repeatFrom?: string;
  subtasks: Task[];
}

export type RepeatUnit = "day" | "week" | "month";
export interface Repeat { every: number; unit: RepeatUnit }

export interface Project {
  id: string;
  name: string;
  description: string;
  created: string;
  /** Hidden from the overview, sidebar list and board; history is kept. Absent when false. */
  archived?: boolean;
  tasks: Task[];
}

export interface Settings {
  boardDoneDays: number;
}

export interface Data {
  app: "project-dashboard";
  version: 1;
  settings: Settings;
  projects: Project[];
}

export type Op =
  | { type: "addProject"; id: string; name: string; description: string }
  | { type: "updateProject"; projectId: string; name?: string; description?: string; archived?: boolean }
  | { type: "deleteProject"; projectId: string }
  | { type: "addTask"; projectId: string; id: string; text: string; parentId?: string }
  | { type: "editTask"; taskId: string; text?: string; notes?: string; due?: string | null }
  | { type: "deleteTask"; taskId: string }
  | { type: "setStatus"; taskId: string; status: Status }
  /**
   * Move a task before `beforeId` (or to the end when null). Without
   * `parentId`/`projectId` it is reordered among its current siblings;
   * otherwise it moves under `parentId` (null = top level) in `projectId`
   * (default: its current project).
   */
  | { type: "moveTask"; taskId: string; beforeId: string | null; parentId?: string | null; projectId?: string }
  /** Put projects back exactly as they were (project null = it didn't exist). Used by undo. */
  | { type: "restore"; projects: Snapshot[] }
  /** Set or clear (null) a task's repeat rule. Clearing it also brings a waiting copy back. */
  | { type: "setRepeat"; taskId: string; repeat: Repeat | null }
  /** Bring a waiting repeat copy back now. */
  | { type: "wakeTask"; taskId: string }
  | { type: "updateSettings"; settings: Partial<Settings> };

export interface Snapshot { projectId: string; project: Project | null; index: number }

export class OpError extends Error {}

export const DEFAULT_SETTINGS: Settings = { boardDoneDays: 7 };

export function emptyData(): Data {
  return { app: "project-dashboard", version: 1, settings: { ...DEFAULT_SETTINGS }, projects: [] };
}

// ---------------------------------------------------------------------------
// Validation: accept files written by this app (or hand-edited ones) and fill
// in anything missing, rather than failing on a small mistake.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function normRepeat(r: Record<string, unknown>): Partial<Task> {
  const out: Partial<Task> = {};
  const rr = (r.repeat && typeof r.repeat === "object" ? r.repeat : null) as Record<string, unknown> | null;
  if (rr && Number.isInteger(rr.every) && (rr.every as number) >= 1 && (rr.every as number) <= 999
    && (rr.unit === "day" || rr.unit === "week" || rr.unit === "month")) {
    out.repeat = { every: rr.every as number, unit: rr.unit };
  }
  if (DATE_RE.test(str(r.waitUntil))) out.waitUntil = str(r.waitUntil);
  if (str(r.repeatFrom)) out.repeatFrom = str(r.repeatFrom);
  return out;
}

function normTask(raw: unknown, today: string, ids: Set<string>): Task {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let id = str(r.id);
  if (!id || ids.has(id)) id = newId();
  ids.add(id);
  const status: Status = r.status === "done" || r.status === "doing" ? r.status : "todo";
  const completed = status === "done" ? (DATE_RE.test(str(r.completed)) ? str(r.completed) : today) : null;
  return {
    id,
    text: str(r.text).trim() || "(untitled)",
    status,
    created: DATE_RE.test(str(r.created)) ? str(r.created) : today,
    completed,
    ...(str(r.notes).trim() ? { notes: str(r.notes) } : {}),
    ...(DATE_RE.test(str(r.due)) ? { due: str(r.due) } : {}),
    ...normRepeat(r),
    subtasks: Array.isArray(r.subtasks) ? r.subtasks.map((s) => normTask(s, today, ids)) : [],
  };
}

/** Parse and validate file contents. Throws if it isn't a dashboard file at all. */
export function parseData(json: string, today: string): Data {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new OpError(`The data file isn't valid JSON (${(e as Error).message}).`);
  }
  const r = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!r || r.app !== "project-dashboard") throw new OpError("This file isn't a Cairn data file.");
  if (typeof r.version === "number" && r.version > 1) {
    throw new OpError("This data file was made by a newer version of Cairn. Please update the app.");
  }
  const ids = new Set<string>();
  const s = (r.settings && typeof r.settings === "object" ? r.settings : {}) as Record<string, unknown>;
  const projects = Array.isArray(r.projects) ? r.projects : [];
  return {
    app: "project-dashboard",
    version: 1,
    settings: {
      boardDoneDays: typeof s.boardDoneDays === "number" && s.boardDoneDays >= 0 ? s.boardDoneDays : DEFAULT_SETTINGS.boardDoneDays,
    },
    projects: projects.map((p) => {
      const pr = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      let id = str(pr.id);
      if (!id || ids.has(id)) id = newId();
      ids.add(id);
      return {
        id,
        name: str(pr.name).trim() || "Untitled project",
        description: str(pr.description),
        created: DATE_RE.test(str(pr.created)) ? str(pr.created) : today,
        ...(pr.archived === true ? { archived: true } : {}),
        tasks: Array.isArray(pr.tasks) ? pr.tasks.map((t) => normTask(t, today, ids)) : [],
      };
    }),
  };
}

export function serialize(data: Data): string {
  return JSON.stringify(data, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export interface Located {
  project: Project;
  task: Task;
  /** Ancestors from the top-level task down to the direct parent. */
  ancestors: Task[];
  /** The array that contains the task. */
  siblings: Task[];
}

export function locate(data: Data, taskId: string): Located | null {
  for (const project of data.projects) {
    const search = (list: Task[], ancestors: Task[]): Located | null => {
      for (const task of list) {
        if (task.id === taskId) return { project, task, ancestors, siblings: list };
        const found = search(task.subtasks, [...ancestors, task]);
        if (found) return found;
      }
      return null;
    };
    const found = search(project.tasks, []);
    if (found) return found;
  }
  return null;
}

export function walk(tasks: Task[], fn: (t: Task, parent: Task | null) => void, parent: Task | null = null): void {
  for (const t of tasks) {
    fn(t, parent);
    walk(t.subtasks, fn, t);
  }
}

/** A repeat copy that hasn't come back yet. */
export function isWaiting(t: Task, day: string = today()): boolean {
  return !!t.waitUntil && t.waitUntil > day && t.status !== "done";
}

/** Open top-level tasks, leaving out repeat copies that haven't come back yet. */
export function openTasks(p: Project, day: string = today()): Task[] {
  return p.tasks.filter((t) => t.status !== "done" && !isWaiting(t, day));
}

/** Repeat copies waiting to come back, soonest first. */
export function waitingTasks(p: Project, day: string = today()): Task[] {
  return p.tasks.filter((t) => isWaiting(t, day)).sort((a, b) => a.waitUntil!.localeCompare(b.waitUntil!));
}

/** The day a task repeating by `r` comes back after being finished on `from`. */
export function nextRepeat(from: string, r: Repeat): string {
  const d = parseIso(from);
  if (r.unit === "day") d.setDate(d.getDate() + r.every);
  else if (r.unit === "week") d.setDate(d.getDate() + 7 * r.every);
  else {
    // Same day of the month, clamped to the month's length (Jan 31 -> Feb 28).
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + r.every);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return isoDate(d);
}

export type DueState = "overdue" | "today" | "soon" | "later";

/** How urgent a deadline is: overdue, due today, within the next 7 days, or later. */
export function dueState(due: string, day: string = today()): DueState {
  if (due < day) return "overdue";
  if (due === day) return "today";
  const week = parseIso(day);
  week.setDate(week.getDate() + 7);
  return due <= isoDate(week) ? "soon" : "later";
}

/** Open tasks (any level) with a deadline, soonest first, skipping repeat copies that haven't come back. */
export function tasksWithDeadlines(projects: Project[], day: string = today()): { project: Project; task: Task; path: Task[] }[] {
  const out: { project: Project; task: Task; path: Task[] }[] = [];
  for (const project of projects) {
    const visit = (list: Task[], path: Task[]) => {
      for (const task of list) {
        if (task.status === "done" || isWaiting(task, day)) continue;
        if (task.due) out.push({ project, task, path });
        visit(task.subtasks, [...path, task]);
      }
    };
    visit(project.tasks, []);
  }
  return out.sort((a, b) => a.task.due!.localeCompare(b.task.due!));
}

export function describeRepeat(r: Repeat): string {
  const names = { day: ["day", "daily"], week: ["week", "weekly"], month: ["month", "monthly"] } as const;
  return r.every === 1 ? names[r.unit][1][0].toUpperCase() + names[r.unit][1].slice(1) : `Every ${r.every} ${names[r.unit][0]}s`;
}

/** Completed top-level tasks, newest first. */
export function archivedTasks(p: Project): Task[] {
  return p.tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
}

export interface Completion {
  date: string;
  task: Task;
  parent: Task | null;
  project: Project;
}

/** Every completed task and subtask, with its date. */
export function completions(projects: Project[]): Completion[] {
  const out: Completion[] = [];
  for (const project of projects) {
    walk(project.tasks, (task, parent) => {
      if (task.status === "done" && task.completed) out.push({ date: task.completed, task, parent, project });
    });
  }
  return out;
}

export function countSubtasks(t: Task): { done: number; total: number } {
  let done = 0, total = 0;
  walk(t.subtasks, (c) => { total++; if (c.status === "done") done++; });
  return { done, total };
}

// ---------------------------------------------------------------------------
// Operations. apply() returns a new Data object; the input is not modified.
// ---------------------------------------------------------------------------

function completeTree(t: Task, today: string) {
  if (t.status !== "done") { t.status = "done"; t.completed = today; }
  t.subtasks.forEach((c) => completeTree(c, today));
}

function reopen(t: Task) {
  if (t.status === "done") { t.status = "todo"; t.completed = null; }
}

/** Complete ancestors (deepest first) whose subtasks are now all done. */
function rollUp(ancestors: Task[], today: string) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.status === "done" || a.subtasks.length === 0 || !a.subtasks.every((c) => c.status === "done")) break;
    a.status = "done";
    a.completed = today;
  }
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function mustFind(data: Data, taskId: string): Located {
  const l = locate(data, taskId);
  if (!l) throw new OpError("That task no longer exists. It may have been changed on another computer.");
  return l;
}

function mustProject(data: Data, projectId: string): Project {
  const p = data.projects.find((x) => x.id === projectId);
  if (!p) throw new OpError("That project no longer exists. It may have been changed on another computer.");
  return p;
}

export function apply(input: Data, op: Op, today: string): Data {
  const data: Data = structuredClone(input);
  const result = applyOp(input, data, op, today);
  if (result === input) return input;
  if (op.type !== "restore") syncRepeats(input, result, today);
  return result;
}

function applyOp(input: Data, data: Data, op: Op, today: string): Data {
  switch (op.type) {
    case "addProject": {
      const name = cleanText(op.name);
      if (!name) throw new OpError("Please enter a project name.");
      if (data.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        throw new OpError(`A project called "${name}" already exists.`);
      }
      data.projects.push({ id: op.id, name, description: op.description.trim(), created: today, tasks: [] });
      break;
    }
    case "updateProject": {
      const p = mustProject(data, op.projectId);
      if (op.name !== undefined) {
        const name = cleanText(op.name);
        if (!name) throw new OpError("Please enter a project name.");
        if (data.projects.some((x) => x !== p && x.name.toLowerCase() === name.toLowerCase())) {
          throw new OpError(`A project called "${name}" already exists.`);
        }
        p.name = name;
      }
      if (op.description !== undefined) p.description = op.description.trim();
      if (op.archived === true) p.archived = true;
      else if (op.archived === false) delete p.archived;
      break;
    }
    case "deleteProject": {
      mustProject(data, op.projectId);
      data.projects = data.projects.filter((p) => p.id !== op.projectId);
      break;
    }
    case "addTask": {
      const text = cleanText(op.text);
      if (!text) return input;
      const task: Task = { id: op.id, text, status: "todo", created: today, completed: null, subtasks: [] };
      if (op.parentId) {
        const l = mustFind(data, op.parentId);
        l.task.subtasks.push(task);
        // A finished task with a new open subtask is no longer finished.
        reopen(l.task);
        l.ancestors.forEach(reopen);
      } else {
        mustProject(data, op.projectId).tasks.push(task);
      }
      break;
    }
    case "editTask": {
      const t = mustFind(data, op.taskId).task;
      if (op.text !== undefined) {
        const text = cleanText(op.text);
        if (text) t.text = text;
      }
      if (op.notes !== undefined) {
        const notes = op.notes.replace(/\s+$/, "");
        if (notes.trim()) t.notes = notes; else delete t.notes;
      }
      if (op.due === null) delete t.due;
      else if (op.due !== undefined) {
        if (!DATE_RE.test(op.due) || isNaN(parseIso(op.due).getTime())) throw new OpError("That isn't a valid date.");
        t.due = op.due;
      }
      break;
    }
    case "deleteTask": {
      const l = mustFind(data, op.taskId);
      l.siblings.splice(l.siblings.indexOf(l.task), 1);
      // Removing the last open subtask may finish the parent.
      rollUp(l.ancestors, today);
      break;
    }
    case "setStatus": {
      const l = mustFind(data, op.taskId);
      const t = l.task;
      if (t.status === op.status) return input;
      if (op.status === "done") {
        completeTree(t, today);
        rollUp(l.ancestors, today);
      } else {
        t.status = op.status;
        t.completed = null;
        l.ancestors.forEach(reopen);
      }
      break;
    }
    case "moveTask": {
      const l = mustFind(data, op.taskId);
      if (op.beforeId === op.taskId) return input;
      const relocating = op.parentId !== undefined || (op.projectId !== undefined && op.projectId !== l.project.id);
      if (!relocating) {
        const from = l.siblings.indexOf(l.task);
        l.siblings.splice(from, 1);
        let to = l.siblings.length;
        if (op.beforeId !== null) {
          to = l.siblings.findIndex((t) => t.id === op.beforeId);
          if (to < 0) throw new OpError("Tasks can only be reordered within the same list.");
        }
        if (to === from) return input;
        l.siblings.splice(to, 0, l.task);
        break;
      }
      const project = op.projectId ? mustProject(data, op.projectId) : l.project;
      let dest = project.tasks;
      let destAncestors: Task[] = [];
      if (op.parentId) {
        const pl = mustFind(data, op.parentId);
        if (pl.project !== project) throw new OpError("That parent task is in a different project.");
        if (pl.task === l.task || pl.ancestors.includes(l.task)) throw new OpError("A task can't be moved inside itself.");
        dest = pl.task.subtasks;
        destAncestors = [...pl.ancestors, pl.task];
      }
      l.siblings.splice(l.siblings.indexOf(l.task), 1);
      let to = dest.length;
      if (op.beforeId !== null) {
        to = dest.findIndex((t) => t.id === op.beforeId);
        if (to < 0) throw new OpError("Couldn't find where to put that task. It may have changed on another computer.");
      }
      dest.splice(to, 0, l.task);
      // The old parent may now have only finished subtasks; the new one gains
      // an open task (reopen it) or a finished one (it may now be complete).
      rollUp(l.ancestors, today);
      if (l.task.status === "done") rollUp(destAncestors, today);
      else destAncestors.forEach(reopen);
      break;
    }
    case "restore": {
      const restoring = new Set(op.projects.map((x) => x.projectId));
      // Task ids must stay unique across the file; drop anything that now
      // clashes with a project we aren't restoring (only after outside edits).
      const taken = new Set<string>();
      data.projects.forEach((p) => { if (!restoring.has(p.id)) walk(p.tasks, (t) => taken.add(t.id)); });
      const keep = (list: Task[]): Task[] => list.filter((t) => !taken.has(t.id)).map((t) => ({ ...t, subtasks: keep(t.subtasks) }));
      data.projects = data.projects.filter((p) => !restoring.has(p.id) || op.projects.some((x) => x.projectId === p.id && x.project));
      for (const x of [...op.projects].sort((a, b) => a.index - b.index)) {
        if (!x.project) continue;
        const project = structuredClone(x.project);
        project.tasks = keep(project.tasks);
        const at = data.projects.findIndex((p) => p.id === x.projectId);
        if (at >= 0) data.projects[at] = project;
        else data.projects.splice(Math.min(Math.max(x.index, 0), data.projects.length), 0, project);
      }
      break;
    }
    case "setRepeat": {
      const l = mustFind(data, op.taskId);
      if (l.ancestors.length) throw new OpError("Only top-level tasks can repeat.");
      if (op.repeat) {
        if (!Number.isInteger(op.repeat.every) || op.repeat.every < 1 || op.repeat.every > 999) throw new OpError("Repeat every 1 to 999 days, weeks or months.");
        l.task.repeat = { every: op.repeat.every, unit: op.repeat.unit };
      } else {
        delete l.task.repeat;
        delete l.task.waitUntil;
      }
      break;
    }
    case "wakeTask": {
      const t = mustFind(data, op.taskId).task;
      if (!t.waitUntil) return input;
      delete t.waitUntil;
      break;
    }
    case "updateSettings": {
      data.settings = { ...data.settings, ...op.settings };
      break;
    }
  }
  return data;
}

function freshCopy(t: Task, today: string, shiftDue: (due: string) => string): Task {
  return {
    id: newId(), text: t.text, status: "todo", created: today, completed: null,
    ...(t.notes ? { notes: t.notes } : {}),
    ...(t.due ? { due: shiftDue(t.due) } : {}),
    subtasks: t.subtasks.map((c) => freshCopy(c, today, shiftDue)),
  };
}

/**
 * After a change: a repeating top-level task that has just been completed gets
 * a fresh copy waiting to come back; one that has just been reopened loses its
 * copy again (if that copy is still waiting and untouched).
 */
function syncRepeats(before: Data, after: Data, today: string) {
  const wasDone = new Set<string>();
  before.projects.forEach((p) => p.tasks.forEach((t) => { if (t.status === "done") wasDone.add(t.id); }));
  for (const p of after.projects) {
    for (const t of [...p.tasks]) {
      if (!t.repeat) continue;
      const copyAt = p.tasks.findIndex((x) => x.repeatFrom === t.id);
      if (t.status === "done" && !wasDone.has(t.id) && copyAt < 0) {
        const waitUntil = nextRepeat(today, t.repeat);
        const rule = t.repeat;
        // Deadlines move forward one interval at a time until they're no
        // earlier than the day the copy comes back.
        const shiftDue = (due: string) => {
          let d = nextRepeat(due, rule);
          for (let i = 0; d < waitUntil && i < 1000; i++) d = nextRepeat(d, rule);
          return d;
        };
        const copy: Task = { ...freshCopy(t, today, shiftDue), repeat: { ...t.repeat }, waitUntil, repeatFrom: t.id };
        p.tasks.splice(p.tasks.indexOf(t), 0, copy);
      } else if (t.status !== "done" && wasDone.has(t.id) && copyAt >= 0) {
        const copy = p.tasks[copyAt];
        if (copy.waitUntil && copy.status === "todo") p.tasks.splice(copyAt, 1);
      }
    }
  }
}

/** Which projects an operation changes (none for file-wide settings). */
function projectsOf(data: Data, op: Op): string[] {
  const at = (taskId: string) => locate(data, taskId)?.project.id;
  let ids: (string | undefined)[];
  switch (op.type) {
    case "addProject": ids = [op.id]; break;
    case "updateProject": case "deleteProject": ids = [op.projectId]; break;
    case "restore": ids = op.projects.map((x) => x.projectId); break;
    case "addTask": ids = [op.parentId ? at(op.parentId) ?? op.projectId : op.projectId]; break;
    case "editTask": case "deleteTask": case "setStatus": case "setRepeat": case "wakeTask": ids = [at(op.taskId)]; break;
    case "moveTask": ids = [at(op.taskId), op.projectId]; break;
    case "updateSettings": ids = []; break;
  }
  return [...new Set(ids.filter((x): x is string => !!x))];
}

/**
 * The operation that undoes `op`, computed from the data *before* `op` runs.
 * It restores snapshots of just the projects `op` touches, so edits made to
 * other projects (say, on another computer in the meantime) are left alone.
 */
export function undoFor(before: Data, op: Op): Op | null {
  const ids = projectsOf(before, op);
  if (!ids.length) return null;
  return {
    type: "restore",
    projects: ids.map((projectId) => {
      const index = before.projects.findIndex((p) => p.id === projectId);
      return {
        projectId,
        project: index >= 0 ? structuredClone(before.projects[index]) : null,
        index: index >= 0 ? index : before.projects.length,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
}

export function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function today(): string {
  return isoDate(new Date());
}

export function parseIso(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
