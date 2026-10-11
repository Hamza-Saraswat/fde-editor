// Plan stage: Claude plans the edit (plan.json → edit.json), then a preview is built.
import { existsSync } from "node:fs";
import { projectPaths } from "../core/paths.ts";
import type { ClaudeEvent } from "../claude/runner.ts";
import { plural, withDeps, type StageFn } from "./types.ts";

/** Short status line for a Claude event (the pipeline bar shows it while Claude works). */
export function claudeEventLine(e: ClaudeEvent): string | null {
  switch (e.kind) {
    case "init":
      return `Claude (${e.model}) started`;
    case "tool":
      return `Claude: ${e.name} ${e.input}`.slice(0, 160);
    case "text":
      return null;
    case "result":
      return e.ok ? "Claude finished" : "Claude reported a problem";
  }
}

export const planStage: StageFn = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  if (!existsSync(projectPaths(slug).candidates)) throw new Error("No alignment yet — run Transcribe first");
  ctx.progress(undefined, "Asking Claude to plan the edit");
  const res = await d.planEdit(slug, {
    signal: ctx.signal,
    onEvent: (event) => {
      ctx.emit({ type: "claude", stage: "plan", event });
      const line = claudeEventLine(event);
      if (line) ctx.progress(undefined, line);
    },
  });
  for (const w of res.warnings) ctx.emit({ type: "log", stage: "plan", line: `warning: ${w}` });
  ctx.chain("preview");
  const e = res.edit;
  const parts = [
    `Edit planned: ${plural(e.takeGroups.length, "take group")}`,
    plural(e.cuts.length, "cut"),
    plural(e.overlays.filter((o) => o.enabled).length, "graphic"),
    plural(res.warnings.length, "warning"),
  ];
  if (res.costUsd) parts.push(`$${res.costUsd.toFixed(2)}`);
  return parts.join(" · ");
};
