import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const targets = [
  { entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", external: ["vscode"], target: "node20" },
  { entryPoints: ["webview/index.tsx"], outfile: "dist/webview.js", platform: "browser", format: "iife", target: "es2022" },
];

for (const t of targets) {
  const options = { bundle: true, sourcemap: true, minify: !watch, logLevel: "info", ...t };
  if (watch) (await context(options)).watch();
  else await build(options);
}
