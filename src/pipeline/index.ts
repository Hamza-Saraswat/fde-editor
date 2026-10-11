// The pipeline: one function per stage. The server's job manager runs them; tests call them directly.
import type { StageName } from "../core/schema.ts";
import { graphicsStage } from "./graphics.ts";
import { importStage } from "./import.ts";
import { planStage } from "./plan.ts";
import { previewStage } from "./preview.ts";
import { renderStage } from "./render.ts";
import { alignStage, transcribeStage } from "./transcribe.ts";
import type { PipelineDeps, StageContext, StageFn } from "./types.ts";
import { xclipsStage } from "./xclips.ts";

export const STAGES: Record<StageName, StageFn<never>> = {
  import: importStage,
  transcribe: transcribeStage,
  align: alignStage,
  plan: planStage,
  graphics: graphicsStage,
  preview: previewStage,
  render: renderStage,
  xclips: xclipsStage,
};

export function runStage(stage: StageName, slug: string, ctx: StageContext<unknown>, deps?: Partial<PipelineDeps>): Promise<string> {
  return (STAGES[stage] as StageFn<unknown>)(slug, ctx, deps);
}

export { importStage, transcribeStage, alignStage, planStage, graphicsStage, previewStage, renderStage, xclipsStage };
export { realDeps, withDeps, type PipelineDeps, type StageContext, type StageFn } from "./types.ts";
export { scriptSpellingMap } from "./spelling.ts";
