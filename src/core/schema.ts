// Shared data shapes. Every file in a project folder is validated against one of these.
// Times are seconds. Source times are relative to a clip; output times are relative to the final cut.
import { z } from "zod";

// ---------- config (fde-editor.config.json) ----------

export const ConfigSchema = z.object({
  output: z.object({
    width: z.number().int().default(2560),
    height: z.number().int().default(1440),
    fps: z.number().int().default(30),
  }).prefault({}),
  edit: z.object({
    preMs: z.number().default(80), // padding kept before a kept word
    postMs: z.number().default(120), // padding kept after a kept word
    maxPauseMs: z.number().default(400), // longer natural pauses get tightened to this
    fadeMs: z.number().default(30), // length of the audio crossfade centred on every cut
    fillerGapMs: z.number().default(250), // a voiced gap between words longer than this is a filler candidate
    punchInZoom: z.number().min(1).max(1.5).default(1.1), // how far a punch-in zooms (when the edit turns them on)
    style: z.lazy(() => EditStyleSchema).prefault({}), // channel defaults; each video can override them (edit.style)
  }).prefault({}),
  transcription: z.object({
    engine: z.enum(["local", "openai"]).default("local"),
    localEngine: z.enum(["whisper", "parakeet"]).default("parakeet"),
    localModel: z.enum(["tiny.en", "base.en", "small.en", "medium.en", "large-v3"]).default("medium.en"),
  }).prefault({}),
  claude: z.object({
    model: z.string().default("opus"),
    maxTurns: z.number().int().default(40),
  }).prefault({}),
  loudness: z.object({
    I: z.number().default(-14),
    TP: z.number().default(-1.5),
    LRA: z.number().default(11),
  }).prefault({}),
  scriptsDir: z.string().default("~/Documents/Projects/FDE_Channel"),
});
export type Config = z.infer<typeof ConfigSchema>;

// ---------- project (project.json) ----------

export const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }); // 0–1 of image size
export type Rect = z.infer<typeof RectSchema>;

export const ClipSchema = z.object({
  id: z.string(), // c1, c2 …
  name: z.string(),
  path: z.string(), // absolute path to the original recording (never copied)
  duration: z.number(),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  codec: z.string(),
  pixFmt: z.string(),
  hasAudio: z.boolean(),
  vfr: z.boolean(),
  hdr: z.boolean(),
  // The picture inside black bars, in source pixels: some recorders (CapCut's teleprompter) save a 16:9
  // shot letterboxed inside a 9:16 canvas. Every encode crops to it; width/height above are its size.
  crop: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() }).optional(),
  mirror: z.boolean().optional(), // flip left-right (a front camera saved a mirror image)
  stabilize: z.boolean().optional(), // remove camera shake (table knocks); builds a conformed master
});
export type Clip = z.infer<typeof ClipSchema>;

export const AssetSchema = z.object({
  id: z.string(), // a1, a2 …
  name: z.string(),
  file: z.string(), // path relative to the project folder (assets/…)
  kind: z.enum(["image", "video"]),
  width: z.number(),
  height: z.number(),
  cueId: z.string().optional(),
  crop: RectSchema.optional(),
  blur: z.array(RectSchema).default([]),
  highlight: z.array(RectSchema).default([]),
});
export type Asset = z.infer<typeof AssetSchema>;

export const StageName = z.enum(["import", "transcribe", "align", "plan", "graphics", "preview", "render", "xclips"]);
export type StageName = z.infer<typeof StageName>;

export const StageStatusSchema = z.object({
  state: z.enum(["idle", "running", "done", "error"]).default("idle"),
  message: z.string().default(""),
  progress: z.number().min(0).max(1).optional(),
  updatedAt: z.string().optional(),
});
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const ProjectSchema = z.object({
  slug: z.string(),
  title: z.string(),
  createdAt: z.string(),
  scriptSource: z.string(), // absolute path of the markdown script it was imported from
  // Where the speaker sits in frame. left/right third: graphics go on the open side.
  // center: graphics go on either side (per graphic) or split across both.
  speakerSide: z.enum(["left", "right", "center"]).default("left"),
  nextVideoTitle: z.string().default(""), // shown on the end card
  clips: z.array(ClipSchema).default([]),
  assets: z.array(AssetSchema).default([]),
  stages: z.partialRecord(StageName, StageStatusSchema).default({}),
});
export type Project = z.infer<typeof ProjectSchema>;

// ---------- script (script.json) ----------

export const SentenceSchema = z.object({
  id: z.string(), // s<section>.<n>, e.g. s2.4
  sectionId: z.string(),
  blockId: z.string(), // the SAY block it came from, e.g. b2.1
  text: z.string(),
  tokens: z.array(z.string()), // normalized words used for alignment
});
export type Sentence = z.infer<typeof SentenceSchema>;

export const CueSchema = z.object({
  id: z.string(), // g1, g2 … (graphics) / r1, r2 … (b-roll)
  kind: z.enum(["gfx", "broll"]),
  optional: z.boolean(),
  text: z.string(), // the cue description from the script, flags removed
  flags: z.array(z.string()), // [VERIFY …] / [CONFIRM …] notes found on the cue
  sectionId: z.string(),
  afterSentenceId: z.string().nullable(), // last sentence spoken before the cue in the script
  phrase: z.string().optional(), // quoted trigger phrase ("when you say 'cheat sheet'")
  holdSection: z.boolean(), // "stays on screen through this section"
});
export type Cue = z.infer<typeof CueSchema>;

export const SectionSchema = z.object({
  id: z.string(), // sec0, sec1 …
  title: z.string(),
  level: z.number().int(), // 2 for ##, 3 for ###
  sentenceIds: z.array(z.string()),
});
export type Section = z.infer<typeof SectionSchema>;

export const ScriptDocSchema = z.object({
  title: z.string(),
  sections: z.array(SectionSchema),
  sentences: z.array(SentenceSchema),
  cues: z.array(CueSchema),
});
export type ScriptDoc = z.infer<typeof ScriptDocSchema>;

// ---------- transcript (transcript.json) ----------

export const WordSchema = z.object({
  id: z.string(), // w0, w1 … unique across the whole project
  clipId: z.string(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
});
export type Word = z.infer<typeof WordSchema>;

export const SpanSchema = z.object({ clipId: z.string(), start: z.number(), end: z.number() });
export type Span = z.infer<typeof SpanSchema>;

export const FillerCandidateSchema = z.object({
  id: z.string(), // f0, f1 …
  clipId: z.string(),
  start: z.number(),
  end: z.number(),
  kind: z.enum(["token", "gap"]), // token: Whisper wrote "um"; gap: voiced gap with no word
  wordId: z.string().optional(),
  afterWordId: z.string().optional(),
});
export type FillerCandidate = z.infer<typeof FillerCandidateSchema>;

export const TranscriptSchema = z.object({
  engine: z.string(), // local-whisper | local-parakeet | openai
  model: z.string(),
  words: z.array(WordSchema),
  silences: z.array(SpanSchema),
  fillers: z.array(FillerCandidateSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

// ---------- aligner output (candidates.json) ----------

export const OccurrenceSchema = z.object({
  clipId: z.string(),
  startWordId: z.string(),
  endWordId: z.string(),
  score: z.number(), // 0–1 similarity to the script sentence
});
export type Occurrence = z.infer<typeof OccurrenceSchema>;

export const CandidatesSchema = z.object({
  sentences: z.array(z.object({
    sentenceId: z.string(),
    occurrences: z.array(OccurrenceSchema), // in recording order; more than one = retakes
    chosen: z.number().int().nullable(), // index into occurrences on the best monotonic path, or null if missing
  })),
  adlibs: z.array(z.object({ clipId: z.string(), startWordId: z.string(), endWordId: z.string() })),
  missing: z.array(z.string()), // sentence ids never spoken
});
export type Candidates = z.infer<typeof CandidatesSchema>;

// ---------- Claude's edit plan (plan.json) ----------

export const WordRangeSchema = z.object({ startWordId: z.string(), endWordId: z.string() });
export type WordRange = z.infer<typeof WordRangeSchema>;

export const EditPlanSchema = z.object({
  takes: z.array(z.object({
    sentenceIds: z.array(z.string()).min(1),
    chosen: WordRangeSchema,
    alternates: z.array(WordRangeSchema),
    why: z.string(),
  })),
  adlibs: z.array(WordRangeSchema.extend({ keep: z.boolean(), why: z.string() })),
  wordCuts: z.array(WordRangeSchema.extend({
    reason: z.enum(["filler", "stumble", "false-start", "repeat"]),
  })),
  fillerGaps: z.array(z.object({ fillerId: z.string(), cut: z.boolean() })),
  cues: z.array(z.object({
    cueId: z.string(),
    include: z.boolean(),
    anchorWordId: z.string(), // graphic appears as this word starts
    endWordId: z.string(), // and leaves after this word ends
    layout: z.enum(["side", "split", "full"]), // split: content on both sides of a centered speaker
    side: z.enum(["left", "right"]).optional(), // for "side" layout: which side of the frame; required when the speaker is centered
    brief: z.string(), // what to build, in Claude's words, for the graphics job
  })),
  notes: z.string(),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;

// ---------- the edit (edit.json): what the UI changes ----------

export const CutReason = z.enum(["filler", "silence", "stumble", "false-start", "repeat", "adlib", "user"]);
export type CutReason = z.infer<typeof CutReason>;

export const CutSchema = z.object({
  id: z.string(),
  clipId: z.string(),
  start: z.number(),
  end: z.number(),
  reason: CutReason,
  by: z.enum(["auto", "claude", "user"]),
  enabled: z.boolean(),
  note: z.string().optional(),
  pinned: z.boolean().optional(), // the user turned it on or off by hand: the edit style never overrides it
  wanted: z.boolean().optional(), // a filler cut's planner decision, before the edit style filtered it
});
export type Cut = z.infer<typeof CutSchema>;

export const TakeOptionSchema = WordRangeSchema.extend({ clipId: z.string(), start: z.number(), end: z.number() });
export type TakeOption = z.infer<typeof TakeOptionSchema>;

export const TakeGroupSchema = z.object({
  id: z.string(),
  sentenceIds: z.array(z.string()),
  options: z.array(TakeOptionSchema).min(1),
  chosen: z.number().int(), // the other options are removed from the cut
  why: z.string(),
});
export type TakeGroup = z.infer<typeof TakeGroupSchema>;

export const OverlaySchema = z.object({
  id: z.string(),
  cueId: z.string(),
  enabled: z.boolean(),
  anchorWordId: z.string(),
  endWordId: z.string(),
  offsetMs: z.number().default(0), // nudge from the anchor word
  durMs: z.number().optional(), // fixed length override; otherwise until endWordId
  layout: z.enum(["side", "split", "full"]),
  side: z.enum(["left", "right"]).optional(), // "side" layout only; flipping it in the UI re-renders the graphic
  brief: z.string(),
  assetIds: z.array(z.string()).default([]),
});
export type Overlay = z.infer<typeof OverlaySchema>;

/** Which side a "side" graphic sits on: the open side for a speaker on a third, Claude's/the user's pick when centered. */
export function overlaySide(o: Pick<Overlay, "side">, speakerSide: Project["speakerSide"]): "left" | "right" {
  if (o.side) return o.side;
  return speakerSide === "right" ? "left" : "right";
}

export const EditSchema = z.object({
  version: z.number().int(), // bumped on every save; stale writes are rejected
  clipOrder: z.array(z.string()),
  cuts: z.array(CutSchema),
  takeGroups: z.array(TakeGroupSchema),
  overlays: z.array(OverlaySchema),
  chapters: z.array(z.object({ title: z.string(), anchorWordId: z.string() })),
  intro: z.boolean().default(true),
  outro: z.boolean().default(true),
  punchIn: z.boolean().optional(), // legacy switch, read as style.jumpCuts = "punch-in"
  style: z.lazy(() => EditStyleOverridesSchema).optional(), // this video's overrides of the channel style
});
export type Edit = z.infer<typeof EditSchema>;

/**
 * How hard the edit cuts. Fillers: "natural" cuts only stalls (≥ fillerMinMs) and keeps the short
 * "uh"s of normal speech, "all" cuts every filler, "keep" none. Stutters, restarts and false starts are
 * always cut. minSegmentMs drops a filler cut that would leave a sliver of video between two jumps.
 * jumpCuts: "soft" dissolves softFrames across a cut inside one take, "punch-in" alternates a zoom.
 */
const STYLE = {
  fillers: z.enum(["natural", "all", "keep"]),
  fillerMinMs: z.number().min(0),
  maxPauseMs: z.number().min(100).max(3000), // the channel default is edit.maxPauseMs in the config
  minSegmentMs: z.number().min(0),
  jumpCuts: z.enum(["soft", "punch-in", "none"]),
  softFrames: z.number().int().min(2).max(12),
};
export const EditStyleSchema = z.object({
  fillers: STYLE.fillers.default("natural"),
  fillerMinMs: STYLE.fillerMinMs.default(400),
  maxPauseMs: STYLE.maxPauseMs.optional(),
  minSegmentMs: STYLE.minSegmentMs.default(1200),
  jumpCuts: STYLE.jumpCuts.default("soft"),
  softFrames: STYLE.softFrames.default(4),
});
export type EditStyle = z.infer<typeof EditStyleSchema>;
/** A video's overrides: only what was changed for it, no defaults filled in (they come from the config). */
export const EditStyleOverridesSchema = z.object(Object.fromEntries(Object.entries(STYLE).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof STYLE]: z.ZodOptional<(typeof STYLE)[K]>;
});

// ---------- derived timeline (never stored) ----------

export type Segment = {
  clipId: string;
  start: number; // source seconds, on the frame grid
  end: number;
  frames: number;
  outStart: number; // where it lands in the output
  zoom?: number; // punch-in scale (absent = 1, no zoom)
  softIn?: number; // frames of dissolve from the previous segment, centred on the join (soft jump cut)
};

export type PlacedOverlay = { overlayId: string; cueId: string; start: number; end: number }; // output seconds

export type Timeline = {
  fps: number;
  segments: Segment[];
  duration: number; // output seconds, A-roll only (no intro/outro)
  overlays: PlacedOverlay[];
  chapters: { title: string; start: number }[];
};

// ---------- Claude-picked X clips (xclips.json) ----------

export const XClipPlanSchema = z.object({
  clips: z.array(z.object({
    start: z.number(), // output seconds
    end: z.number(),
    hook: z.string(),
    why: z.string(),
  })).min(1).max(3),
});
export type XClipPlan = z.infer<typeof XClipPlanSchema>;
