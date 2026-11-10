import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileState, Result } from "../shared/api";
import { OpError, type Op, serialize, today } from "../shared/model";
import { sampleData } from "../shared/sample";
import { applyToFile, createDataFile, readDataFile, writeAtomic } from "./storage";

// ---------------------------------------------------------------------------
// Per-computer settings (which data file to use, window size). Stored in the
// OS's app-data folder, so each computer can point at the file by its own path
// (e.g. D:\Dashboard\projects.json on Windows, /mnt/d/Dashboard/projects.json on Linux).
// ---------------------------------------------------------------------------

interface Config {
  dataFile?: string;
  bounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
}

const SMOKE = process.argv.includes("--smoke-test");
// --demo: open a throwaway copy of the demo data. --screenshots <dir>: capture
// every view of the demo into <dir> (used for the README images), then quit.
const shotsArg = process.argv.indexOf("--screenshots");
const SHOTS_DIR = shotsArg >= 0 ? path.resolve(process.argv[shotsArg + 1] ?? "screenshots") : null;
const DEMO = process.argv.includes("--demo") || SHOTS_DIR !== null;
const HEADLESS = SMOKE || SHOTS_DIR !== null; // off-screen window, never steals focus
if (SMOKE) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "pd-smoke-")));
if (DEMO) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "cairn-demo-")));

const configPath = () => path.join(app.getPath("userData"), "config.json");

/** Where this computer's settings lived when the app was called "Project Dashboard". */
const legacyConfigPath = () => path.join(app.getPath("appData"), "Project Dashboard", "config.json");

function loadConfig(): Config {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch { /* fall through */ }
  // First run after the rename: keep the data file location and window size.
  if (!SMOKE && !DEMO) {
    try {
      const old = JSON.parse(fs.readFileSync(legacyConfigPath(), "utf8")) as Config;
      saveConfig(old);
      return old;
    } catch { /* nothing to carry over */ }
  }
  return {};
}

function saveConfig(c: Config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2));
}

let config: Config = {};
let win: BrowserWindow | null = null;
let state: FileState = { status: "nofile" };
let lastContents = "";
let watched: string | null = null;

function message(e: unknown): string {
  if (e instanceof OpError) return e.message;
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "EACCES" || err?.code === "EPERM") return "Permission denied: the data file or its folder can't be written.";
  if (err?.code === "ENOENT") return "The data file couldn't be found.";
  return err?.message ?? String(e);
}

function send() {
  win?.webContents.send("state", state);
}

/** (Re)load the configured file into `state`. */
function load() {
  const file = config.dataFile;
  if (!file) { state = { status: "nofile" }; unwatch(); return; }
  if (!fs.existsSync(file)) { state = { status: "missing", file }; watch(file); return; }
  try {
    const data = readDataFile(file);
    lastContents = serialize(data);
    state = { status: "ready", file, data };
  } catch (e) {
    state = { status: "error", file, message: message(e) };
  }
  watch(file);
}

// Polling works reliably on every filesystem, including NTFS drives mounted on Linux.
function watch(file: string) {
  if (watched === file) return;
  unwatch();
  watched = file;
  fs.watchFile(file, { interval: 1500 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
    const before = state.status === "ready" ? lastContents : null;
    load();
    if (state.status !== "ready" || lastContents !== before) send();
  });
}

function unwatch() {
  if (watched) fs.unwatchFile(watched);
  watched = null;
}

function useFile(file: string) {
  config.dataFile = file;
  saveConfig(config);
  load();
  send();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle("state:get", () => state);

ipcMain.handle("data:apply", (_e, op: Op): Result => {
  if (!config.dataFile) return { ok: false, message: "No data file is open." };
  try {
    const data = applyToFile(config.dataFile, op);
    lastContents = serialize(data);
    state = { status: "ready", file: config.dataFile, data };
    send();
    return { ok: true };
  } catch (e) {
    // Re-read so the UI shows what's actually on disk.
    load();
    send();
    return { ok: false, message: message(e) };
  }
});

ipcMain.handle("file:create", async (): Promise<Result> => {
  const r = await dialog.showSaveDialog(win!, {
    title: "Create a new data file",
    defaultPath: path.join(app.getPath("documents"), "projects.json"),
    filters: [{ name: "Cairn data", extensions: ["json"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (r.canceled || !r.filePath) return { ok: true };
  try {
    if (fs.existsSync(r.filePath)) {
      // Don't destroy an existing file: open it if it's ours.
      readDataFile(r.filePath);
    } else {
      createDataFile(r.filePath);
    }
    useFile(r.filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `${message(e)} Nothing was overwritten.` };
  }
});

ipcMain.handle("file:open", async (): Promise<Result> => {
  const r = await dialog.showOpenDialog(win!, {
    title: "Open a data file",
    filters: [{ name: "Cairn data", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: true };
  try {
    readDataFile(r.filePaths[0]);
    useFile(r.filePaths[0]);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: message(e) };
  }
});

ipcMain.handle("file:retry", () => { load(); send(); });
ipcMain.handle("file:reveal", () => { if (config.dataFile) shell.showItemInFolder(config.dataFile); });

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  // Screenshots render off-screen at 2560x1600 with 2x zoom: a 1280x800 layout
  // in sharp 2x pixels, not limited by the size of the monitor.
  const b = SHOTS_DIR ? { width: 2560, height: 1600 } as Config["bounds"] : config.bounds;
  win = new BrowserWindow({
    x: b?.x, y: b?.y,
    width: b?.width ?? 1200,
    height: b?.height ?? 820,
    minWidth: 360,
    minHeight: 400,
    title: "Cairn",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#1e1e1e",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(SHOTS_DIR ? { offscreen: true } : {}),
    },
    ...(SHOTS_DIR ? { useContentSize: true, frame: false } : {}),
  });
  if (SHOTS_DIR) {
    win.webContents.on("did-finish-load", () => win?.webContents.setZoomFactor(2));
    win.setContentSize(2560, 1600); // creation clamps to the screen; resizing afterwards doesn't
  }
  if (b?.maximized) win.maximize();
  win.once("ready-to-show", () => {
    if (SHOTS_DIR) return; // off-screen rendering needs no visible window
    if (!HEADLESS) { win?.show(); return; }
    // Smoke test / screenshots: show without focus, off-screen, so capturing works without disturbing anyone.
    win?.setPosition(-3000, -3000);
    win?.showInactive();
  });

  // Links in task text open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // F12 / Ctrl+Shift+I open developer tools; Ctrl+R reloads.
  win.webContents.on("before-input-event", (_e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) win?.webContents.toggleDevTools();
    if (input.control && input.key.toLowerCase() === "r") win?.webContents.reload();
  });

  win.on("close", () => {
    if (!win || SMOKE || DEMO) return;
    const nb = win.getNormalBounds();
    config.bounds = { ...nb, maximized: win.isMaximized() };
    saveConfig(config);
  });
  win.on("closed", () => { win = null; });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

if (!SMOKE && !DEMO && !app.requestSingleInstanceLock()) {
  // Only one copy at a time, so two windows never write the file at once.
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    config = loadConfig();
    if (DEMO) {
      const file = path.join(app.getPath("userData"), "demo", "cairn-demo.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(file, serialize(sampleData()));
      config.dataFile = file;
    }
    load();
    createWindow();
    if (SMOKE) runSmokeTest();
    if (SHOTS_DIR) runScreenshots(SHOTS_DIR);
  });
  app.on("window-all-closed", () => app.quit());
}

// ---------------------------------------------------------------------------
// Smoke test: `npm run smoke` launches the real app against a temporary data
// file, clicks through every view, saves screenshots, and fails on any error.
// ---------------------------------------------------------------------------

async function runSmokeTest() {
  const outDir = path.join(os.tmpdir(), "pd-smoke-shots");
  fs.mkdirSync(outDir, { recursive: true });
  const errors: string[] = [];
  const w = win!;
  w.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") errors.push(`[${e.level}] ${e.message}`);
  });
  w.webContents.on("render-process-gone", (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const js = (code: string) => w.webContents.executeJavaScript(code);
  const shot = async (name: string) => {
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };
  try {
    await new Promise<void>((r) => ipcMain.once("ui:ready", () => r()));
    await wait(300);
    await shot("0-setup");

    // Create a data file and fill it with sample data through the real IPC path.
    const file = path.join(app.getPath("userData"), "data", "projects.json");
    createDataFile(file);
    writeAtomic(file, serialize(sampleData()));
    useFile(file);
    await wait(400);

    for (const [i, tab] of ["overview", "project", "board", "history"].entries()) {
      await js(`document.querySelector('[data-mode="${tab}"]').click()`);
      await wait(900);
      await shot(`${i + 1}-${tab}`);
    }
    // Interact: complete a task via its checkbox and confirm it reached the file.
    await js(`document.querySelector('[data-mode="project"]').click()`);
    await wait(200);
    await js(`document.querySelector('.task .check:not(:checked)').click()`);
    await wait(500);
    const saved = readDataFile(file);
    const doneToday = saved.projects.some((p) => p.tasks.some((t) => t.status === "done" && t.completed === today()));
    if (!doneToday) errors.push("completing a task via its checkbox was not saved");
    if (!fs.existsSync(path.join(path.dirname(file), "projects.backups"))) errors.push("no backup folder created");
    // External edit is picked up.
    const ext = readDataFile(file);
    ext.projects[0].name = "Renamed elsewhere";
    fs.writeFileSync(file, serialize(ext));
    await wait(2500);
    const shown = await js(`document.body.innerText.includes("Renamed elsewhere")`);
    if (!shown) errors.push("external file change was not picked up");
  } catch (e) {
    errors.push(`smoke test threw: ${(e as Error).stack ?? e}`);
  }
  console.log(`SMOKE: screenshots in ${outDir}`);
  if (errors.length) { console.log("SMOKE FAILED\n" + errors.join("\n")); app.exit(1); }
  else { console.log("SMOKE PASSED"); app.exit(0); }
}

// ---------------------------------------------------------------------------
// Screenshots: `npm run screenshots` opens the demo data off-screen at
// 1280x800 (2x pixels) and saves one image per feature for the README.
// ---------------------------------------------------------------------------

async function runScreenshots(outDir: string) {
  fs.mkdirSync(outDir, { recursive: true });
  const w = win!;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const js = (code: string) => w.webContents.executeJavaScript(code);
  const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const clickText = (selector: string, text: string) =>
    js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)})?.click()`);
  const shot = async (name: string) => {
    await wait(700);
    w.webContents.invalidate(); // make sure the frame we capture is the current one
    await wait(300);
    await w.webContents.capturePage(); // first capture can lag one frame behind
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    console.log(`  ${name}.png`);
  };
  try {
    await new Promise<void>((r) => ipcMain.once("ui:ready", () => r()));
    await wait(500);
    // Put the pointer somewhere harmless so no hover states show.
    w.webContents.sendInputEvent({ type: "mouseMove", x: 2550, y: 1590 });

    await click('[data-mode="overview"]');
    await shot("overview");

    await click('[data-project="kitchen"]');
    await shot("project");

    await click('[data-project="web"]');
    await wait(300);
    await clickText(".task-text", "Write the About page");
    await shot("details");
    await js(`document.querySelector(".drawer-bg")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);

    await click('[data-mode="board"]');
    await shot("board");

    await click('[data-project="chores"]');
    await shot("repeating");

    await click('[data-mode="history"]');
    await wait(300);
    await js(`(() => { const m = document.querySelector(".main"); const h = document.querySelector(".cal-head"); if (m && h) m.scrollTop = h.offsetTop - 12; })()`);
    await shot("calendar");

    await click('[data-mode="overview"]');
    await wait(300);
    await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`);
    await wait(200);
    await js(`(() => { const i = document.querySelector(".switcher-input"); i.value = "pa"; i.dispatchEvent(new Event("input")); })()`);
    await shot("switcher");
    await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await js(`document.querySelector(".modal-bg")?.remove()`);

    nativeTheme.themeSource = "light";
    await click('[data-mode="overview"]');
    await shot("overview-light");
    await click('[data-mode="board"]');
    await shot("board-light");
    nativeTheme.themeSource = "system";

    console.log(`Screenshots saved to ${outDir}`);
    app.exit(0);
  } catch (e) {
    console.log(`Screenshots failed: ${(e as Error).stack ?? e}`);
    app.exit(1);
  }
}
