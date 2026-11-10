// npm run preview -> http://localhost:5179
// Serves the UI in a normal browser with in-memory sample data (nothing is saved).
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

execSync("node scripts/build.mjs", { stdio: "inherit" });
const root = path.resolve("dist/renderer");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
http.createServer((req, res) => {
  const url = req.url === "/" ? "/index.html" : (req.url ?? "/").split("?")[0];
  const file = path.join(root, url);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
}).listen(5179, () => console.log("Preview at http://localhost:5179"));
