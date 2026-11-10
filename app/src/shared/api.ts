import type { Data, Op } from "./model";

/** What the UI knows about the data file. */
export type FileState =
  | { status: "nofile" }
  | { status: "ready"; file: string; data: Data }
  | { status: "missing"; file: string }
  | { status: "error"; file: string; message: string };

export type Result = { ok: true } | { ok: false; message: string };

/** Functions the preload script exposes to the UI as `window.api`. */
export interface Api {
  getState(): Promise<FileState>;
  apply(op: Op): Promise<Result>;
  /** Show a save dialog and create a new, empty data file. */
  createFile(): Promise<Result>;
  /** Show an open dialog and switch to an existing data file. */
  openFile(): Promise<Result>;
  /** Try the configured file again (e.g. after mounting a drive). */
  retry(): Promise<void>;
  /** Show the data file in the system file manager. */
  revealFile(): Promise<void>;
  /** Called whenever the data or file changes (including edits from elsewhere). */
  onState(cb: (s: FileState) => void): void;
  /** Tell the main process the UI has rendered (used by the smoke test). */
  ready(): void;
}

declare global {
  interface Window { api?: Api }
}
