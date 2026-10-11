// Thin wrappers around the pinned HyperFrames CLI, plus staging of the brand kit into a
// composition folder (HyperFrames only serves files inside the composition's own folder).
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BRAND_DIR, HYPERFRAMES_BIN, brandPaths } from "../core/paths.ts";
import { run, ffmpeg, ffprobeJson, type RunOptions } from "../core/proc.ts";

const HF_ENV = { HYPERFRAMES_NO_TELEMETRY: "1", PRODUCER_BROWSER_GPU_MODE: "hardware" };
type Opts = Pick<RunOptions, "signal" | "log" | "onStderrLine" | "onStdoutLine">;

/** Copy brand/kit (fonts, tokens.css, components.css, gsap) into <dir>/kit, replacing any old copy. */
export async function stageKit(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await rm(join(dir, "kit"), { recursive: true, force: true });
  await cp(join(BRAND_DIR, "kit"), join(dir, "kit"), { recursive: true });
}

export type CheckResult = { ok: boolean; errors: number; warnings: number; output: string };

/** `hyperframes lint` + `hyperframes check` (headless Chrome, console errors). */
export async function checkComposition(dir: string, opts: Opts = {}): Promise<CheckResult> {
  let output = "";
  let ok = true;
  for (const cmd of ["lint", "check"]) {
    try {
      const r = await run(HYPERFRAMES_BIN, [cmd, dir], { ...opts, env: HF_ENV, timeoutMs: 180_000 });
      output += `$ hyperframes ${cmd}\n${r.stdout}\n${r.stderr}\n`;
    } catch (e) {
      ok = false;
      output += `$ hyperframes ${cmd}\n${(e as Error).message}\n`;
    }
  }
  const errors = Number(/(\d+)\s+error\(s\)/.exec(output)?.[1] ?? (ok ? 0 : 1));
  const warnings = Number(/(\d+)\s+warning\(s\)/.exec(output)?.[1] ?? 0);
  return { ok: ok && errors === 0, errors, warnings, output: strip(output) };
}

/** Snapshot one frame at `at` seconds to `outPng`. */
export async function snapshotComposition(dir: string, at: number, outPng: string, opts: Opts = {}): Promise<string> {
  const snapDir = join(dir, "snapshots");
  await rm(snapDir, { recursive: true, force: true });
  await run(HYPERFRAMES_BIN, ["snapshot", dir, "--at", at.toFixed(2)], { ...opts, env: HF_ENV, timeoutMs: 180_000 });
  const pngs = (await readdir(snapDir)).filter((f) => f.endsWith(".png") && f.startsWith("frame-00"));
  if (!pngs[0]) throw new Error(`hyperframes snapshot produced no frame for ${dir}`);
  await mkdir(dirname(outPng), { recursive: true });
  await rename(join(snapDir, pngs[0]), outPng);
  await rm(snapDir, { recursive: true, force: true });
  return outPng;
}

/** Render a composition. `mov` = ProRes 4444 with alpha (what the final render overlays). */
export async function renderComposition(
  dir: string,
  out: string,
  o: Opts & { format?: "mov" | "mp4" | "webm"; fps?: number; variables?: Record<string, string>; onProgress?: (f: number) => void } = {},
): Promise<string> {
  await mkdir(dirname(out), { recursive: true });
  const part = out.replace(/(\.[a-z0-9]+)$/i, ".part$1");
  const args = ["render", dir, "--format", o.format ?? "mov", "--fps", String(o.fps ?? 30), "--quality", "high", "-o", part];
  if (o.variables) args.push("--variables", JSON.stringify(o.variables));
  await run(HYPERFRAMES_BIN, args, {
    ...o,
    env: HF_ENV,
    timeoutMs: 30 * 60_000,
    onStderrLine: (l) => {
      o.onStderrLine?.(l);
      const m = /(\d{1,3})%/.exec(l);
      if (m && o.onProgress) o.onProgress(Math.min(1, Number(m[1]) / 100));
    },
  });
  if (!existsSync(part) || statSync(part).size === 0) throw new Error(`hyperframes render produced no output for ${dir}`);
  await rename(part, out);
  return out;
}

/** Transparent ProRes .mov -> small VP9-alpha .webm for the browser preview. */
export async function movToPreviewWebm(mov: string, webm: string, opts: Opts = {}): Promise<string> {
  const part = webm.replace(/\.webm$/, ".part.webm");
  await ffmpeg(["-i", mov, "-vf", "scale=-2:720", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "34",
    "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-an", part], opts);
  await rename(part, webm);
  return webm;
}

export async function mediaDuration(file: string): Promise<number> {
  const j = await ffprobeJson(file);
  return Number(j.format?.duration ?? 0);
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Render the brand intro (shared by every video) if it is missing. */
export async function ensureIntro(opts: Opts = {}): Promise<string | null> {
  if (existsSync(brandPaths.intro)) return brandPaths.intro;
  const dir = join(brandPaths.templatesDir, "intro");
  if (!existsSync(join(dir, "index.html"))) return null;
  await stageKit(dir);
  return renderComposition(dir, brandPaths.intro, opts);
}

/** The end card for one video: rendered with its "next up" title, cached by title. */
export async function ensureOutro(cacheDir: string, nextTitle: string, opts: Opts = {}): Promise<string | null> {
  const dir = join(brandPaths.templatesDir, "outro");
  if (!existsSync(join(dir, "index.html"))) return null;
  if (!nextTitle.trim()) {
    if (existsSync(brandPaths.outro)) return brandPaths.outro;
    await stageKit(dir);
    return renderComposition(dir, brandPaths.outro, opts);
  }
  const { createHash } = await import("node:crypto");
  const key = createHash("sha1").update(nextTitle).digest("hex").slice(0, 10);
  const out = join(cacheDir, `outro-${key}.mov`);
  if (existsSync(out)) return out;
  await stageKit(dir);
  return renderComposition(dir, out, { ...opts, variables: { nextTitle } });
}
