// A graphic's build: state, still, out-of-date warnings, and Build / Rebuild with a note.
import { useState } from "react";
import type { Overlay } from "../types.ts";
import { useApp } from "../state/app.tsx";
import { useProject } from "../state/ProjectProvider.tsx";
import { overlaySide, type Placement } from "../lib/placement.ts";
import { timeAgo } from "../lib/format.ts";
import { formatSeconds } from "../lib/timelineMath.ts";
import { Icon } from "./Icon.tsx";

const STATE_TEXT = { none: "Not built", queued: "Queued", building: "Claude is building it", rendering: "Rendering", ready: "Ready", error: "Build failed" } as const;

export function GraphicStatusPanel({ overlay: o, placement: p }: { overlay: Overlay; placement: Placement | null }) {
  const { health } = useApp();
  const { state, runStage, dirty, saveNow } = useProject();
  const [note, setNote] = useState("");
  const b = state.bundle!;
  const g = b.graphics[o.cueId];
  const st = g?.state ?? "none";
  const busy = st === "queued" || st === "building" || st === "rendering";
  const dot = st === "ready" ? (g?.stale ? "warn" : "done") : st === "error" ? "error" : busy ? "running" : "idle";
  const len = p ? p.end - p.start : null;
  const lengthOff = g?.durationSec !== undefined && len !== null && Math.abs(g.durationSec - len) > 0.25;
  const side = overlaySide(o, b.project.speakerSide);
  const sideOff = o.layout === "side" && g?.side && g.side !== side;
  const built = st === "ready" || !!g?.still;
  const claudeOk = !health || health.claudeLoggedIn;

  const build = () => {
    if (dirty) saveNow(); // build from the latest timing and brief
    void runStage("graphics", { cueIds: [o.cueId], note: note.trim() || undefined, force: true });
    setNote("");
  };

  return (
    <section aria-labelledby={`gfx-${o.id}`} className="grid gap-2.5 rounded-md border border-line p-2.5">
      <div className="flex items-center gap-2">
        <h3 id={`gfx-${o.id}`} className="text-[12px] font-semibold text-ink-2">
          Graphic
        </h3>
        <span className="flex items-center gap-1.5 text-[12px] text-ink" role="status">
          <span className="dot" data-state={dot} />
          {STATE_TEXT[st]}
        </span>
        {g?.updatedAt && <span className="meta ml-auto">{timeAgo(g.updatedAt)}</span>}
      </div>
      {g?.message && st !== "ready" && <p className={`text-[12px] ${st === "error" ? "text-bad" : "text-ink-2"}`}>{g.message}</p>}
      {(g?.stale || lengthOff || sideOff) && (
        <p className="flex gap-2 rounded bg-[#2d2719] px-2 py-1.5 text-[12px] text-warn">
          <Icon name="warn" size={14} className="mt-px flex-none" />
          <span>
            Out of date.
            {lengthOff && ` Built for ${formatSeconds(g!.durationSec!)}; it's on screen for ${formatSeconds(len!)} now.`}
            {sideOff && ` Built for the ${g!.side} side; it's set to the ${side} now.`}
            {g?.stale && !lengthOff && !sideOff && " The timing, side or brief changed since it was built."} Rebuild to match.
          </span>
        </p>
      )}
      {g?.still ? (
        <div
          className="overflow-hidden rounded border border-line"
          style={{ aspectRatio: "16 / 9", background: "repeating-conic-gradient(#2a2f2d 0% 25%, #222625 0% 50%) 0 0 / 16px 16px" }}
        >
          <img src={g.still} alt={`Still of graphic ${o.cueId}`} className="h-full w-full object-contain" />
        </div>
      ) : (
        <p className="meta">No still yet. It appears here once the graphic is built.</p>
      )}
      {g && (
        <p className="meta">
          {g.webm ? "Preview video ready." : built ? "Preview video not ready yet." : ""} {g.hasMov ? "Final render file ready." : built ? "Final render pending." : ""}
        </p>
      )}
      <label className="grid gap-1">
        <span className="text-[11.5px] font-medium text-muted">{built ? "Note for the rebuild" : "Note for Claude (optional)"}</span>
        <textarea
          className="field min-h-[56px] w-full text-[12.5px]"
          placeholder={built ? "e.g. make the middle layer bigger and hold the last card longer" : "Anything to add to the brief"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button type="button" className="btn btn-primary justify-self-start" disabled={busy || !claudeOk || !o.enabled} onClick={build} title={!claudeOk ? "Log in to the Claude CLI first" : !o.enabled ? "Turn the graphic on first" : undefined}>
        {busy ? "Building…" : built || st === "error" ? (note.trim() ? "Rebuild with note" : "Rebuild") : "Build graphic"}
      </button>
    </section>
  );
}
