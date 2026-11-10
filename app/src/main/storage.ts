/*
 * Reading and writing the data file. Node only (no Electron), so it can be tested.
 *
 * Safety measures, since the file may live on a drive shared between operating
 * systems or computers:
 *   - Every change re-reads the file first and applies the change to what is
 *     on disk, so edits made elsewhere are never overwritten with stale data.
 *   - Writes go to a temporary file which is then renamed over the original,
 *     so a crash or power cut can't leave a half-written file.
 *   - Before the first change each day, a dated copy is saved in a
 *     "<name>.backups" folder next to the file (the newest 30 are kept).
 */
import fs from "node:fs";
import path from "node:path";
import { Data, Op, apply, emptyData, parseData, serialize, today } from "../shared/model";

const BACKUPS_TO_KEEP = 30;

export function backupDir(file: string): string {
  const { dir, name } = path.parse(file);
  return path.join(dir, `${name}.backups`);
}

export function readDataFile(file: string): Data {
  return parseData(fs.readFileSync(file, "utf8"), today());
}

export function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function createDataFile(file: string): Data {
  if (fs.existsSync(file)) throw new Error(`A file already exists at ${file}.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = emptyData();
  writeAtomic(file, serialize(data));
  return data;
}

/** Save today's backup if there isn't one yet. Returns the backup path, if made. */
export function backupIfNeeded(file: string, date = today()): string | null {
  if (!fs.existsSync(file)) return null;
  const dir = backupDir(file);
  const { name } = path.parse(file);
  const target = path.join(dir, `${name}-${date}.json`);
  if (fs.existsSync(target)) return null;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, target);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(`${name}-`) && f.endsWith(".json")).sort();
  for (const f of old.slice(0, Math.max(0, old.length - BACKUPS_TO_KEEP))) fs.rmSync(path.join(dir, f), { force: true });
  return target;
}

/** Read the current file, apply one change, write it back. Returns the new data. */
export function applyToFile(file: string, op: Op): Data {
  const current = readDataFile(file);
  const next = apply(current, op, today());
  if (next === current) return current;
  backupIfNeeded(file);
  writeAtomic(file, serialize(next));
  return next;
}
