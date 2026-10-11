// Per-cue motion graphics: Claude writes a HyperFrames composition in the locked brand style,
// the server checks it, snapshots a still, renders a transparent ProRes 4444 .mov for the final
// render and a VP9-alpha .webm for the browser preview.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ClaudeEvent } from "../claude/runner.ts";
import { runClaude } from "../claude/runner.ts";
import { BRAND_DIR, HYPERFRAMES_BIN, PROMPTS_DIR, REPO_ROOT, projectPaths } from "../core/paths.ts";
import {
  EditSchema, ScriptDocSchema, TranscriptSchema, overlaySide,
  type Asset, type Edit, type Overlay, type Project, type Timeline, type Transcript,
} from "../core/schema.ts";
import { loadConfig, loadProject, readJsonIfExists } from "../core/store.ts";
import { buildTimeline, keptWordIds, sourceToOutput } from "../core/timeline.ts";
import type { GraphicState, GraphicStatus } from "../server/api.ts";
import { checkComposition, mediaDuration, movToPreviewWebm, renderComposition, snapshotComposition, stageKit } from "./hyperframes.ts";

export type BuildGraphicOptions = {
  note?: string; // the user's "regenerate with note" feedback
  force?: boolean; // rebuild even if the current graphic is up to date
  signal?: AbortSignal;
  onEvent?: (e: ClaudeEvent) => void;
  onProgress?: (fraction: number, message: string) => void;
};

type StoredStatus = {
  state: GraphicState;
  message: string;
  updatedAt: string;
  durationSec?: number;
  side?: "left" | "right";
  layout?: Overlay["layout"];
  fingerprint?: string;
};

type Zone = "right-wide" | "left-wide" | "left-narrow" | "right-narrow" | "full";

type Ctx = { project: Project; edit: Edit; transcript: Transcript; timeline: Timeline; fps: number; width: number; height: number };

async function loadCtx(slug: string): Promise<Ctx> {
  const paths = projectPaths(slug);
  const [project, config, edit, transcript] = await Promise.all([
    loadProject(slug), loadConfig(), readJsonIfExists(paths.edit, EditSchema), readJsonIfExists(paths.transcript, TranscriptSchema),
  ]);
  if (!edit || !transcript) throw new Error("No edit yet: run Transcribe and Plan edit first");
  const timeline = buildTimeline(edit, transcript, project.clips, config);
  return { project, edit, transcript, timeline, fps: config.output.fps, width: config.output.width, height: config.output.height };
}

/** Where the graphic goes, from the framing + the overlay's layout/side. */
export function zonesFor(speakerSide: Project["speakerSide"], layout: Overlay["layout"], side: "left" | "right"): Zone[] {
  if (layout === "full") return ["full"];
  if (speakerSide === "center") return layout === "split" ? ["left-narrow", "right-narrow"] : [side === "left" ? "left-narrow" : "right-narrow"];
  return [speakerSide === "left" ? "right-wide" : "left-wide"]; // split only makes sense centred
}

function overlayAssets(project: Project, ov: Overlay): Asset[] {
  const ids = new Set(ov.assetIds);
  return project.assets.filter((a) => ids.has(a.id) || a.cueId === ov.cueId);
}

function placement(ctx: Ctx, ov: Overlay) {
  const placed = ctx.timeline.overlays.find((p) => p.overlayId === ov.id);
  if (!placed) return null;
  const frame = 1 / ctx.fps;
  const durationSec = Math.max(frame * 15, Math.round((placed.end - placed.start) * ctx.fps) / ctx.fps);
  return { start: placed.start, end: placed.end, durationSec };
}

function fingerprint(ctx: Ctx, ov: Overlay, durationSec: number): string {
  const side = overlaySide(ov, ctx.project.speakerSide);
  const assets = overlayAssets(ctx.project, ov).map((a) => ({ f: a.file, c: a.crop, b: a.blur, h: a.highlight }));
  return createHash("sha1")
    .update(JSON.stringify({ d: durationSec.toFixed(2), side, layout: ov.layout, framing: ctx.project.speakerSide, brief: ov.brief, assets }))
    .digest("hex")
    .slice(0, 16);
}

function wordsInWindow(ctx: Ctx, start: number, end: number) {
  const kept = keptWordIds(ctx.edit, ctx.transcript);
  const out: { t: number; end: number; text: string }[] = [];
  for (const w of ctx.transcript.words) {
    if (!kept.has(w.id)) continue;
    const t = sourceToOutput(ctx.timeline, w.clipId, w.start);
    if (t === null || t < start - 0.05 || t > end) continue;
    const te = sourceToOutput(ctx.timeline, w.clipId, w.end) ?? t + (w.end - w.start);
    out.push({ t: Math.max(0, Math.round((t - start) * 100) / 100), end: Math.round((te - start) * 100) / 100, text: w.text });
  }
  return out;
}

const statusFile = (slug: string, cueId: string) => join(projectPaths(slug).graphic(cueId), "status.json");

async function readStored(slug: string, cueId: string): Promise<StoredStatus | null> {
  const f = statusFile(slug, cueId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(await readFile(f, "utf8")) as StoredStatus;
  } catch {
    return null;
  }
}

async function writeStored(slug: string, cueId: string, s: StoredStatus) {
  await mkdir(projectPaths(slug).graphic(cueId), { recursive: true });
  await writeFile(statusFile(slug, cueId), JSON.stringify(s, null, 2) + "\n");
}

function toPublic(slug: string, cueId: string, s: StoredStatus | null, currentFingerprint: string | null, ov?: Overlay, speakerSide?: Project["speakerSide"]): GraphicStatus {
  const p = projectPaths(slug);
  const url = (file: string) => (existsSync(file) ? `/media/${slug}/graphics/${cueId}/${basename(file)}?v=${Math.round(statSync(file).mtimeMs)}` : undefined);
  const status: GraphicStatus = {
    cueId,
    state: s?.state ?? "none",
    message: s?.message ?? "",
    hasMov: existsSync(p.graphicMov(cueId)),
    stale: Boolean(s?.state === "ready" && currentFingerprint && s.fingerprint !== currentFingerprint),
  };
  if (s?.updatedAt) status.updatedAt = s.updatedAt;
  if (s?.durationSec !== undefined) status.durationSec = s.durationSec;
  const side = s?.side ?? (ov && speakerSide ? overlaySide(ov, speakerSide) : undefined);
  if (side) status.side = side;
  const layout = s?.layout ?? ov?.layout;
  if (layout) status.layout = layout;
  const still = url(p.graphicStill(cueId));
  if (still) status.still = still;
  const webm = url(p.graphicWebm(cueId));
  if (webm) status.webm = webm;
  return status;
}

/** Status of every overlay's graphic, including whether it is stale against the current edit. */
export async function graphicStatuses(slug: string): Promise<Record<string, GraphicStatus>> {
  let ctx: Ctx;
  try {
    ctx = await loadCtx(slug);
  } catch {
    return {};
  }
  const out: Record<string, GraphicStatus> = {};
  for (const ov of ctx.edit.overlays) {
    const place = placement(ctx, ov);
    const fp = place ? fingerprint(ctx, ov, place.durationSec) : null;
    out[ov.cueId] = toPublic(slug, ov.cueId, await readStored(slug, ov.cueId), fp, ov, ctx.project.speakerSide);
  }
  return out;
}

export type PreparedGraphic = {
  slug: string;
  cueId: string;
  dir: string;
  durationSec: number;
  side: "left" | "right";
  layout: Overlay["layout"];
  fingerprint: string;
  prompt: string; // the user prompt a graphics run receives
  systemPromptFile: string;
  allowedTools: string[];
  upToDate: GraphicStatus | null; // set when nothing needs building (and not forced)
};

/** Stage the brand kit + assets and write input.json for one cue. Nothing calls Claude here. */
export async function prepareGraphic(slug: string, cueId: string, opts: Pick<BuildGraphicOptions, "note" | "force"> = {}): Promise<PreparedGraphic> {
  const ctx = await loadCtx(slug);
  const paths = projectPaths(slug);
  const ov = ctx.edit.overlays.find((o) => o.cueId === cueId);
  if (!ov) throw new Error(`No overlay for cue ${cueId} in the edit`);
  const place = placement(ctx, ov);
  if (!place) throw new Error(`Overlay ${cueId} is disabled or has no time in the cut`);
  const fp = fingerprint(ctx, ov, place.durationSec);
  const side = overlaySide(ov, ctx.project.speakerSide);
  const dir = paths.graphic(cueId);
  const base = {
    slug, cueId, dir, durationSec: place.durationSec, side, layout: ov.layout, fingerprint: fp,
    systemPromptFile: join(PROMPTS_DIR, "graphic.md"),
    allowedTools: [
      "Read", "Glob", "Grep", "Skill",
      `Write(/${dir}/index.html)`, `Edit(/${dir}/index.html)`,
      `Bash(${HYPERFRAMES_BIN} lint:*)`, `Bash(${HYPERFRAMES_BIN} check:*)`,
    ],
  };
  const prev = await readStored(slug, cueId);
  if (!opts.force && !opts.note && prev?.state === "ready" && prev.fingerprint === fp && existsSync(paths.graphicMov(cueId))) {
    return { ...base, prompt: "", upToDate: toPublic(slug, cueId, prev, fp, ov, ctx.project.speakerSide) };
  }

  await writeStored(slug, cueId, { state: "building", message: "Claude is designing the graphic", updatedAt: new Date().toISOString(), durationSec: place.durationSec, side, layout: ov.layout });
  await stageKit(dir);

  // Screenshots for B-roll: copy into the graphic folder (HyperFrames serves only that folder).
  const assets = [];
  for (const a of overlayAssets(ctx.project, ov)) {
    const name = `${a.id}${extname(a.file)}`;
    await mkdir(join(dir, "assets"), { recursive: true });
    await copyFile(join(paths.root, a.file), join(dir, "assets", name));
    assets.push({ file: `assets/${name}`, width: a.width, height: a.height, crop: a.crop ?? null, blur: a.blur, highlight: a.highlight });
  }

  const script = await readJsonIfExists(paths.script, ScriptDocSchema);
  const cue = script?.cues.find((c) => c.id === cueId);
  const input = {
    cueId,
    cue: cue ? { kind: cue.kind, text: cue.text, flags: cue.flags, optional: cue.optional } : null,
    brief: ov.brief,
    note: opts.note ?? null,
    durationSec: place.durationSec,
    fps: ctx.fps,
    canvas: { width: ctx.width, height: ctx.height },
    speakerSide: ctx.project.speakerSide,
    layout: ov.layout,
    side,
    zones: zonesFor(ctx.project.speakerSide, ov.layout, side),
    words: wordsInWindow(ctx, place.start, place.end),
    assets,
    previous: existsSync(join(dir, "index.html")) ? "index.html" : null,
    commands: [`${HYPERFRAMES_BIN} lint ${dir}`, `${HYPERFRAMES_BIN} check ${dir}`],
    brandSpec: join(BRAND_DIR, "BRAND.md"),
    templatesDir: join(BRAND_DIR, "templates"),
  };
  await writeFile(join(dir, "input.json"), JSON.stringify(input, null, 2) + "\n");
  const prompt = `Build the motion graphic for cue ${cueId}. Your graphic folder is ${dir}. Read ${join(dir, "input.json")} first, then ${input.brandSpec}, then the closest template in ${input.templatesDir}. Write ${join(dir, "index.html")} and validate it with the two commands in input.json.`;
  return { ...base, prompt, upToDate: null };
}

/** Server-side checks on whatever Claude wrote: lint + check + the declared duration. */
export async function validateGraphic(prep: PreparedGraphic, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  const file = join(prep.dir, "index.html");
  if (!existsSync(file)) return { ok: false, output: "index.html was not written" };
  const check = await checkComposition(prep.dir, { signal });
  if (!check.ok) return { ok: false, output: check.output };
  const html = await readFile(file, "utf8");
  const declared = Number(/data-composition-id="main"[^>]*data-duration="([\d.]+)"|data-duration="([\d.]+)"[^>]*data-composition-id="main"/.exec(html)?.slice(1).find(Boolean) ?? NaN);
  if (!Number.isFinite(declared) || Math.abs(declared - prep.durationSec) > 1 / 30 + 1e-6) {
    return { ok: false, output: `The root declares data-duration=${declared}; it must be ${prep.durationSec.toFixed(2)} (input.json durationSec).` };
  }
  return { ok: true, output: check.output };
}

/** Snapshot, render ProRes 4444 + VP9-alpha preview, verify the length, mark ready. */
export async function finishGraphic(prep: PreparedGraphic, opts: Pick<BuildGraphicOptions, "signal" | "onProgress"> = {}): Promise<GraphicStatus> {
  const progress = opts.onProgress ?? (() => {});
  const paths = projectPaths(prep.slug);
  const { cueId, dir } = prep;
  const set = (state: GraphicState, message: string, extra: Partial<StoredStatus> = {}) =>
    writeStored(prep.slug, cueId, { state, message, updatedAt: new Date().toISOString(), durationSec: prep.durationSec, side: prep.side, layout: prep.layout, ...extra });
  await set("rendering", "Rendering the transparent overlay");
  progress(0.55, `${cueId}: snapshot`);
  await snapshotComposition(dir, Math.min(prep.durationSec - 0.5, Math.max(0.8, prep.durationSec * 0.6)), paths.graphicStill(cueId), { signal: opts.signal });
  progress(0.6, `${cueId}: rendering`);
  await renderComposition(dir, paths.graphicMov(cueId), {
    format: "mov", fps: 30, signal: opts.signal,
    onProgress: (f) => progress(0.6 + f * 0.3, `${cueId}: rendering ${Math.round(f * 100)}%`),
  });
  const got = await mediaDuration(paths.graphicMov(cueId));
  if (Math.abs(got - prep.durationSec) > 2 / 30) throw new Error(`Rendered ${got.toFixed(2)} s, expected ${prep.durationSec.toFixed(2)} s`);
  progress(0.92, `${cueId}: preview`);
  await movToPreviewWebm(paths.graphicMov(cueId), paths.graphicWebm(cueId), { signal: opts.signal });
  const where = prep.layout === "split" ? "both sides" : prep.layout === "full" ? "full frame" : `${prep.side} side`;
  await set("ready", `Built for ${prep.durationSec.toFixed(2)} s, ${where}`, { fingerprint: prep.fingerprint });
  progress(1, `${cueId}: ready`);
  const ctx = await loadCtx(prep.slug);
  const ov = ctx.edit.overlays.find((o) => o.cueId === cueId);
  return toPublic(prep.slug, cueId, await readStored(prep.slug, cueId), prep.fingerprint, ov, ctx.project.speakerSide);
}

/** Build (or rebuild) the graphic for one overlay cue: prepare → Claude writes index.html → validate (one fix-up round) → render. */
export async function buildGraphic(slug: string, cueId: string, opts: BuildGraphicOptions = {}): Promise<GraphicStatus> {
  const progress = opts.onProgress ?? (() => {});
  progress(0.02, `${cueId}: preparing`);
  const prep = await prepareGraphic(slug, cueId, opts);
  if (prep.upToDate) return prep.upToDate;
  const paths = projectPaths(slug);
  try {
    const config = await loadConfig();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runClaudeOnce = (extra: string) =>
      runClaude({
        prompt: prep.prompt + extra,
        appendSystemPromptFile: prep.systemPromptFile,
        allowedTools: prep.allowedTools,
        model: config.claude.model,
        maxTurns: 30,
        cwd: REPO_ROOT,
        addDirs: [prep.dir],
        env: { HYPERFRAMES_NO_TELEMETRY: "1" },
        signal: opts.signal,
        logFile: join(paths.runsDir, `graphic-${cueId}-${stamp}.jsonl`),
        onEvent: opts.onEvent,
      });
    progress(0.05, `${cueId}: Claude is designing`);
    await runClaudeOnce("");
    let v = await validateGraphic(prep, opts.signal);
    if (!v.ok) {
      progress(0.45, `${cueId}: fixing validation errors`);
      await runClaudeOnce(`\n\nThe last version failed validation. Fix these errors and nothing else:\n${v.output.slice(-3000)}`);
      v = await validateGraphic(prep, opts.signal);
      if (!v.ok) throw new Error(`HyperFrames validation failed:\n${v.output.slice(-1500)}`);
    }
    return await finishGraphic(prep, opts);
  } catch (e) {
    await writeStored(slug, cueId, { state: "error", message: (e as Error).message.slice(0, 800), updatedAt: new Date().toISOString(), durationSec: prep.durationSec, side: prep.side, layout: prep.layout });
    throw e;
  }
}
