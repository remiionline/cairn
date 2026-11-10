import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyToFile, backupDir, backupIfNeeded, createDataFile, readDataFile } from "../src/main/storage";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-test-"));
  return path.join(dir, "sub folder", "projects.json");
}

test("creates a new file, applies changes and reads them back", () => {
  const file = tmpFile();
  createDataFile(file);
  applyToFile(file, { type: "addProject", id: "p1", name: "Garden", description: "" });
  applyToFile(file, { type: "addTask", projectId: "p1", id: "t1", text: "Weed beds" });
  const d = readDataFile(file);
  assert.equal(d.projects[0].tasks[0].text, "Weed beds");
  assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp")), "no temp files left");
});

test("refuses to overwrite an existing file on create", () => {
  const file = tmpFile();
  createDataFile(file);
  assert.throws(() => createDataFile(file));
});

test("changes made by another computer are kept", () => {
  const file = tmpFile();
  createDataFile(file);
  applyToFile(file, { type: "addProject", id: "p1", name: "Garden", description: "" });
  // Simulate another machine editing the file directly.
  const other = readDataFile(file);
  other.projects.push({ id: "p2", name: "Elsewhere", description: "", created: "2026-11-04", tasks: [] });
  fs.writeFileSync(file, JSON.stringify(other));
  applyToFile(file, { type: "addTask", projectId: "p1", id: "t1", text: "Weed beds" });
  assert.deepEqual(readDataFile(file).projects.map((p) => p.name), ["Garden", "Elsewhere"]);
});

test("makes one backup per day and keeps the newest 30", () => {
  const file = tmpFile();
  createDataFile(file);
  assert.ok(backupIfNeeded(file, "2026-11-04"));
  assert.equal(backupIfNeeded(file, "2026-11-04"), null, "only once per day");
  for (let d = 1; d <= 35; d++) backupIfNeeded(file, `2026-12-${String(d).padStart(2, "0")}`);
  const files = fs.readdirSync(backupDir(file)).sort();
  assert.equal(files.length, 30);
  assert.equal(files[files.length - 1], "projects-2026-12-35.json");
});

test("a failing change leaves the file untouched", () => {
  const file = tmpFile();
  createDataFile(file);
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => applyToFile(file, { type: "setStatus", taskId: "missing", status: "done" }));
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
