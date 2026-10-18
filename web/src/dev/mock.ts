// ?mock=1: an in-memory server behind the same ApiClient interface. Mutations change local state,
// stages run on timers and emit the same ServerEvents the real server sends.
// Console helpers: fdeMock.editElsewhere(slug) bumps the stored edit version (next save gets a 409).
import type { ApiClient, StageRunOptions } from "../api.ts";
import { ApiError, EditConflictError } from "../api.ts";
import type {
  Asset, ClaudeEvent, Config, Edit, FileEntry, FileListing, GraphicStatus, Health, JobInfo, Project, ProjectBundle, ScriptDoc,
  ScriptEntry, ServerEvent, StageName,
} from "../types.ts";
import { buildMockFixture, mockPostingImage, mockStill } from "./mockData.ts";
import { mockTimeline } from "./mockTimeline.ts";

const MAIN = "what-is-an-ai-engineer";
const clone = <T>(x: T): T => structuredClone(x);
const wait = (ms = 90 + Math.random() * 160) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const CONFIG: Config = {
  output: { width: 2560, height: 1440, fps: 30 },
  edit: { preMs: 80, postMs: 120, maxPauseMs: 500, fadeMs: 30, fillerGapMs: 250, punchInZoom: 1.1, style: { fillers: "natural", fillerMinMs: 400, minSegmentMs: 1200, jumpCuts: "soft", softFrames: 4 } },
  transcription: { engine: "local", localEngine: "parakeet", localModel: "medium.en" },
  claude: { model: "opus", maxTurns: 40 },
  loudness: { I: -14, TP: -1.5, LRA: 11 },
  scriptsDir: "~/Documents/Projects/FDE_Channel",
};

const HOME = "/Users/hamzasaraswat";
const SCRIPTS: ScriptEntry[] = [
  { path: `${HOME}/Documents/Projects/FDE_Channel/01-what-is-an-ai-engineer/youtube-script.md`, title: "What Is an AI Engineer? (It's Actually Two Different Jobs)", folder: "01-what-is-an-ai-engineer", modified: "2026-10-08T21:14:00Z" },
  { path: `${HOME}/Documents/Projects/FDE_Channel/02-workflows-vs-agents/youtube-script.md`, title: "Workflows vs. Agents: The Most Mixed-Up Idea in AI", folder: "02-workflows-vs-agents", modified: "2026-10-10T17:02:00Z" },
  { path: `${HOME}/Documents/Projects/FDE_Channel/03-rag-in-plain-english/youtube-script.md`, title: "RAG in Plain English", folder: "03-rag-in-plain-english", modified: "2026-10-11T09:40:00Z" },
];

type FsNode = { name: string; size?: number; modified: string; children?: FsNode[] };
const GB = 1024 ** 3;
const FS: FsNode = {
  name: HOME, modified: "2026-10-11T08:00:00Z", children: [
    { name: "Downloads", modified: "2026-10-11T08:00:00Z", children: [
      { name: "Untitled video - 30 Sept 2026.mp4", size: 2.31 * GB, modified: "2026-09-30T18:22:00Z" },
      { name: "Untitled video - 30 Sept 2026 (2).mp4", size: 1.87 * GB, modified: "2026-09-30T18:41:00Z" },
      { name: "cold-open-retake.mov", size: 0.92 * GB, modified: "2026-10-09T16:05:00Z" },
      { name: "workflows-take-1.mp4", size: 3.4 * GB, modified: "2026-10-10T19:12:00Z" },
      { name: "workflows-take-2.mp4", size: 1.2 * GB, modified: "2026-10-10T19:48:00Z" },
      { name: "posting-mid-level.png", size: 412_000, modified: "2026-10-02T12:00:00Z" },
      { name: "posting-applied-ai.png", size: 538_000, modified: "2026-10-02T12:01:00Z" },
      { name: "Recordings", modified: "2026-10-01T10:00:00Z", children: [
        { name: "2026-09-28 test take.mp4", size: 0.64 * GB, modified: "2026-09-28T20:00:00Z" },
        { name: "mic check.m4v", size: 0.08 * GB, modified: "2026-09-28T19:40:00Z" },
      ] },
      { name: "Screenshots", modified: "2026-10-03T10:00:00Z", children: [
        { name: "recruiter-message-1.png", size: 220_000, modified: "2026-10-03T10:00:00Z" },
      ] },
    ] },
    { name: "Movies", modified: "2026-09-01T10:00:00Z", children: [] },
  ],
};

function findDir(path: string): FsNode | null {
  if (path === HOME) return FS;
  if (!path.startsWith(`${HOME}/`)) return null;
  let node: FsNode | undefined = FS;
  for (const part of path.slice(HOME.length + 1).split("/")) {
    node = node?.children?.find((c) => c.name === part && c.children);
    if (!node) return null;
  }
  return node;
}

const isKind = (name: string, kind?: "video" | "image") =>
  !kind || (kind === "video" ? /\.(mp4|mov|m4v|mkv)$/i : /\.(png|jpe?g|webp)$/i).test(name);

type Sim = { job: JobInfo; timer: number };

export function createMockClient(): ApiClient {
  const params = new URLSearchParams(window.location.search);
  const projects = new Map<string, ProjectBundle>();
  const blobs = new Map<string, string>(); // "<slug>/<rel>" -> object/data URL
  const listeners = new Map<string, Set<(e: ServerEvent) => void>>();
  const sims = new Map<string, Sim>();
  let jobN = 0;

  const fixture = buildMockFixture(MAIN);
  const fps = CONFIG.output.fps;
  const timelineFor = (b: ProjectBundle) => (b.edit && b.transcript ? mockTimeline(b.edit, b.transcript, b.project.clips, fps) : null);

  const main: ProjectBundle = {
    project: fixture.project,
    script: fixture.script,
    transcript: fixture.transcript,
    candidates: fixture.candidates,
    edit: fixture.edit,
    timeline: null,
    graphics: fixture.graphics,
    outputs: { xclips: [] },
    jobs: [],
  };
  main.timeline = timelineFor(main);
  projects.set(MAIN, main);
  blobs.set(`${MAIN}/assets/a1-mid-level-ai-developer.png`, mockPostingImage());

  const smallScript: ScriptDoc = {
    title: "Workflows vs. Agents: The Most Mixed-Up Idea in AI",
    sections: [
      { id: "sec0", title: "Cold open", level: 2, sentenceIds: ["s0.1", "s0.2"] },
      { id: "sec1", title: "1. What a workflow is", level: 2, sentenceIds: ["s1.1"] },
    ],
    sentences: [
      { id: "s0.1", sectionId: "sec0", blockId: "b0.1", text: "Everyone calls everything an agent now.", tokens: [] },
      { id: "s0.2", sectionId: "sec0", blockId: "b0.1", text: "Most of them are workflows, and that's fine.", tokens: [] },
      { id: "s1.1", sectionId: "sec1", blockId: "b1.1", text: "A workflow is a fixed path you wrote down ahead of time.", tokens: [] },
    ],
    cues: [{ id: "g1", kind: "gfx", optional: false, text: "a fixed path vs. a loop with a model choosing the next step", flags: [], sectionId: "sec1", afterSentenceId: "s1.1", holdSection: false }],
  };
  projects.set("workflows-vs-agents", {
    project: {
      slug: "workflows-vs-agents", title: smallScript.title, createdAt: "2026-10-10T20:05:00Z", scriptSource: SCRIPTS[1]!.path,
      speakerSide: "left", nextVideoTitle: "", assets: [],
      clips: [{ ...fixture.project.clips[0]!, name: "workflows-take-1.mp4", path: `${HOME}/Downloads/workflows-take-1.mp4`, duration: 742.3 }],
      stages: { import: { state: "done", message: "1 clip, 1 proxy", updatedAt: "2026-10-10T20:07:00Z" } },
    },
    script: smallScript, transcript: null, candidates: null, edit: null, timeline: null, graphics: {}, outputs: { xclips: [] }, jobs: [],
  });
  projects.set("rag-in-plain-english", {
    project: {
      slug: "rag-in-plain-english", title: "RAG in Plain English", createdAt: "2026-10-11T09:45:00Z", scriptSource: SCRIPTS[2]!.path,
      speakerSide: "right", nextVideoTitle: "", assets: [], clips: [],
      stages: { import: { state: "error", message: "cold-open.mov is HDR (HLG). Record in SDR and import again.", updatedAt: "2026-10-11T09:46:00Z" } },
    },
    script: null, transcript: null, candidates: null, edit: null, timeline: null, graphics: {}, outputs: { xclips: [] }, jobs: [],
  });

  // ---------- events ----------

  const emit = (slug: string, e: ServerEvent) => {
    for (const fn of listeners.get(slug) ?? []) fn(clone(e));
  };
  const get = (slug: string) => {
    const b = projects.get(slug);
    if (!b) throw new ApiError(404, `No project "${slug}"`);
    return b;
  };
  const setStage = (slug: string, stage: StageName, state: "idle" | "running" | "done" | "error", message: string, progress?: number) => {
    const b = get(slug);
    const status = { state, message, updatedAt: nowIso(), ...(progress !== undefined ? { progress } : {}) };
    b.project.stages[stage] = status;
    emit(slug, { type: "stage", stage, status });
  };
  const setGraphic = (slug: string, cueId: string, patch: Partial<GraphicStatus>) => {
    const b = get(slug);
    const status: GraphicStatus = { ...(b.graphics[cueId] ?? { cueId, state: "none", message: "", hasMov: false, stale: false }), ...patch, updatedAt: nowIso() };
    b.graphics[cueId] = status;
    emit(slug, { type: "graphic", status });
  };
  const log = (slug: string, stage: StageName, line: string) => emit(slug, { type: "log", stage, line });
  const claude = (slug: string, stage: StageName, event: ClaudeEvent, cueId?: string) => emit(slug, { type: "claude", stage, event, ...(cueId ? { cueId } : {}) });

  // ---------- stage simulation ----------

  type Step = (slug: string) => void;
  const scriptFor = (slug: string, stage: StageName, options: StageRunOptions | undefined): { steps: Step[]; finish: Step } => {
    const b = get(slug);
    const steps: Step[] = [];
    const say = (fn: Step) => steps.push(fn);
    switch (stage) {
      case "import": {
        for (const c of b.project.clips) {
          say((s) => log(s, stage, `ffprobe ${c.id}: ${c.width}x${c.height} ${c.fps} fps ${c.codec} ${c.pixFmt}`));
          say((s) => log(s, stage, `proxy ${c.id}: 720p h264_videotoolbox -g 30`));
        }
        say((s) => log(s, stage, "parsed script: sections, sentences and cues"));
        return { steps, finish: (s) => setStage(s, stage, "done", `${b.project.clips.length} clips imported`) };
      }
      case "transcribe": {
        const o = (options ?? {}) as { engine?: string; localEngine?: string; localModel?: string };
        const label = o.engine === "openai" ? "OpenAI whisper-1" : o.localEngine === "whisper" ? `Whisper ${o.localModel ?? "medium.en"}` : "Parakeet";
        say((s) => log(s, stage, `engine: ${label}`));
        for (let i = 1; i <= 6; i++) say((s) => log(s, stage, `chunk ${i}/6 transcribed`));
        say((s) => log(s, stage, "silencedetect: adaptive threshold -38 dB"));
        return {
          steps,
          finish: (s) => {
            if (!b.transcript) {
              b.script = fixture.script;
              b.transcript = fixture.transcript;
              b.candidates = fixture.candidates;
            }
            setStage(s, stage, "done", `${label}, ${b.transcript.words.length} words`);
            setStage(s, "align", "done", "Lines matched, 2 retakes");
          },
        };
      }
      case "align":
        say((s) => log(s, stage, "fuzzy-matching sentences"));
        return { steps, finish: (s) => setStage(s, stage, "done", "Lines matched, 2 retakes") };
      case "plan": {
        say((s) => claude(s, stage, { kind: "init", model: "claude-opus", sessionId: "mock-session" }));
        say((s) => claude(s, stage, { kind: "text", text: "I'll read the script, the transcript and the aligner's candidates first." }));
        say((s) => claude(s, stage, { kind: "tool", name: "Read", input: "projects/" + s + "/script.json" }));
        say((s) => claude(s, stage, { kind: "tool", name: "Read", input: "projects/" + s + "/transcript.json" }));
        say((s) => claude(s, stage, { kind: "tool", name: "Read", input: "projects/" + s + "/candidates.json" }));
        say((s) => claude(s, stage, { kind: "text", text: "s0.2 has two takes. Take 2 is clean; take 1 has an \"uh\" and a doubled \"to\". s1.2 has three; only take 2 is complete and clean." }));
        say((s) => claude(s, stage, { kind: "text", text: "Cutting the false start \"So in this\" and the repeated \"a different,\". Keeping the aside \"Honestly, that surprised me\" because it sounds natural." }));
        say((s) => claude(s, stage, { kind: "text", text: "g1 lands on \"One wants\" as a split (you're centered). g2 goes on the right over the three examples." }));
        return {
          steps,
          finish: (s) => {
            const prev = b.edit;
            b.edit = prev ? { ...clone(fixture.edit), cuts: [...fixture.edit.cuts.filter((c) => c.by !== "user"), ...prev.cuts.filter((c) => c.by === "user")], version: prev.version + 1 } : clone(fixture.edit);
            b.timeline = timelineFor(b);
            for (const [k, g] of Object.entries(fixture.graphics)) if (!b.graphics[k]) b.graphics[k] = clone(g);
            claude(s, stage, { kind: "result", ok: true, text: "Edit plan written.", costUsd: 0.41, turns: 6, durationMs: 48_000 });
            setStage(s, stage, "done", `${b.edit.cuts.length} cuts, ${b.edit.overlays.length} graphics placed`);
          },
        };
      }
      case "graphics": {
        const o = (options ?? {}) as { cueIds?: string[]; note?: string; force?: boolean };
        const all = (b.edit?.overlays ?? []).map((ov) => ov.cueId);
        const cueIds = o.cueIds?.length ? o.cueIds : all.filter((c) => o.force || b.graphics[c]?.state !== "ready" || b.graphics[c]?.stale);
        for (const c of cueIds) say((s) => setGraphic(s, c, { state: "queued", message: "Waiting for the queue" }));
        for (const c of cueIds) {
          say((s) => {
            setGraphic(s, c, { state: "building", message: "Claude is writing index.html" });
            claude(s, stage, { kind: "init", model: "claude-opus", sessionId: `mock-${c}` }, c);
          });
          if (o.note) say((s) => claude(s, stage, { kind: "text", text: `Applying your note: "${o.note}"` }, c));
          say((s) => claude(s, stage, { kind: "tool", name: "Read", input: "brand/tokens.css" }, c));
          say((s) => claude(s, stage, { kind: "tool", name: "Write", input: `graphics/${c}/index.html` }, c));
          say((s) => claude(s, stage, { kind: "tool", name: "Bash", input: `npx hyperframes lint graphics/${c}` }, c));
          say((s) => {
            setGraphic(s, c, { state: "rendering", message: "Rendering ProRes 4444" });
            log(s, stage, `${c}: hyperframes render --format mov`);
          });
          say((s) => {
            const ov = b.edit?.overlays.find((x) => x.cueId === c);
            const placed = b.timeline?.overlays.find((x) => x.cueId === c);
            const side = ov?.side ?? (b.project.speakerSide === "right" ? "left" : "right");
            setGraphic(s, c, {
              state: "ready", message: "Built", stale: false, hasMov: true, layout: ov?.layout, side: ov?.layout === "side" ? side : undefined,
              durationSec: placed ? Math.round((placed.end - placed.start) * 10) / 10 : undefined, still: mockStill(c, ov?.layout ?? "side", side),
            });
            claude(s, stage, { kind: "result", ok: true, text: `${c} built.`, costUsd: 0.18, turns: 4 }, c);
          });
        }
        return { steps, finish: (s) => setStage(s, stage, "done", `${cueIds.length} graphic${cueIds.length === 1 ? "" : "s"} built`) };
      }
      case "preview":
        say((s) => log(s, stage, `segments: ${b.timeline?.segments.length ?? 0} in the cut, 3 re-encoded`));
        say((s) => log(s, stage, "concat demuxer -> out/preview.mp4"));
        return { steps, finish: (s) => setStage(s, stage, "done", "Preview ready") };
      case "render":
        for (const p of ["segments at full resolution", "overlaying graphics", "loudnorm pass 1", "loudnorm pass 2", "encoding H.264"]) say((s) => log(s, stage, p));
        return {
          steps,
          finish: (s) => {
            const ch = b.timeline?.chapters ?? [];
            b.outputs = {
              ...b.outputs,
              final: `/media/${s}/out/final.mp4`,
              srt: `/media/${s}/out/captions.srt`,
              chapters: ch.map((c, i) => `${i === 0 ? "0:00" : fmt(c.start)} ${c.title}`).join("\n"),
            };
            setStage(s, stage, "done", "final.mp4 rendered");
          },
        };
      case "xclips":
        say((s) => claude(s, stage, { kind: "text", text: "Looking for 30–60 s moments that stand alone." }));
        say((s) => claude(s, stage, { kind: "tool", name: "Read", input: "out/captions.srt" }));
        return {
          steps,
          finish: (s) => {
            b.outputs = {
              ...b.outputs,
              xclips: [
                { url: `/media/${s}/out/x-clips/1.mp4`, hook: "\"AI engineer\" is two different jobs with one title.", start: 0, end: 38.4 },
                { url: `/media/${s}/out/x-clips/2.mp4`, hook: "You're not training GPT. You're building on top of it.", start: 41.2, end: 84.0 },
              ],
            };
            claude(s, stage, { kind: "result", ok: true, text: "Picked 2 clips.", costUsd: 0.09, turns: 2 });
            setStage(s, stage, "done", "2 clips");
          },
        };
    }
  };

  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

  function startJob(slug: string, stage: StageName, options?: StageRunOptions, startProgress = 0): JobInfo {
    const b = get(slug);
    const job: JobInfo = { id: `j${++jobN}`, stage, state: "running", startedAt: nowIso(), message: "Starting", progress: startProgress };
    b.jobs = [...b.jobs.filter((j) => j.state === "running"), job];
    const { steps, finish } = scriptFor(slug, stage, options);
    const total = Math.max(steps.length, 4);
    let i = Math.round(startProgress * total);
    setStage(slug, stage, "running", "Starting", startProgress);
    emit(slug, { type: "job", job: clone(job) });
    const timer = window.setInterval(() => {
      if (i < steps.length) steps[i]!(slug);
      i++;
      job.progress = Math.min(1, i / total);
      job.message = i < total ? `Step ${i} of ${total}` : "Finishing";
      emit(slug, { type: "job", job: clone(job) });
      setStage(slug, stage, "running", job.message, job.progress);
      if (i >= total) {
        window.clearInterval(timer);
        sims.delete(job.id);
        finish(slug);
        job.state = "done";
        job.endedAt = nowIso();
        job.message = b.project.stages[stage]?.message ?? "Done";
        job.progress = 1;
        emit(slug, { type: "job", job: clone(job) });
        emit(slug, { type: "bundle-changed" });
      }
    }, stage === "plan" || stage === "graphics" ? 700 : 450);
    sims.set(job.id, { job, timer });
    return job;
  }

  // the graphics job that's mid-flight when the mock project opens
  startJob(MAIN, "graphics", { cueIds: ["g2"] }, 0.3);

  const markStale = (slug: string, before: Edit | null, after: Edit) => {
    const b = get(slug);
    for (const o of after.overlays) {
      const p = before?.overlays.find((x) => x.id === o.id);
      const g = b.graphics[o.cueId];
      if (!p || !g || g.state !== "ready" || g.stale) continue;
      const key = (x: typeof o) => JSON.stringify([x.offsetMs, x.durMs, x.side, x.layout, x.brief]);
      if (key(p) !== key(o)) setGraphic(slug, o.cueId, { stale: true });
    }
  };

  const client: ApiClient = {
    mock: true,
    async health(): Promise<Health> {
      await wait(60);
      return {
        ok: true,
        claudeLoggedIn: params.get("claude") !== "0",
        openaiKey: params.get("openai") === "1",
        hyperframesVersion: "0.8.134",
        brandReady: params.get("brand") === "1",
      };
    },
    async config() {
      await wait(40);
      return clone(CONFIG);
    },
    async scripts() {
      await wait();
      return clone(SCRIPTS);
    },
    async files(dir = `${HOME}/Downloads`, kind): Promise<FileListing> {
      await wait();
      const node = findDir(dir);
      if (!node) throw new ApiError(404, `No folder ${dir}`);
      const entries: FileEntry[] = (node.children ?? [])
        .filter((c) => c.children || isKind(c.name, kind))
        .map((c) => ({ name: c.name, path: `${dir}/${c.name}`, isDir: !!c.children, size: c.size ?? 0, modified: c.modified }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      const parent = dir === HOME ? null : dir.slice(0, dir.lastIndexOf("/")) || null;
      return { dir, parent, entries };
    },
    async projects() {
      await wait();
      return [...projects.values()].map((b) => clone(b.project)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async createProject(body) {
      await wait(300);
      const entry = SCRIPTS.find((s) => s.path === body.scriptPath);
      const title = body.title?.trim() || entry?.title || "Untitled";
      let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "project";
      for (let n = 2; projects.has(slug); n++) slug = `${slug.replace(/-\d+$/, "")}-${n}`;
      const project: Project = {
        slug, title, createdAt: nowIso(), scriptSource: body.scriptPath, speakerSide: body.speakerSide, nextVideoTitle: "", assets: [], stages: {},
        clips: body.clipPaths.map((p, i) => ({ ...fixture.project.clips[0]!, id: `c${i + 1}`, name: p.split("/").at(-1)!, path: p, duration: 300 + i * 41.5 })),
      };
      projects.set(slug, { project, script: null, transcript: null, candidates: null, edit: null, timeline: null, graphics: {}, outputs: { xclips: [] }, jobs: [] });
      setTimeout(() => startJob(slug, "import"), 200); // creating a project auto-runs import
      return clone(project);
    },
    async bundle(slug) {
      await wait();
      return clone(get(slug));
    },
    async patchProject(slug, body) {
      await wait();
      const b = get(slug);
      const sideChanged = body.speakerSide !== undefined && body.speakerSide !== b.project.speakerSide;
      Object.assign(b.project, body);
      if (sideChanged) for (const o of b.edit?.overlays ?? []) if (o.layout === "side" && !o.side && b.graphics[o.cueId]?.state === "ready") setGraphic(slug, o.cueId, { stale: true });
      setTimeout(() => emit(slug, { type: "bundle-changed" }), 30);
      return clone(b.project);
    },
    async addClips(slug, paths) {
      await wait();
      const b = get(slug);
      const n = b.project.clips.length;
      b.project.clips.push(...paths.map((p, i) => ({ ...fixture.project.clips[0]!, id: `c${n + i + 1}`, name: p.split("/").at(-1)!, path: p })));
      return clone(b.project);
    },
    async removeClip(slug, clipId) {
      await wait();
      const b = get(slug);
      b.project.clips = b.project.clips.filter((c) => c.id !== clipId);
      return clone(b.project);
    },
    async uploadAsset(slug, file) {
      await wait(400);
      const b = get(slug);
      const id = `a${b.project.assets.length + 1}`;
      const rel = `assets/${id}-${file.name.replace(/[^\w.-]+/g, "-")}`;
      const url = URL.createObjectURL(file);
      blobs.set(`${slug}/${rel}`, url);
      const size = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 1600, h: 1000 });
        img.src = url;
      });
      const asset: Asset = { id, name: file.name, file: rel, kind: "image", width: size.w, height: size.h, blur: [], highlight: [] };
      b.project.assets.push(asset);
      return clone(asset);
    },
    async patchAsset(slug, assetId, body) {
      await wait(80);
      const b = get(slug);
      const a = b.project.assets.find((x) => x.id === assetId);
      if (!a) throw new ApiError(404, `No asset ${assetId}`);
      if (body.cueId === null) delete a.cueId;
      else if (body.cueId !== undefined) a.cueId = body.cueId;
      if (body.crop === null) delete a.crop;
      else if (body.crop !== undefined) a.crop = body.crop;
      if (body.blur) a.blur = body.blur;
      if (body.highlight) a.highlight = body.highlight;
      if (a.cueId && b.graphics[a.cueId]?.state === "ready") setGraphic(slug, a.cueId, { stale: true });
      return clone(a);
    },
    async deleteAsset(slug, assetId) {
      await wait();
      const b = get(slug);
      b.project.assets = b.project.assets.filter((a) => a.id !== assetId);
      return clone(b.project);
    },
    async runStage(slug, stage, options) {
      await wait();
      const b = get(slug);
      if (b.jobs.some((j) => j.stage === stage && j.state === "running")) throw new ApiError(409, `${stage} is already running`);
      if ((stage === "plan" || stage === "align") && !b.transcript) throw new ApiError(400, "Transcribe the recording first.");
      if ((stage === "graphics" || stage === "preview" || stage === "render" || stage === "xclips") && !b.edit) throw new ApiError(400, "Run Plan edit first.");
      return clone(startJob(slug, stage, options));
    },
    async cancelJob(slug, jobId) {
      await wait();
      const sim = sims.get(jobId);
      if (!sim) throw new ApiError(404, `No running job ${jobId}`);
      window.clearInterval(sim.timer);
      sims.delete(jobId);
      sim.job.state = "cancelled";
      sim.job.endedAt = nowIso();
      sim.job.message = "Cancelled";
      setStage(slug, sim.job.stage, "idle", "Cancelled");
      const b = get(slug);
      for (const [k, g] of Object.entries(b.graphics)) if (sim.job.stage === "graphics" && (g.state === "queued" || g.state === "building" || g.state === "rendering")) setGraphic(slug, k, { state: "none", message: "Cancelled" });
      emit(slug, { type: "job", job: clone(sim.job) });
      return clone(sim.job);
    },
    async saveEdit(slug, edit) {
      await wait(160);
      const b = get(slug);
      if (!b.edit || !b.transcript) throw new ApiError(400, "No edit to save yet.");
      if (edit.version !== b.edit.version) throw new EditConflictError(clone(b.edit));
      const before = b.edit;
      b.edit = { ...clone(edit), version: edit.version + 1 };
      b.timeline = timelineFor(b);
      markStale(slug, before, b.edit);
      setTimeout(() => emit(slug, { type: "bundle-changed" }), 40);
      return { edit: clone(b.edit), timeline: clone(b.timeline!) };
    },
    async patchClip(slug, clipId, body) {
      await wait(120);
      const b = get(slug);
      const clip = b.project.clips.find((c) => c.id === clipId);
      if (!clip) throw new ApiError(404, `No clip ${clipId}`);
      Object.assign(clip, body);
      setTimeout(() => emit(slug, { type: "bundle-changed" }), 40);
      return clone(b.project);
    },
    async setStyle(slug, style) {
      await wait(160);
      const b = get(slug);
      if (!b.edit || !b.transcript) throw new ApiError(400, "No edit yet.");
      const merged: Record<string, unknown> = { ...b.edit.style, ...style };
      for (const [k, v] of Object.entries(style)) if (v === null) delete merged[k];
      b.edit = { ...clone(b.edit), style: merged as Edit["style"], version: b.edit.version + 1 };
      b.timeline = timelineFor(b);
      setTimeout(() => emit(slug, { type: "bundle-changed" }), 40);
      return { edit: clone(b.edit)!, timeline: clone(b.timeline!) };
    },
    subscribe(slug, onEvent, onState) {
      const set = listeners.get(slug) ?? new Set();
      set.add(onEvent);
      listeners.set(slug, set);
      onState?.("connecting");
      const t = setTimeout(() => onState?.("open"), 120);
      return () => {
        clearTimeout(t);
        set.delete(onEvent);
      };
    },
    mediaUrl: (slug, rel) => blobs.get(`${slug}/${rel}`) ?? `/media/${encodeURIComponent(slug)}/${rel}`,
  };

  (window as unknown as { fdeMock: unknown }).fdeMock = {
    /** Simulate a save from another tab: the next save from this one gets a 409. */
    editElsewhere(slug = MAIN) {
      const b = get(slug);
      if (!b.edit) return "no edit";
      b.edit = { ...b.edit, version: b.edit.version + 1 };
      return `edit version is now ${b.edit.version}`;
    },
    emit,
    projects,
  };

  return client;
}
