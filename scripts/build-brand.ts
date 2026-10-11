// Validate every brand template, write a preview still for each to brand/previews/, and render the
// shared intro + default end card to brand/renders/. Run after changing anything in brand/.
//   pnpm brand            (all)        pnpm brand side-card checklist   (some)
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { brandPaths, BRAND_DIR } from "../src/core/paths.ts";
import { checkComposition, ensureIntro, ensureOutro, snapshotComposition, stageKit } from "../src/graphics/hyperframes.ts";

const only = process.argv.slice(2);
const all = (await readdir(brandPaths.templatesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
const names = only.length ? all.filter((n) => only.includes(n)) : all;
let failed = 0;

for (const name of names) {
  const dir = join(brandPaths.templatesDir, name);
  if (!existsSync(join(dir, "index.html"))) continue;
  await stageKit(dir);
  const check = await checkComposition(dir);
  const html = await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "index.html"), "utf8"));
  const dur = Number(/data-duration="([\d.]+)"/.exec(html)?.[1] ?? 2);
  const still = await snapshotComposition(dir, Math.min(dur - 0.6, Math.max(1.5, dur * 0.6)), join(BRAND_DIR, "previews", `${name}.png`));
  console.log(`${check.ok ? "ok  " : "FAIL"} ${name}  (${check.errors} errors, ${check.warnings} warnings) → ${still}`);
  if (!check.ok) {
    failed++;
    console.log(check.output.split("\n").filter((l) => /error|✗|×/i.test(l)).slice(0, 10).join("\n"));
  }
}

if (!only.length || only.includes("intro")) console.log("intro →", await ensureIntro());
if (!only.length || only.includes("outro")) console.log("outro →", await ensureOutro(join(BRAND_DIR, "renders"), ""));
process.exit(failed ? 1 : 0);
