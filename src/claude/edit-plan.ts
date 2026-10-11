// The "plan" stage: hand Claude a compact view of script + transcript + aligner output, get back an
// EditPlan (plan.json), and compile it into the editable edit (edit.json).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { planToEdit } from "../core/compiler.ts";
import { PROMPTS_DIR, REPO_ROOT, projectPaths } from "../core/paths.ts";
import {
  CandidatesSchema, EditPlanSchema, EditSchema, ScriptDocSchema, TranscriptSchema,
  type Candidates, type Config, type Edit, type EditPlan, type Project, type ScriptDoc, type Transcript,
} from "../core/schema.ts";
import { loadConfig, loadProject, readJson, readJsonIfExists, writeJson } from "../core/store.ts";
import { runClaude, type ClaudeEvent } from "./runner.ts";

export type PlanEditOptions = {
  signal?: AbortSignal;
  onEvent?: (e: ClaudeEvent) => void;
  bin?: string; // claude executable override (tests)
};

export type PlanEditResult = { plan: EditPlan; edit: Edit; warnings: string[]; costUsd?: number };

/** JSON schema handed to `claude --json-schema` (also written to schemas/edit-plan.json). */
export const editPlanJsonSchema = () => z.toJSONSchema(EditPlanSchema) as Record<string, unknown>;

export async function planEdit(slug: string, opts: PlanEditOptions = {}): Promise<PlanEditResult> {
  const paths = projectPaths(slug);
  const warnings: string[] = [];
  const [config, project, script, transcript, candidates, previous] = await Promise.all([
    loadConfig(),
    loadProject(slug),
    readJson(paths.script, ScriptDocSchema),
    readJson(paths.transcript, TranscriptSchema),
    readJson(paths.candidates, CandidatesSchema),
    readJsonIfExists(paths.edit, EditSchema).catch((e: unknown) => {
      warnings.push(`existing edit.json could not be read (${e instanceof Error ? e.message.split("\n")[0] : e}); starting fresh`);
      return null;
    }),
  ]);

  const inputFile = join(paths.runsDir, "plan-input.json");
  await mkdir(paths.runsDir, { recursive: true });
  await writeFile(inputFile, serialize(buildPlanInput({ project, script, transcript, candidates, config })));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basePrompt = [
    `Plan the edit for project ${slug}.`,
    `Read ${inputFile} completely. It is long: keep reading with offset/limit until you have seen every line.`,
    "Then decide takes, ad-libs, word cuts, filler gaps and graphics cues as your instructions describe,",
    "and return the whole plan as structured output matching the JSON schema. Use only ids that appear in the input file.",
  ].join(" ");

  let costUsd = 0;
  let plan: EditPlan | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
    const prompt = attempt === 1 ? basePrompt
      : `${basePrompt}\n\nYour previous answer was rejected by the validator:\n${lastError}\nFix these problems and return the complete plan again.`;
    const res = await runClaude({
      prompt,
      appendSystemPromptFile: join(PROMPTS_DIR, "edit-plan.md"),
      jsonSchema: editPlanJsonSchema(),
      allowedTools: ["Read"],
      model: config.claude.model,
      maxTurns: config.claude.maxTurns,
      cwd: REPO_ROOT,
      addDirs: [paths.root],
      signal: opts.signal,
      logFile: join(paths.runsDir, `plan-${stamp}-${attempt}.jsonl`),
      onEvent: opts.onEvent,
      bin: opts.bin,
    });
    costUsd += res.costUsd ?? 0;
    if (res.permissionDenials.length) warnings.push(`Claude was denied ${res.permissionDenials.length} tool call(s) during planning`);
    const parsed = EditPlanSchema.safeParse(res.structured);
    if (parsed.success) plan = parsed.data;
    else lastError = res.structured == null ? "No JSON plan was found in your reply." : z.prettifyError(parsed.error).slice(0, 4000);
  }
  if (!plan) throw new Error(`Claude's edit plan failed validation twice: ${lastError}`);

  await writeJson(paths.plan, EditPlanSchema, plan);
  const compiled = planToEdit(plan, { script, transcript, candidates, clips: project.clips, previous });
  const edit = await writeJson(paths.edit, EditSchema, compiled.edit);
  return { plan, edit, warnings: [...warnings, ...compiled.warnings], costUsd: costUsd || undefined };
}

// ---------- the compact input file ----------

type PlanInputCtx = { project: Project; script: ScriptDoc; transcript: Transcript; candidates: Candidates; config: Config };

const t2 = (x: number) => x.toFixed(2);

export function buildPlanInput({ project, script, transcript, candidates, config }: PlanInputCtx): Record<string, unknown> {
  const words = new Map(transcript.words.map((w) => [w.id, w]));
  const textOf = (startId: string, endId: string, max = 240) => {
    const a = transcript.words.findIndex((w) => w.id === startId);
    const b = transcript.words.findIndex((w) => w.id === endId);
    if (a < 0 || b < a) return "";
    const s = transcript.words.slice(a, b + 1).map((w) => w.text.trim()).join(" ");
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };

  // Transcript: one line per phrase (a run of words with no gap above the filler threshold).
  const gap = config.edit.fillerGapMs / 1000;
  const lines: string[] = [];
  const byClip = new Map<string, typeof transcript.words>();
  for (const w of transcript.words) {
    const list = byClip.get(w.clipId) ?? [];
    list.push(w);
    byClip.set(w.clipId, list);
  }
  for (const [clipId, list] of byClip) {
    list.sort((a, b) => a.start - b.start);
    let phrase: typeof list = [];
    const flush = () => {
      if (!phrase.length) return;
      lines.push(`${clipId} ${t2(phrase[0]!.start)}-${t2(phrase.at(-1)!.end)}: ${phrase.map((w) => `${w.id}:${w.text.trim()}`).join(" ")}`);
      phrase = [];
    };
    for (const w of list) {
      const prev = phrase.at(-1);
      if (prev && (w.start - prev.end > gap || phrase.length >= 16)) flush();
      phrase.push(w);
    }
    flush();
  }

  return {
    project: project.slug,
    title: script.title,
    speakerSide: project.speakerSide,
    graphicsSide: project.speakerSide === "center" ? "either (choose per cue)" : project.speakerSide === "left" ? "right" : "left",
    formats: {
      transcript: "<clipId> <start>-<end>: <wordId>:<word> … (seconds; a new line starts after a pause longer than "
        + `${config.edit.fillerGapMs} ms or every 16 words)`,
      takes: "<sentenceId> aligner=<index of the aligner's pick | none> | #<index> <clipId> <startWordId>-<endWordId> score=<0-1> | …",
      adlibs: "<clipId> <startWordId>-<endWordId>: <text>",
      fillers: "<fillerId> token <clipId> <start>-<end> word=<wordId> \"<text>\"  |  <fillerId> gap <clipId> <start>-<end> after=<wordId>",
    },
    clips: project.clips.map((c) => `${c.id} "${c.name}" ${t2(c.duration)}s`),
    sections: script.sections.map((s) => `${s.id} ${"#".repeat(s.level)} ${s.title}: ${s.sentenceIds.join(" ") || "(no spoken lines)"}`),
    sentences: script.sentences.map((s) => `${s.id} ${s.text}`),
    cues: script.cues.map((c) => ({
      id: c.id, kind: c.kind, optional: c.optional, sectionId: c.sectionId, afterSentenceId: c.afterSentenceId,
      ...(c.phrase ? { phrase: c.phrase } : {}), holdSection: c.holdSection, text: c.text,
      ...(c.flags.length ? { flags: c.flags } : {}),
    })),
    takes: candidates.sentences.map((s) => [
      `${s.sentenceId} aligner=${s.chosen ?? "none"}`,
      ...s.occurrences.map((o, i) => `#${i} ${o.clipId} ${o.startWordId}-${o.endWordId} score=${o.score.toFixed(2)}`),
    ].join(" | ")),
    missing: candidates.missing,
    adlibs: candidates.adlibs.map((a) => `${a.clipId} ${a.startWordId}-${a.endWordId}: ${textOf(a.startWordId, a.endWordId)}`),
    fillers: transcript.fillers.map((f) => f.kind === "token"
      ? `${f.id} token ${f.clipId} ${t2(f.start)}-${t2(f.end)} word=${f.wordId ?? "?"} "${f.wordId ? words.get(f.wordId)?.text.trim() ?? "" : ""}"`
      : `${f.id} gap ${f.clipId} ${t2(f.start)}-${t2(f.end)} after=${f.afterWordId ?? "?"}`),
    transcript: lines,
  };
}

/** JSON with one array item per line, so Claude's Read tool never truncates a giant line. */
export function serialize(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(([k, v]) => {
    if (Array.isArray(v)) {
      return v.length ? `  ${JSON.stringify(k)}: [\n${v.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]` : `  ${JSON.stringify(k)}: []`;
    }
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n${parts.join(",\n")}\n}\n`;
}
