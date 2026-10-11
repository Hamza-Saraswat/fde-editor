// Offline end-to-end: the committed fixture take (macOS `say`) over a generated test-pattern video,
// through import → transcribe (recorded Parakeet words) → align → plan (deterministic stand-in for
// Claude) → preview → graphics (brand template stand-in for Claude) → final render → sidecars.
// Run: pnpm test:e2e     (needs ffmpeg + the pinned HyperFrames CLI; ~3–5 min on an M2)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// projectsDir() reads FDE_PROJECTS_DIR lazily, but set it before anything else runs anyway.
const env = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fde-e2e-"));
  process.env.FDE_PROJECTS_DIR = join(dir, "projects");
  return { dir };
});

import { REPO_ROOT, projectPaths, brandPaths } from "../../src/core/paths.ts";
import { parseScript } from "../../src/core/script-parser.ts";
import { ProjectSchema, ScriptDocSchema, CandidatesSchema, EditSchema, type EditPlan, type Candidates, type ScriptDoc, type Transcript } from "../../src/core/schema.ts";
import { loadConfig, writeJson, loadProject } from "../../src/core/store.ts";
import { probeClip } from "../../src/media/probe.ts";
import { prepareClip } from "../../src/media/prepare.ts";
import { transcribeProject, type Transcriber } from "../../src/transcribe/index.ts";
import { alignScript } from "../../src/core/aligner.ts";
import { planToEdit } from "../../src/core/compiler.ts";
import { buildTimeline, keptWordIds } from "../../src/core/timeline.ts";
import { buildPreview, renderFinal } from "../../src/media/render.ts";
import { measureLoudness } from "../../src/media/loudness.ts";
import { chaptersText, srtFromTimeline } from "../../src/media/sidecars.ts";
import { ensureIntro, ensureOutro, renderComposition, stageKit } from "../../src/graphics/hyperframes.ts";
import { isFillerWord } from "../../src/core/normalize.ts";

const FIX = join(REPO_ROOT, "test/fixtures/e2e");
const slug = "e2e";
const paths = projectPaths(slug);

/** Deterministic stand-in for Claude's edit plan, built from the aligner's output. */
function standInPlan(script: ScriptDoc, t: Transcript, cand: Candidates): EditPlan {
  const byId = new Map(t.words.map((w, i) => [w.id, i]));
  const takes = cand.sentences
    .filter((s) => s.chosen !== null)
    .map((s) => ({
      sentenceIds: [s.sentenceId],
      chosen: { startWordId: s.occurrences[s.chosen!]!.startWordId, endWordId: s.occurrences[s.chosen!]!.endWordId },
      alternates: s.occurrences.filter((_, i) => i !== s.chosen).map((o) => ({ startWordId: o.startWordId, endWordId: o.endWordId })),
      why: "aligner pick",
    }));
  const text = (a: string, b: string) => t.words.slice(byId.get(a)!, byId.get(b)! + 1).map((w) => w.text).join(" ").toLowerCase();
  const adlibs = cand.adlibs.map((a) => ({ startWordId: a.startWordId, endWordId: a.endWordId, keep: !text(a.startWordId, a.endWordId).includes("redo"), why: "stand-in" }));
  const chosenStart = new Map(cand.sentences.filter((s) => s.chosen !== null).map((s) => [s.sentenceId, s.occurrences[s.chosen!]!]));
  const order = script.sentences.map((s) => s.id);
  const cues = script.cues.filter((c) => !c.optional).flatMap((c) => {
    const nextIdx = c.afterSentenceId ? order.indexOf(c.afterSentenceId) + 1 : 0;
    const anchor = order.slice(nextIdx).map((id) => chosenStart.get(id)).find(Boolean);
    const endOcc = order.slice(nextIdx).map((id) => chosenStart.get(id)).filter(Boolean)[1] ?? anchor;
    if (!anchor || !endOcc) return [];
    return [{ cueId: c.id, include: true, anchorWordId: anchor.startWordId, endWordId: endOcc.endWordId, layout: "side" as const, brief: c.text }];
  });
  return { takes, adlibs, wordCuts: [], fillerGaps: t.fillers.filter((f) => f.kind === "gap").map((f) => ({ fillerId: f.id, cut: true })), cues, notes: "e2e stand-in" };
}

let duration = 0;
const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const probe = (file: string, entries: string, stream = "v:0") =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "csv=p=0", file]).toString().trim();

describe("end to end on the fixture take", () => {
  let script: ScriptDoc, transcript: Transcript, candidates: Candidates;
  let final: Awaited<ReturnType<typeof renderFinal>>;
  let timeline: ReturnType<typeof buildTimeline>;

  beforeAll(async () => {
    expect(paths.root.startsWith(env.dir)).toBe(true); // never touch the real projects/ folder
    const config = await loadConfig();
    // The "recording": 1280x720 test pattern + the fixture audio (the renderer scales to 2560x1440).
    const src = join(env.dir, "take.mp4");
    const aud = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(FIX, "take.mp3")]).toString());
    ff(["-f", "lavfi", "-i", `testsrc2=s=1280x720:r=30:d=${aud.toFixed(3)}`, "-i", join(FIX, "take.mp3"), "-c:v", "h264_videotoolbox", "-q:v", "50", "-c:a", "aac", "-shortest", src]);

    mkdirSync(paths.root, { recursive: true });
    const md = readFileSync(join(FIX, "script.md"), "utf8");
    writeFileSync(paths.scriptMd, md);
    script = await writeJson(paths.script, ScriptDocSchema, parseScript(md));
    const clip = await probeClip(src, "c1");
    await writeJson(paths.project, ProjectSchema, { slug, title: "E2E", createdAt: new Date().toISOString(), scriptSource: join(FIX, "script.md"), speakerSide: "left", clips: [clip] });
    await prepareClip(slug, clip, {});

    const recorded = JSON.parse(readFileSync(join(FIX, "transcript-parakeet.json"), "utf8")) as { text: string; start: number; end: number }[];
    const fake: Transcriber = { name: "fixture-parakeet", engineKey: "local-parakeet", model: "fixture", input: "wav16k", transcribe: async () => recorded.map(({ text, start, end }) => ({ text, start, end })) } as Transcriber;
    transcript = await transcribeProject(slug, { transcriber: fake });
    candidates = await writeJson(paths.candidates, CandidatesSchema, alignScript(script, transcript));

    const project = await loadProject(slug);
    const { edit } = planToEdit(standInPlan(script, transcript, candidates), { script, transcript, candidates, clips: project.clips });
    await writeJson(paths.edit, EditSchema, edit);
    timeline = buildTimeline(edit, transcript, project.clips, config);
    duration = timeline.duration;

    await buildPreview(slug, timeline, {});

    // Graphics: the side-card template stretched to each overlay's length (stand-in for Claude).
    const tpl = readFileSync(join(brandPaths.templatesDir, "side-card", "index.html"), "utf8");
    const overlays = [];
    for (const o of timeline.overlays) {
      const d = (Math.round((o.end - o.start) * 30) / 30).toFixed(2);
      const dir = paths.graphic(o.cueId);
      mkdirSync(dir, { recursive: true });
      await stageKit(dir);
      writeFileSync(join(dir, "index.html"), tpl.replaceAll('data-duration="6"', `data-duration="${d}"`).replace("const D = 6;", `const D = ${d};`));
      await renderComposition(dir, paths.graphicMov(o.cueId), { format: "mov" });
      overlays.push({ cueId: o.cueId, file: paths.graphicMov(o.cueId), start: o.start, end: o.end });
    }
    final = await renderFinal(slug, timeline, { overlays, intro: (await ensureIntro()) ?? undefined, outro: (await ensureOutro(paths.cacheDir, "What a forward deployed engineer actually does")) ?? undefined });
  }, 900_000);

  it("parses the excerpt and aligns it: retake resolved to the clean attempt, skipped line missing", () => {
    expect(script.cues.filter((c) => c.kind === "gfx").length).toBeGreaterThanOrEqual(3);
    const skipped = script.sentences.find((s) => s.text.startsWith("That's machine learning research"))!;
    expect(candidates.missing).toContain(skipped.id);
    const retake = script.sentences.find((s) => s.text.startsWith("The other wants someone"))!;
    const entry = candidates.sentences.find((s) => s.sentenceId === retake.id)!;
    expect(entry.chosen).toBe(entry.occurrences.length - 1);
  });

  it("cuts fillers and the 'let me redo that' false start, keeps the good ad-lib", async () => {
    const edit = EditSchema.parse(JSON.parse(readFileSync(paths.edit, "utf8")));
    const kept = keptWordIds(edit, transcript);
    const keptText = transcript.words.filter((w) => kept.has(w.id)).map((w) => w.text.toLowerCase()).join(" ");
    expect(transcript.words.filter((w) => kept.has(w.id) && isFillerWord(w.text))).toEqual([]);
    expect(keptText).not.toContain("redo");
    expect(keptText).toContain("trips up a lot of people");
    expect(keptText).toContain("waste six months");
    expect(keptText).toMatch(/using the same title/); // a short line inside a longer one is not a retake
    expect(duration).toBeLessThan(96 - 8); // dead air, flub and fillers removed
  });

  it("preview: exact frames and A/V lengths", () => {
    const frames = Number(probe(paths.preview, "stream=nb_frames"));
    expect(frames).toBe(timeline.segments.reduce((n, s) => n + s.frames, 0));
    const v = Number(probe(paths.preview, "stream=duration"));
    const a = Number(probe(paths.preview, "stream=duration", "a:0"));
    expect(Math.abs(v - a)).toBeLessThan(1 / 30);
  });

  it("final: duration = intro + A-roll + outro (±1 frame), A/V match, 2560x1440", () => {
    const v = Number(probe(paths.final, "stream=duration"));
    const a = Number(probe(paths.final, "stream=duration", "a:0"));
    expect(Math.abs(v - (final.introSeconds + final.arollSeconds + final.outroSeconds))).toBeLessThanOrEqual(1 / 30 + 1e-6);
    expect(Math.abs(v - a)).toBeLessThan(2 / 30);
    expect(probe(paths.final, "stream=width,height")).toBe("2560,1440");
  });

  it("final: loudness within ±1 LU of −14", async () => {
    const m = await measureLoudness(paths.final, { I: -14, TP: -1.5, LRA: 11 });
    expect(Math.abs(Number(m.input_i) + 14)).toBeLessThanOrEqual(1);
  });

  it("final: each graphic is visible inside its window and absent outside it", () => {
    const o = timeline.overlays[0]!;
    const grab = (t: number, out: string) => ff(["-ss", t.toFixed(3), "-i", paths.final, "-frames:v", "1", "-vf", "crop=1260:1200:1180:120,scale=315:300", out]);
    const inside = join(env.dir, "in.png"), aroll = join(env.dir, "aroll.png");
    const mid = final.introSeconds + (o.start + o.end) / 2;
    grab(mid, inside);
    ff(["-ss", ((o.start + o.end) / 2).toFixed(3), "-i", join(paths.cacheDir, "aroll.mp4"), "-frames:v", "1", "-vf", "scale=2560:1440,crop=1260:1200:1180:120,scale=315:300", aroll]);
    // ffmpeg prints PSNR on stderr. Low PSNR = the zone looks different from the bare A-roll = card present.
    const score = (a: string, b: string) => Number(/average:([\d.]+|inf)/.exec(spawnSync("ffmpeg", ["-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"], { encoding: "utf8" }).stderr)?.[1] ?? "0");
    const scoreInside = score(inside, aroll);
    expect(scoreInside).toBeLessThan(20); // the card covers the zone
    // …and just after the graphic ends, the zone matches the bare A-roll again.
    const after = join(env.dir, "after.png"), arollAfter = join(env.dir, "aroll-after.png");
    const tAfter = Math.min(o.end + 0.5, timeline.duration - 0.1);
    grab(final.introSeconds + tAfter, after);
    ff(["-ss", tAfter.toFixed(3), "-i", join(paths.cacheDir, "aroll.mp4"), "-frames:v", "1", "-vf", "scale=2560:1440,crop=1260:1200:1180:120,scale=315:300", arollAfter]);
    // Two different encodes of a busy test pattern never match exactly (~24–30 dB), so compare relatively:
    // without the card the zone must be far closer to the bare A-roll than with it.
    if (!timeline.overlays.some((x) => x !== o && x.start <= tAfter && x.end >= tAfter)) expect(score(after, arollAfter)).toBeGreaterThan(scoreInside + 6);
    expect(existsSync(paths.graphicMov(o.cueId))).toBe(true);
  });

  it("sidecars: chapters start at 0:00, captions stay inside the video", () => {
    const total = final.introSeconds + final.arollSeconds + final.outroSeconds;
    const chapters = chaptersText(timeline.chapters, final.introSeconds, total);
    if (chapters) expect(chapters.split("\n")[0]).toMatch(/^0:00 /);
    const srt = srtFromTimeline(transcript.words, timeline, final.introSeconds);
    const times = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d)/g)].map((m) => +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + +m[4]! / 1000);
    expect(times.length).toBeGreaterThan(10);
    expect(Math.max(...times)).toBeLessThanOrEqual(total + 1e-6);
    expect(srt).not.toMatch(/\b(um|uh|hmm)\b/i);
  });
});

