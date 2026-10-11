// Import → Transcribe (→ Align) → Plan edit → Graphics → Preview → Render → X clips, plus the log toggle.
import { Fragment } from "react";
import type { StageName } from "../types.ts";
import { useApp } from "../state/app.tsx";
import { useProject } from "../state/ProjectProvider.tsx";
import { runningJob } from "../state/projectStore.ts";
import { PIPELINE, STAGE_LABEL } from "../lib/stages.ts";
import { PipelineStep } from "./PipelineStep.tsx";
import { TranscribeOptions, useTranscribeChoice } from "./TranscribeOptions.tsx";
import { Icon } from "./Icon.tsx";

const NEEDS_CLAUDE: StageName[] = ["plan", "graphics", "xclips"];

export function PipelineBar({ logOpen, onToggleLog }: { logOpen: boolean; onToggleLog: () => void }) {
  const { health } = useApp();
  const { state, runStage, cancelJob } = useProject();
  const [choice, setChoice] = useTranscribeChoice();
  const b = state.bundle!;

  const blockedReason = (stage: StageName): string | undefined => {
    if (NEEDS_CLAUDE.includes(stage) && health && !health.claudeLoggedIn) return "Log in to the Claude CLI first (claude auth login)";
    if (stage === "transcribe" && !b.project.clips.length) return "Add a recording first";
    if ((stage === "align" || stage === "plan") && !b.transcript) return "Transcribe the recording first";
    if (["graphics", "preview", "render", "xclips"].includes(stage) && !b.edit) return "Run Plan edit first";
    return undefined;
  };

  return (
    <nav aria-label="Pipeline" className="flex h-[56px] flex-none items-stretch gap-1 border-b border-line bg-pane px-1.5 py-1">
      <ol className="flex min-w-0 flex-1 items-stretch">
        {PIPELINE.map((stage, i) => (
          <Fragment key={stage}>
            {i > 0 && (
              <li aria-hidden="true" className="flex flex-none items-center text-faint">
                <Icon name="chevronRight" size={12} />
              </li>
            )}
            <PipelineStep
              label={STAGE_LABEL[stage]}
              status={b.project.stages[stage]}
              job={runningJob(b, stage)}
              blocked={blockedReason(stage)}
              narrow={stage === "align"}
              onRun={() => runStage(stage, stage === "transcribe" ? choice : undefined)}
              onCancel={() => {
                const job = runningJob(b, stage);
                if (job) void cancelJob(job.id);
              }}
              options={stage === "transcribe" ? <TranscribeOptions value={choice} onChange={setChoice} /> : undefined}
            />
          </Fragment>
        ))}
      </ol>
      <button
        type="button"
        className={`btn btn-sm self-center ${logOpen ? "border-accent" : ""}`}
        aria-pressed={logOpen}
        aria-label={`Log${state.unreadLogs ? `, ${state.unreadLogs} new lines` : ""}`}
        title="Log (`)"
        onClick={onToggleLog}
      >
        <Icon name="log" size={14} />
        Log
        {state.unreadLogs > 0 && !logOpen && <span className="rounded-full bg-run px-1.5 text-[10.5px] font-semibold text-ground">{state.unreadLogs > 99 ? "99+" : state.unreadLogs}</span>}
      </button>
    </nav>
  );
}
