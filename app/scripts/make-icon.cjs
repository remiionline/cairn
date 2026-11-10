// Renders build/icon.svg to build/icon.png (512x512) using Electron.
// Run with: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "..", "build", "icon.svg"), "utf8");
  const win = new BrowserWindow({ width: 512, height: 512, x: -3000, y: -3000, frame: false, transparent: true, show: false, useContentSize: true });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace("<svg ", '<svg width="512" height="512" ')}</body></html>`));
  win.showInactive();
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = img.resize({ width: 512, height: 512 });
  fs.writeFileSync(path.join(__dirname, "..", "build", "icon.png"), out.toPNG());
  console.log("wrote build/icon.png", out.getSize());
  app.exit(0);
});
