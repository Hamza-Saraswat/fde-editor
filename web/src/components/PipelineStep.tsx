// One step of the pipeline bar: status dot and name, then the message or progress (or the step's own
// options), with Run / Re-run / Cancel on the right.
import type { ReactNode } from "react";
import type { JobInfo, StageStatus } from "../types.ts";
import { Icon } from "./Icon.tsx";

export function PipelineStep({
  label,
  status,
  job,
  blocked,
  onRun,
  onCancel,
  narrow = false,
  options,
}: {
  label: string;
  status: StageStatus | undefined;
  job: JobInfo | null;
  blocked?: string; // why Run is unavailable
  onRun: () => void;
  onCancel: () => void;
  narrow?: boolean;
  options?: ReactNode; // shown on the second line when the step isn't running (e.g. the engine picker)
}) {
  const running = !!job || status?.state === "running";
  const state = running ? "running" : (status?.state ?? "idle");
  const progress = job?.progress ?? status?.progress;
  const message = (running ? job?.message || status?.message : status?.message) || (state === "idle" ? "Not run yet" : "");
  const stateText = { idle: "not run", running: "running", done: "done", error: "failed" }[state];

  const action = running ? (
    <button
      type="button"
      className={`btn btn-sm ${narrow ? "btn-icon" : ""}`}
      onClick={onCancel}
      disabled={!job}
      title={job ? `Cancel ${label}` : "Waiting for the job id"}
      aria-label={`Cancel ${label}`}
    >
      <Icon name="stop" size={10} />
      {!narrow && <span className="hidden min-[1440px]:inline">Cancel</span>}
    </button>
  ) : (
    <button
      type="button"
      className={`btn btn-sm ${narrow ? "btn-icon" : ""}`}
      onClick={onRun}
      disabled={!!blocked}
      title={blocked ?? (state === "idle" ? `Run ${label}` : `Run ${label} again`)}
      aria-label={state === "idle" ? `Run ${label}` : `Re-run ${label}`}
    >
      {narrow ? (
        <Icon name="refresh" size={13} />
      ) : (
        <>
          <Icon name={state === "idle" ? "play" : "refresh"} size={state === "idle" ? 10 : 13} className="min-[1440px]:hidden" />
          <span className="hidden min-[1440px]:inline">{state === "idle" ? "Run" : "Re-run"}</span>
        </>
      )}
    </button>
  );

  if (narrow) {
    return (
      <li className="flex flex-none items-center gap-1.5 rounded-md px-1.5" aria-label={`${label}: ${stateText}${message ? `. ${message}` : ""}`} title={message}>
        <span className="dot" data-state={state} aria-hidden="true" />
        <span className="text-[12px] text-ink-2">{label}</span>
        {action}
      </li>
    );
  }

  return (
    <li
      className={`grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-2 gap-y-1 rounded-md px-2 py-1 ${state === "error" ? "bg-[#2b2120]" : ""}`}
      aria-label={`${label}: ${stateText}${message ? `. ${message}` : ""}`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="dot" data-state={state} aria-hidden="true" />
        <span className={`truncate text-[12.5px] font-medium ${state === "idle" ? "text-ink-2" : "text-ink"}`}>{label}</span>
      </span>
      <span className="row-span-2 flex items-center">{action}</span>
      {running ? (
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="progress min-w-[28px] flex-1"
            role="progressbar"
            aria-label={`${label} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress !== undefined ? Math.round(progress * 100) : undefined}
            data-indeterminate={progress === undefined ? "" : undefined}
          >
            <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          </span>
          <span className="meta max-w-[60%] truncate text-[11px]" title={message}>
            {message}
          </span>
        </span>
      ) : options ? (
        <span className="flex min-w-0 items-center" title={message}>
          {options}
        </span>
      ) : (
        <span className={`truncate text-[11px] leading-tight ${state === "error" ? "text-bad" : "text-muted"}`} title={message}>
          {message}
        </span>
      )}
    </li>
  );
}
