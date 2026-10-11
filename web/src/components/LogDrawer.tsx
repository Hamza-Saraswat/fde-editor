// The live log: stage output lines, job transitions, and Claude's own words and tool calls.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StageName } from "../types.ts";
import { useProject } from "../state/ProjectProvider.tsx";
import type { LogEntry } from "../state/projectStore.ts";
import { STAGE_LABEL } from "../lib/stages.ts";
import { Icon } from "./Icon.tsx";

type Filter = "all" | "claude" | StageName;

export function LogDrawer({ onClose }: { onClose: () => void }) {
  const { state, dispatch, select, edit } = useProject();
  const [filter, setFilter] = useState<Filter>("all");
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const stages = useMemo(() => [...new Set(state.logs.map((l) => l.stage))], [state.logs]);
  const shown = useMemo(
    () => state.logs.filter((l) => filter === "all" || (filter === "claude" ? l.kind === "claude" : l.stage === filter)),
    [state.logs, filter],
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [shown.length, follow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectCue = (cueId: string) => {
    const ov = edit?.overlays.find((o) => o.cueId === cueId);
    select(ov ? { kind: "overlay", id: ov.id } : { kind: "cue", cueId });
  };

  return (
    <section
      aria-label="Log"
      className="absolute inset-x-0 bottom-0 z-30 flex h-[42%] min-h-[220px] flex-col border-t border-line-strong bg-[#191c1b] shadow-[0_-12px_30px_rgb(0_0_0/0.35)]"
    >
      <header className="flex flex-none items-center gap-2 border-b border-line px-3 py-1.5">
        <h2 className="pane-title">Log</h2>
        <div role="tablist" aria-label="Filter the log" className="seg ml-2">
          {(["all", "claude", ...stages] as Filter[]).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "Everything" : f === "claude" ? "Claude" : STAGE_LABEL[f]}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-2">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: "clearLogs" })} disabled={!state.logs.length}>
          Clear
        </button>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Close the log" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto px-3 py-2"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {shown.length === 0 && <p className="meta py-6 text-center">Nothing yet. Run a step and its output streams here, including what Claude is doing.</p>}
        <ol className="grid gap-0.5">
          {shown.map((l) => (
            <LogLine key={l.id} entry={l} onCue={selectCue} />
          ))}
        </ol>
      </div>
    </section>
  );
}

function LogLine({ entry: l, onCue }: { entry: LogEntry; onCue: (cueId: string) => void }) {
  const time = new Date(l.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const stage = <span className="w-[74px] flex-none truncate text-[11px] text-faint">{STAGE_LABEL[l.stage]}</span>;
  const stamp = <span className="tc w-[58px] flex-none text-[11px] text-faint">{time}</span>;
  if (l.kind === "log") {
    return (
      <li className="flex gap-2 text-[12px]">
        {stamp}
        {stage}
        <span className="tc min-w-0 whitespace-pre-wrap break-words text-ink-2">{l.line}</span>
      </li>
    );
  }
  if (l.kind === "job") {
    const verb = { running: "started", done: "finished", error: "failed", cancelled: "cancelled" }[l.job.state];
    return (
      <li className="flex gap-2 py-0.5 text-[12px]">
        {stamp}
        {stage}
        <span className={l.job.state === "error" ? "text-bad" : "text-ink"}>
          {STAGE_LABEL[l.job.stage]} {verb}
          {l.job.message ? `: ${l.job.message}` : ""}
        </span>
      </li>
    );
  }
  const e = l.event;
  const cue = l.cueId ? (
    <button type="button" className="rounded bg-raised px-1.5 text-[11px] text-ink-2 hover:text-ink" onClick={() => onCue(l.cueId!)} aria-label={`Select cue ${l.cueId}`}>
      {l.cueId}
    </button>
  ) : null;
  return (
    <li className="flex gap-2 text-[12.5px]">
      {stamp}
      {stage}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="flex-none text-[11px] font-semibold text-accent">Claude</span>
        {cue}
        {e.kind === "init" && <span className="text-muted">started ({e.model})</span>}
        {e.kind === "text" && <span className="min-w-0 whitespace-pre-wrap text-ink">{e.text}</span>}
        {e.kind === "tool" && (
          <span className="min-w-0 text-ink-2">
            <span className="font-medium text-ink">{e.name}</span> <span className="tc text-[12px]">{e.input}</span>
          </span>
        )}
        {e.kind === "result" && (
          <span className={e.ok ? "text-ok" : "text-bad"}>
            {e.ok ? "Done" : "Failed"}
            {e.text ? `: ${e.text}` : ""}
            <span className="meta ml-2">
              {[e.turns !== undefined ? `${e.turns} turns` : "", e.costUsd !== undefined ? `$${e.costUsd.toFixed(2)}` : "", e.durationMs !== undefined ? `${Math.round(e.durationMs / 1000)} s` : ""]
                .filter(Boolean)
                .join(", ")}
            </span>
          </span>
        )}
      </span>
    </li>
  );
}
