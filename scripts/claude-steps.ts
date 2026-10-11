// Run the Claude-driven steps in two halves, so the "Claude" in the middle can be any agent that
// follows the same system prompt + user prompt + output contract (a Claude Code session, a subagent,
// or `claude -p` itself). Each `prepare-*` prints exactly what a headless run would receive; each
// `apply-*` feeds the answer through the same validation and pipeline code the server uses.
//
//   tsx scripts/claude-steps.ts prepare-plan <slug>                 → prompt, system prompt file, input, schema
//   tsx scripts/claude-steps.ts apply-plan <slug> <answer.json>     → validate + compile edit.json
//   tsx scripts/claude-steps.ts prepare-graphics <slug> [cueId…]    → one prompt per graphic
//   tsx scripts/claude-steps.ts finish-graphics <slug> [cueId…]     → lint/check/duration, render, statuses
//   tsx scripts/claude-steps.ts prepare-xclips <slug> [count]       → prompt, input, schema
//   tsx scripts/claude-steps.ts apply-xclips <slug> <answer.json>   → validate, then the real X-clips stage renders them
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPlan, editPlanJsonSchema, preparePlan } from "../src/claude/edit-plan.ts";
import { applyXClips, prepareXClips } from "../src/claude/xclips.ts";
import { projectPaths } from "../src/core/paths.ts";
import { EditSchema } from "../src/core/schema.ts";
import { readJson } from "../src/core/store.ts";
import { finishGraphic, prepareGraphic, validateGraphic, type PreparedGraphic } from "../src/graphics/index.ts";
import { xclipsStage } from "../src/pipeline/xclips.ts";

const [cmd, slug, ...rest] = process.argv.slice(2);
if (!cmd || !slug) throw new Error("usage: claude-steps <command> <slug> [...]");
const paths = projectPaths(slug);
const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

async function enabledCues(only: string[]): Promise<string[]> {
  const edit = await readJson(paths.edit, EditSchema);
  return edit.overlays.filter((o) => o.enabled && (!only.length || only.includes(o.cueId))).map((o) => o.cueId);
}

switch (cmd) {
  case "prepare-plan": {
    const prep = await preparePlan(slug);
    const schemaFile = join(paths.runsDir, "edit-plan.schema.json");
    await writeFile(schemaFile, JSON.stringify(editPlanJsonSchema(), null, 2));
    out({ prompt: prep.prompt, systemPromptFile: prep.systemPromptFile, inputFile: prep.inputFile, schemaFile, answerFile: join(paths.runsDir, "plan-answer.json") });
    break;
  }
  case "apply-plan": {
    const prep = await preparePlan(slug);
    const res = await applyPlan(prep, JSON.parse(await readFile(rest[0]!, "utf8")));
    if ("error" in res) {
      console.error(res.error);
      process.exit(2);
    }
    out({ takes: res.plan.takes.length, wordCuts: res.plan.wordCuts.length, adlibs: res.plan.adlibs.map((a) => ({ keep: a.keep, why: a.why })), cues: res.plan.cues.map((c) => ({ cue: c.cueId, include: c.include, layout: c.layout })), warnings: res.warnings, editVersion: res.edit.version });
    break;
  }
  case "prepare-graphics": {
    const list: Pick<PreparedGraphic, "cueId" | "dir" | "prompt" | "systemPromptFile" | "allowedTools" | "durationSec">[] = [];
    for (const cueId of await enabledCues(rest)) {
      const p = await prepareGraphic(slug, cueId, { force: true });
      list.push({ cueId, dir: p.dir, prompt: p.prompt, systemPromptFile: p.systemPromptFile, allowedTools: p.allowedTools, durationSec: p.durationSec });
    }
    out(list);
    break;
  }
  case "finish-graphics": {
    for (const cueId of await enabledCues(rest)) {
      const p = await prepareGraphic(slug, cueId, { force: true }).catch((e: Error) => e);
      if (p instanceof Error) {
        out({ cueId, error: p.message });
        continue;
      }
      // prepareGraphic re-staged the kit and input.json; index.html (Claude's work) is left as written.
      const v = await validateGraphic(p);
      if (!v.ok) {
        out({ cueId, valid: false, output: v.output.slice(-1500) });
        continue;
      }
      const status = await finishGraphic(p, { onProgress: () => {} });
      out({ cueId, state: status.state, message: status.message, hasMov: status.hasMov, stale: status.stale });
    }
    break;
  }
  case "prepare-xclips": {
    const prep = await prepareXClips(slug, Number(rest[0] ?? 3));
    const schemaFile = join(paths.runsDir, "x-clips.schema.json");
    await writeFile(schemaFile, JSON.stringify(prep.jsonSchema, null, 2));
    out({ prompt: prep.prompt, systemPromptFile: prep.systemPromptFile, inputFile: prep.inputFile, schemaFile, answerFile: join(paths.runsDir, "xclips-answer.json") });
    break;
  }
  case "apply-xclips": {
    const answer = JSON.parse(await readFile(rest[0]!, "utf8"));
    const prep = await prepareXClips(slug, 3);
    const plan = await applyXClips(prep, answer);
    // The real X-clips stage, with only its Claude call swapped for the validated answer.
    const msg = await xclipsStage(slug, {
      signal: new AbortController().signal,
      emit: () => {},
      progress: (f, m) => process.stderr.write(`${f === undefined ? "…" : Math.round(f * 100) + "%"} ${m}\n`),
      options: { count: plan.clips.length },
      chain: () => {},
    }, { planXClips: async () => plan });
    out({ clips: plan.clips, stage: msg });
    break;
  }
  default:
    throw new Error(`unknown command ${cmd}`);
}
