import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Data, Op, Task, apply, archivedTasks, completions, emptyData, locate, openTasks, parseData, serialize, OpError, undoFor,
  nextRepeat, waitingTasks, describeRepeat, dueState, tasksWithDeadlines,
} from "../src/shared/model";

const T = "2026-11-04";

function task(id: string, status: Task["status"] = "todo", completed: string | null = null, subtasks: Task[] = []): Task {
  return { id, text: id, status, created: "2026-10-01", completed, subtasks };
}

function sample(): Data {
  const d = emptyData();
  d.projects.push({
    id: "p1", name: "Bathroom", description: "", created: "2026-10-01",
    tasks: [
      task("alpha"),
      task("beta", "doing", null, [task("b1", "done", "2026-11-01"), task("b2", "todo", null, [task("b2a"), task("b2b", "done", "2026-11-02")])]),
      task("old", "done", "2026-10-20"),
    ],
  });
  return d;
}

const run = (d: Data, ...ops: Op[]) => ops.reduce((acc, op) => apply(acc, op, T), d);
const get = (d: Data, id: string) => locate(d, id)!.task;

test("completing a top-level task archives it with today's date", () => {
  const d = run(sample(), { type: "setStatus", taskId: "alpha", status: "done" });
  const p = d.projects[0];
  assert.deepEqual(openTasks(p).map((t) => t.id), ["beta"]);
  assert.deepEqual(archivedTasks(p).map((t) => t.id), ["alpha", "old"]);
  assert.equal(get(d, "alpha").completed, T);
});

test("finishing the last open subtasks completes ancestors all the way up", () => {
  const d = run(sample(), { type: "setStatus", taskId: "b2a", status: "done" });
  assert.equal(get(d, "b2").status, "done");
  assert.equal(get(d, "beta").status, "done");
  assert.equal(get(d, "beta").completed, T);
  assert.equal(get(d, "b1").completed, "2026-11-01", "earlier dates kept");
});

test("a parent with other open subtasks does not complete", () => {
  const d = run(sample(), { type: "setStatus", taskId: "b2b", status: "todo" }, { type: "setStatus", taskId: "b2a", status: "done" });
  assert.equal(get(d, "b2").status, "todo");
});

test("completing a parent completes every open subtask", () => {
  const d = run(sample(), { type: "setStatus", taskId: "beta", status: "done" });
  for (const id of ["b1", "b2", "b2a", "b2b"]) assert.equal(get(d, id).status, "done", id);
  assert.equal(get(d, "b2a").completed, T);
  assert.equal(get(d, "b2b").completed, "2026-11-02");
});

test("reopening a subtask reopens completed ancestors", () => {
  let d = run(sample(), { type: "setStatus", taskId: "beta", status: "done" });
  d = run(d, { type: "setStatus", taskId: "b2a", status: "todo" });
  assert.equal(get(d, "b2").status, "todo");
  assert.equal(get(d, "beta").status, "todo");
  assert.equal(get(d, "beta").completed, null);
  assert.equal(get(d, "b1").status, "done", "siblings untouched");
});

test("moving to in progress from done reopens", () => {
  const d = run(sample(), { type: "setStatus", taskId: "old", status: "doing" });
  assert.equal(get(d, "old").status, "doing");
  assert.equal(get(d, "old").completed, null);
  assert.deepEqual(openTasks(d.projects[0]).map((t) => t.id), ["alpha", "beta", "old"]);
});

test("adding a subtask under a completed task reopens it", () => {
  const d = run(sample(), { type: "addTask", projectId: "p1", id: "new", text: "  more   work ", parentId: "old" });
  assert.equal(get(d, "old").status, "todo");
  assert.equal(get(d, "new").text, "more work");
});

test("deleting the last open subtask completes the parent", () => {
  const d = run(sample(), { type: "deleteTask", taskId: "b2a" });
  assert.equal(get(d, "b2").status, "done");
  assert.equal(get(d, "beta").status, "done");
  assert.equal(locate(d, "b2a"), null);
});

test("apply never mutates its input", () => {
  const before = sample();
  const snapshot = serialize(before);
  run(before, { type: "setStatus", taskId: "beta", status: "done" }, { type: "deleteTask", taskId: "alpha" });
  assert.equal(serialize(before), snapshot);
});

test("ops on missing tasks raise a friendly error", () => {
  assert.throws(() => run(sample(), { type: "setStatus", taskId: "nope", status: "done" }), OpError);
});

test("project names must be unique and non-empty", () => {
  assert.throws(() => run(sample(), { type: "addProject", id: "x", name: "bathroom", description: "" }), OpError);
  assert.throws(() => run(sample(), { type: "addProject", id: "x", name: "  ", description: "" }), OpError);
  const d = run(sample(), { type: "addProject", id: "p2", name: "Chores", description: "weekly" });
  assert.equal(d.projects[1].created, T);
});

test("completions include subtasks with their parent", () => {
  const cs = completions(sample().projects);
  assert.deepEqual(cs.map((c) => [c.task.id, c.parent?.id ?? null]).sort(), [["b1", "beta"], ["b2b", "b2"], ["old", null]]);
});

test("round-trips through JSON and repairs hand-edited files", () => {
  const d = sample();
  assert.deepEqual(parseData(serialize(d), T), d);
  const messy = JSON.stringify({
    app: "project-dashboard",
    projects: [{ name: "X", tasks: [{ text: "a", status: "done" }, { text: "b", status: "weird", id: "dup" }, { text: "c", id: "dup" }] }],
  });
  const fixed = parseData(messy, T);
  const [a, b, c] = fixed.projects[0].tasks;
  assert.equal(a.completed, T, "done without a date gets one");
  assert.equal(b.status, "todo");
  assert.notEqual(b.id, c.id, "duplicate ids are replaced");
  assert.equal(fixed.settings.boardDoneDays, 7);
});

test("rejects files that aren't dashboard data", () => {
  assert.throws(() => parseData("{not json", T), OpError);
  assert.throws(() => parseData(JSON.stringify({ hello: 1 }), T), OpError);
  assert.throws(() => parseData(JSON.stringify({ app: "project-dashboard", version: 99 }), T), /newer version/);
});

// ---- Reordering ----

const ids = (list: Task[]) => list.map((t) => t.id);

test("moveTask reorders within the sibling list", () => {
  let d = run(sample(), { type: "moveTask", taskId: "old", beforeId: "alpha" });
  assert.deepEqual(ids(d.projects[0].tasks), ["old", "alpha", "beta"]);
  d = run(d, { type: "moveTask", taskId: "old", beforeId: null });
  assert.deepEqual(ids(d.projects[0].tasks), ["alpha", "beta", "old"]);
  d = run(d, { type: "moveTask", taskId: "b2", beforeId: "b1" });
  assert.deepEqual(ids(get(d, "beta").subtasks), ["b2", "b1"]);
});

test("moveTask refuses to move a task into another list", () => {
  assert.throws(() => run(sample(), { type: "moveTask", taskId: "b1", beforeId: "alpha" }), OpError);
});

// ---- Undo ----

const undoable: Op[] = [
  { type: "setStatus", taskId: "b2a", status: "done" },     // rolls up to b2 and beta
  { type: "deleteTask", taskId: "beta" },
  { type: "addTask", projectId: "p1", id: "new", text: "New", parentId: "b2" },
  { type: "editTask", taskId: "alpha", text: "Renamed" },
  { type: "moveTask", taskId: "old", beforeId: "alpha" },
  { type: "updateProject", projectId: "p1", name: "Kitchen" },
  { type: "deleteProject", projectId: "p1" },
  { type: "addProject", id: "p2", name: "Garden", description: "" },
];

for (const op of undoable) {
  test(`undo restores the data exactly after ${op.type}`, () => {
    const before = sample();
    const inverse = undoFor(before, op)!;
    const after = run(before, op);
    assert.notDeepEqual(after, before);
    assert.deepEqual(run(after, inverse), before);
    // Redo is the undo of the undo.
    const redo = undoFor(after, inverse)!;
    assert.deepEqual(run(run(after, inverse), redo), after);
  });
}

test("undo leaves other projects' changes alone", () => {
  const before = sample();
  before.projects.push({ id: "p2", name: "Garden", description: "", created: T, tasks: [task("g1")] });
  const op: Op = { type: "deleteTask", taskId: "alpha" };
  const inverse = undoFor(before, op)!;
  // Meanwhile, another computer completes a task in the other project.
  const after = run(before, op, { type: "setStatus", taskId: "g1", status: "done" });
  const undone = run(after, inverse);
  assert.deepEqual(ids(undone.projects[0].tasks), ["alpha", "beta", "old"]);
  assert.equal(get(undone, "g1").status, "done");
});

test("settings changes are not undoable", () => {
  assert.equal(undoFor(sample(), { type: "updateSettings", settings: { boardDoneDays: 3 } }), null);
});

// ---- Moving between parents and projects ----

function twoProjects(): Data {
  const d = sample();
  d.projects.push({ id: "p2", name: "Garden", description: "", created: T, tasks: [task("g1"), task("g2", "done", "2026-11-01", [task("g2a", "done", "2026-11-01")])] });
  return d;
}

test("a task can be nested under another task and pulled back out", () => {
  let d = run(sample(), { type: "moveTask", taskId: "alpha", parentId: "b2", beforeId: "b2a" });
  assert.deepEqual(ids(get(d, "b2").subtasks), ["alpha", "b2a", "b2b"]);
  assert.deepEqual(ids(d.projects[0].tasks), ["beta", "old"]);
  d = run(d, { type: "moveTask", taskId: "alpha", parentId: null, beforeId: null });
  assert.deepEqual(ids(d.projects[0].tasks), ["beta", "old", "alpha"]);
});

test("a task can't be moved inside itself", () => {
  assert.throws(() => run(sample(), { type: "moveTask", taskId: "beta", parentId: "b2a", beforeId: null }), OpError);
  assert.throws(() => run(sample(), { type: "moveTask", taskId: "beta", parentId: "beta", beforeId: null }), OpError);
});

test("moving an open task under a finished one reopens it", () => {
  const d = run(twoProjects(), { type: "moveTask", taskId: "g1", parentId: "g2", beforeId: null });
  assert.equal(get(d, "g2").status, "todo");
  assert.equal(get(d, "g2").completed, null);
});

test("moving the last open subtask out completes the old parent", () => {
  const d = run(sample(), { type: "moveTask", taskId: "b2a", parentId: null, beforeId: null });
  assert.equal(get(d, "b2").status, "done");
  assert.equal(get(d, "beta").status, "done");
});

test("a task can move to another project with its subtasks", () => {
  const d = run(twoProjects(), { type: "moveTask", taskId: "beta", projectId: "p2", parentId: null, beforeId: "g1" });
  assert.deepEqual(ids(d.projects[1].tasks), ["beta", "g1", "g2"]);
  assert.equal(locate(d, "b2a")!.project.id, "p2");
});

test("undo of a move across projects restores both projects", () => {
  const before = twoProjects();
  const op: Op = { type: "moveTask", taskId: "beta", projectId: "p2", parentId: "g2", beforeId: null };
  const inverse = undoFor(before, op)!;
  const after = run(before, op);
  assert.deepEqual(run(after, inverse), before);
  const redo = undoFor(after, inverse)!;
  assert.deepEqual(run(run(after, inverse), redo), after);
});

// ---- Notes and archiving ----

test("notes are saved, trimmed at the end, and removed when emptied", () => {
  let d = run(sample(), { type: "editTask", taskId: "alpha", notes: "Buy rollers\n  - 2x  \n\n" });
  assert.equal(get(d, "alpha").notes, "Buy rollers\n  - 2x");
  assert.equal(get(d, "alpha").text, "alpha");
  d = run(d, { type: "editTask", taskId: "alpha", notes: "   " });
  assert.equal("notes" in get(d, "alpha"), false);
});

test("projects can be archived and unarchived; the flag round-trips", () => {
  let d = run(sample(), { type: "updateProject", projectId: "p1", archived: true });
  assert.equal(d.projects[0].archived, true);
  const back = parseData(serialize(d), T);
  assert.equal(back.projects[0].archived, true);
  d = run(d, { type: "updateProject", projectId: "p1", archived: false });
  assert.equal("archived" in d.projects[0], false);
  assert.equal(serialize(d).includes("archived"), false);
});

test("undo works for notes and archiving", () => {
  for (const op of [
    { type: "editTask", taskId: "alpha", notes: "x" },
    { type: "updateProject", projectId: "p1", archived: true },
  ] as Op[]) {
    const before = sample();
    assert.deepEqual(run(run(before, op), undoFor(before, op)!), before);
  }
});

// ---- Repeating tasks ----

function weekly(): Data {
  const d = sample();
  return run(d, { type: "setRepeat", taskId: "alpha", repeat: { every: 7, unit: "day" } });
}

test("nextRepeat adds days, weeks and months (clamping month ends)", () => {
  assert.equal(nextRepeat("2026-11-04", { every: 7, unit: "day" }), "2026-11-11");
  assert.equal(nextRepeat("2026-12-29", { every: 1, unit: "week" }), "2027-01-05");
  assert.equal(nextRepeat("2027-01-31", { every: 1, unit: "month" }), "2027-02-28");
  assert.equal(nextRepeat("2026-11-15", { every: 3, unit: "month" }), "2027-02-15");
  assert.equal(describeRepeat({ every: 1, unit: "week" }), "Weekly");
  assert.equal(describeRepeat({ every: 2, unit: "week" }), "Every 2 weeks");
});

test("completing a repeating task makes a waiting copy that comes back later", () => {
  const d = run(weekly(), { type: "setStatus", taskId: "alpha", status: "done" });
  const p = d.projects[0];
  const copy = p.tasks[0];
  assert.equal(copy.repeatFrom, "alpha");
  assert.equal(copy.text, "alpha");
  assert.equal(copy.status, "todo");
  assert.equal(copy.waitUntil, "2026-11-11");
  assert.deepEqual(copy.repeat, { every: 7, unit: "day" });
  assert.equal(get(d, "alpha").status, "done");
  // Hidden from the open list until it comes back.
  assert.deepEqual(openTasks(p, T).map((t) => t.id), ["beta"]);
  assert.deepEqual(waitingTasks(p, T).map((t) => t.id), [copy.id]);
  assert.deepEqual(openTasks(p, "2026-11-11").map((t) => t.id), [copy.id, "beta"]);
});

test("the copy's subtasks start fresh", () => {
  let d = run(sample(), { type: "setRepeat", taskId: "beta", repeat: { every: 1, unit: "month" } });
  d = run(d, { type: "setStatus", taskId: "beta", status: "done" });
  const copy = d.projects[0].tasks.find((t) => t.repeatFrom === "beta")!;
  assert.equal(copy.subtasks.length, 2);
  assert.ok(copy.subtasks.every((t) => t.status === "todo" && t.completed === null && t.id !== "b1"));
  assert.equal(copy.subtasks[1].subtasks.length, 2);
});

test("completing the last subtask of a repeating task also makes a copy", () => {
  let d = run(sample(), { type: "setRepeat", taskId: "beta", repeat: { every: 3, unit: "day" } });
  d = run(d, { type: "setStatus", taskId: "b2a", status: "done" });
  assert.equal(get(d, "beta").status, "done");
  assert.ok(d.projects[0].tasks.some((t) => t.repeatFrom === "beta"));
});

test("reopening removes the waiting copy, so completing again doesn't duplicate", () => {
  let d = run(weekly(), { type: "setStatus", taskId: "alpha", status: "done" });
  d = run(d, { type: "setStatus", taskId: "alpha", status: "todo" });
  assert.equal(d.projects[0].tasks.filter((t) => t.repeatFrom === "alpha").length, 0);
  d = run(d, { type: "setStatus", taskId: "alpha", status: "done" });
  assert.equal(d.projects[0].tasks.filter((t) => t.repeatFrom === "alpha").length, 1);
});

test("deleting a waiting copy stops the cycle; other edits don't bring it back", () => {
  let d = run(weekly(), { type: "setStatus", taskId: "alpha", status: "done" });
  const copy = d.projects[0].tasks.find((t) => t.repeatFrom === "alpha")!;
  d = run(d, { type: "deleteTask", taskId: copy.id }, { type: "editTask", taskId: "beta", text: "Beta!" });
  assert.equal(d.projects[0].tasks.some((t) => t.repeatFrom === "alpha"), false);
});

test("wakeTask brings a copy back early; clearing repeat also wakes it", () => {
  let d = run(weekly(), { type: "setStatus", taskId: "alpha", status: "done" });
  const copy = d.projects[0].tasks.find((t) => t.repeatFrom === "alpha")!;
  const woken = run(d, { type: "wakeTask", taskId: copy.id });
  assert.equal(get(woken, copy.id).waitUntil, undefined);
  assert.equal(openTasks(woken.projects[0], T)[0].id, copy.id);
  d = run(d, { type: "setRepeat", taskId: copy.id, repeat: null });
  assert.equal(get(d, copy.id).waitUntil, undefined);
  assert.equal(get(d, copy.id).repeat, undefined);
});

test("only top-level tasks can repeat", () => {
  assert.throws(() => run(sample(), { type: "setRepeat", taskId: "b1", repeat: { every: 1, unit: "day" } }), OpError);
});

test("repeat fields round-trip through the file; bad values are dropped", () => {
  const d = run(weekly(), { type: "setStatus", taskId: "alpha", status: "done" });
  assert.deepEqual(parseData(serialize(d), T), d);
  const raw = JSON.parse(serialize(sample()));
  raw.projects[0].tasks[0].repeat = { every: 0, unit: "fortnight" };
  raw.projects[0].tasks[0].waitUntil = "soon";
  const back = parseData(JSON.stringify(raw), T);
  assert.equal(back.projects[0].tasks[0].repeat, undefined);
  assert.equal(back.projects[0].tasks[0].waitUntil, undefined);
});

test("undo of completing a repeating task removes the copy too", () => {
  const before = weekly();
  const op: Op = { type: "setStatus", taskId: "alpha", status: "done" };
  assert.deepEqual(run(run(before, op), undoFor(before, op)!), before);
});

// ---- Deadlines ----

test("deadlines can be set on any task and cleared", () => {
  let d = run(sample(), { type: "editTask", taskId: "b2a", due: "2026-11-20" });
  assert.equal(get(d, "b2a").due, "2026-11-20");
  assert.equal(get(d, "b2a").text, "b2a");
  assert.deepEqual(parseData(serialize(d), T), d);
  d = run(d, { type: "editTask", taskId: "b2a", due: null });
  assert.equal("due" in get(d, "b2a"), false);
  assert.throws(() => run(sample(), { type: "editTask", taskId: "alpha", due: "next week" }), OpError);
});

test("dueState sorts deadlines into overdue, today, this week and later", () => {
  assert.equal(dueState("2026-11-03", T), "overdue");
  assert.equal(dueState(T, T), "today");
  assert.equal(dueState("2026-11-11", T), "soon");
  assert.equal(dueState("2026-11-12", T), "later");
});

test("tasksWithDeadlines lists open tasks at any level, soonest first", () => {
  const d = run(sample(),
    { type: "editTask", taskId: "alpha", due: "2026-11-20" },
    { type: "editTask", taskId: "b2a", due: "2026-11-06" },
    { type: "editTask", taskId: "old", due: "2026-11-01" }); // done: left out
  const list = tasksWithDeadlines(d.projects, T);
  assert.deepEqual(list.map((x) => x.task.id), ["b2a", "alpha"]);
  assert.deepEqual(list[0].path.map((t) => t.id), ["beta", "b2"]);
});

test("a repeating task's copy moves its deadlines forward", () => {
  let d = run(sample(),
    { type: "setRepeat", taskId: "alpha", repeat: { every: 1, unit: "week" } },
    { type: "editTask", taskId: "alpha", due: "2026-11-05" });
  d = run(d, { type: "setStatus", taskId: "alpha", status: "done" });
  const copy = d.projects[0].tasks.find((t) => t.repeatFrom === "alpha")!;
  assert.equal(copy.waitUntil, "2026-11-11");
  assert.equal(copy.due, "2026-11-12");
  // A deadline far in the past jumps forward until it's after the copy returns.
  let e = run(sample(),
    { type: "setRepeat", taskId: "alpha", repeat: { every: 1, unit: "week" } },
    { type: "editTask", taskId: "alpha", due: "2026-10-01" });
  e = run(e, { type: "setStatus", taskId: "alpha", status: "done" });
  assert.equal(e.projects[0].tasks.find((t) => t.repeatFrom === "alpha")!.due, "2026-11-12");
});

// ---- Project order and colour ----

function threeProjects(): Data {
  const d = sample();
  d.projects.push({ id: "p2", name: "Garden", description: "", created: T, tasks: [] });
  d.projects.push({ id: "p3", name: "Garage", description: "", created: T, tasks: [] });
  return d;
}
const order = (d: Data) => d.projects.map((p) => p.id);

test("projects can be reordered, and undo puts them back", () => {
  const before = threeProjects();
  for (const op of [
    { type: "moveProject", projectId: "p3", beforeId: "p1" },
    { type: "moveProject", projectId: "p1", beforeId: null },
    { type: "moveProject", projectId: "p1", beforeId: "p3" },
  ] as Op[]) {
    const after = run(before, op);
    const inverse = undoFor(before, op)!;
    assert.deepEqual(order(run(after, inverse)), order(before));
  }
  assert.deepEqual(order(run(before, { type: "moveProject", projectId: "p3", beforeId: "p1" })), ["p3", "p1", "p2"]);
  assert.deepEqual(order(run(before, { type: "moveProject", projectId: "p1", beforeId: null })), ["p2", "p3", "p1"]);
});

test("a project colour can be chosen, cleared, and survives the file", () => {
  let d = run(sample(), { type: "updateProject", projectId: "p1", color: "#E05CC2" });
  assert.equal(d.projects[0].color, "#e05cc2");
  assert.equal(parseData(serialize(d), T).projects[0].color, "#e05cc2");
  d = run(d, { type: "updateProject", projectId: "p1", color: null });
  assert.equal("color" in d.projects[0], false);
  assert.throws(() => run(sample(), { type: "updateProject", projectId: "p1", color: "red" }), OpError);
});
