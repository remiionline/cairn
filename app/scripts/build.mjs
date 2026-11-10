// node scripts/build.mjs        -> build app into dist/
// node scripts/build.mjs test   -> bundle tests into dist-test/ for `node --test`
import esbuild from "esbuild";
import fs from "node:fs";

const mode = process.argv[2] ?? "build";

if (mode === "test") {
  fs.rmSync("dist-test", { recursive: true, force: true });
  await esbuild.build({
    entryPoints: ["test/model.test.ts", "test/storage.test.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: "dist-test",
    outExtension: { ".js": ".mjs" },
    logLevel: "warning",
  });
  process.exit(0);
}

fs.rmSync("dist", { recursive: true, force: true });
const common = { bundle: true, logLevel: "warning", target: "es2022", sourcemap: "linked" };

await Promise.all([
  esbuild.build({ ...common, entryPoints: ["src/main/main.ts"], platform: "node", format: "cjs", outfile: "dist/main.js", external: ["electron"] }),
  esbuild.build({ ...common, entryPoints: ["src/main/preload.ts"], platform: "node", format: "cjs", outfile: "dist/preload.js", external: ["electron"] }),
  esbuild.build({ ...common, entryPoints: ["src/renderer/app.ts"], platform: "browser", format: "iife", outfile: "dist/renderer/app.js" }),
]);
fs.copyFileSync("src/renderer/index.html", "dist/renderer/index.html");
fs.copyFileSync("src/renderer/styles.css", "dist/renderer/styles.css");
fs.copyFileSync("build/icon.png", "dist/icon.png");
fs.copyFileSync("build/icon.png", "dist/renderer/icon.png"); // sidebar logo and favicon
// Bundle the UI font so the app looks the same on every OS (SIL OFL licence).
fs.mkdirSync("dist/renderer/fonts", { recursive: true });
for (const f of ["inter-latin-wght-normal.woff2", "inter-latin-ext-wght-normal.woff2"]) {
  fs.copyFileSync(`node_modules/@fontsource-variable/inter/files/${f}`, `dist/renderer/fonts/${f}`);
}
console.log("built dist/");
