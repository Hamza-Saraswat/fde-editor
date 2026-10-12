// Shared shapes for the pipeline stages: the context a job hands each stage, and the injectable
// dependencies (real module functions by default, fakes in tests).
import { sweepResidualFillers } from "../transcribe/sweep.ts";
import { ensureIntro, ensureOutro } from "../graphics/hyperframes.ts";
import { alignScript } from "../core/aligner.ts";
import { loadConfig } from "../core/store.ts";
import type { StageName } from "../core/schema.ts";
import { planEdit } from "../claude/edit-plan.ts";
import { planXClips } from "../claude/xclips.ts";
import { buildGraphic, graphicStatuses } from "../graphics/index.ts";
import { renderCaptionLayer } from "../graphics/captions.ts";
import { prepareClip } from "../media/prepare.ts";
import { probeClip } from "../media/probe.ts";
import { buildPreview, renderFinal, renderXClip } from "../media/render.ts";
import { transcribeProject } from "../transcribe/index.ts";
import type { ServerEvent } from "../server/api.ts";

export type StageContext<O = unknown> = {
  signal: AbortSignal;
  /** Publish an event to every UI listening on this project. */
  emit: (event: ServerEvent) => void;
  /** fraction 0–1 (undefined = unknown, keep the bar indeterminate) plus a short human message. */
  progress: (fraction: number | undefined, message: string) => void;
  options: O;
  /** Start another stage once this one finishes successfully. */
  chain: (stage: StageName, options?: unknown) => void;
};

export type PipelineDeps = {
  loadConfig: typeof loadConfig;
  probeClip: typeof probeClip;
  prepareClip: typeof prepareClip;
  transcribeProject: typeof transcribeProject;
  alignScript: typeof alignScript;
  planEdit: typeof planEdit;
  buildPreview: typeof buildPreview;
  renderFinal: typeof renderFinal;
  renderXClip: typeof renderXClip;
  buildGraphic: typeof buildGraphic;
  graphicStatuses: typeof graphicStatuses;
  renderCaptionLayer: typeof renderCaptionLayer;
  planXClips: typeof planXClips;
  ensureIntro: typeof ensureIntro;
  ensureOutro: typeof ensureOutro;
  sweepResidualFillers: typeof sweepResidualFillers;
};

export const realDeps: PipelineDeps = {
  loadConfig,
  probeClip,
  prepareClip,
  transcribeProject,
  alignScript,
  planEdit,
  buildPreview,
  renderFinal,
  renderXClip,
  buildGraphic,
  graphicStatuses,
  renderCaptionLayer,
  planXClips,
  ensureIntro,
  ensureOutro,
  sweepResidualFillers,
};

export const withDeps = (deps?: Partial<PipelineDeps>): PipelineDeps => ({ ...realDeps, ...deps });

/** One pipeline stage: does its work, returns the "done" message shown in the pipeline bar. */
export type StageFn<O = unknown> = (slug: string, ctx: StageContext<O>, deps?: Partial<PipelineDeps>) => Promise<string>;

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 75.4 -> "1:15" */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
