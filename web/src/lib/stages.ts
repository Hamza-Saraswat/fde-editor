import type { StageName } from "../types.ts";

export const STAGE_LABEL: Record<StageName, string> = {
  import: "Import",
  transcribe: "Transcribe",
  align: "Align",
  plan: "Plan edit",
  graphics: "Graphics",
  preview: "Preview",
  render: "Render",
  xclips: "X clips",
};

/** The pipeline bar, in order. Align runs after Transcribe and shows as a small step between. */
export const PIPELINE: StageName[] = ["import", "transcribe", "align", "plan", "graphics", "preview", "render", "xclips"];
