// Copy python/ → dist/python/ for the production bundle. Cross-platform (Node fs, no shell cp).
// Excludes __pycache__ and tests (the daemon never needs them at runtime).
import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "python");
const dest = path.join(root, "dist", "python");

if (!existsSync(src)) {
  console.error("[copy-python] no python/ dir — skipping");
  process.exit(0);
}
await rm(dest, { recursive: true, force: true });
await mkdir(path.dirname(dest), { recursive: true });
await cp(src, dest, {
  recursive: true,
  filter: (s) => !s.includes("__pycache__") && !s.split(path.sep).includes("tests"),
});
console.log(`[copy-python] copied ${src} -> ${dest}`);
