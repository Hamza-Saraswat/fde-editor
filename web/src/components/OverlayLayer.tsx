// Graphics over the player: the transparent webm when built, else the still, else a labelled box
// where the graphic will sit. Each shows only between its placed start and end.
import { useEffect, useRef } from "react";
import type { GraphicStatus, Overlay } from "../types.ts";
import { useDerived, useProject } from "../state/ProjectProvider.tsx";
import { usePlayhead } from "../state/player.tsx";
import { overlaySide, type Placement } from "../lib/placement.ts";

/** Box for a placeholder, in % of the frame. */
function boxes(o: Overlay, speakerSide: "left" | "right" | "center"): { left: number; width: number }[] {
  if (o.layout === "full") return [{ left: 4, width: 92 }];
  if (o.layout === "split") return [{ left: 3, width: 30 }, { left: 67, width: 30 }];
  return overlaySide(o, speakerSide) === "left" ? [{ left: 2, width: 53 }] : [{ left: 45, width: 53 }];
}

export function OverlayLayer() {
  const { state, edit } = useProject();
  const { placements } = useDerived();
  const snap = usePlayhead();
  if (!edit) return null;
  const b = state.bundle!;
  const selectedId = state.selection?.kind === "overlay" ? state.selection.id : null;
  const active = placements.filter((p) => p.enabled && snap.time >= p.start && snap.time < p.end);
  return (
    <div className="pointer-events-none absolute inset-0" aria-label="Graphics on screen" role="group">
      {active.map((p) => {
        const o = edit.overlays.find((x) => x.id === p.overlayId);
        if (!o) return null;
        return <ActiveGraphic key={p.overlayId} overlay={o} placement={p} status={b.graphics[o.cueId]} time={snap.time} playing={snap.playing} selected={selectedId === o.id} speakerSide={b.project.speakerSide} />;
      })}
    </div>
  );
}

function ActiveGraphic({
  overlay: o,
  placement: p,
  status,
  time,
  playing,
  selected,
  speakerSide,
}: {
  overlay: Overlay;
  placement: Placement;
  status: GraphicStatus | undefined;
  time: number;
  playing: boolean;
  selected: boolean;
  speakerSide: "left" | "right" | "center";
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const local = time - p.start;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // let it run free while playing unless it drifts; follow the playhead exactly while scrubbing
    const drift = Math.abs(v.currentTime - local);
    if ((playing && drift > 0.25) || (!playing && drift > 0.02)) v.currentTime = Math.max(0, local);
    if (playing && v.paused) void v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }, [local, playing]);

  const label = `${o.cueId}: ${o.brief.slice(0, 90)}${o.brief.length > 90 ? "…" : ""}`;
  const ring = selected ? "outline outline-2 outline-[var(--color-accent)] -outline-offset-2" : "";

  if (status?.webm) {
    return <video ref={ref} src={status.webm} muted playsInline preload="auto" className={`absolute inset-0 h-full w-full ${ring}`} aria-label={`Graphic ${label}`} />;
  }
  if (status?.still) {
    return <img src={status.still} alt={`Graphic ${label} (still)`} className={`absolute inset-0 h-full w-full object-contain ${ring}`} />;
  }
  return (
    <>
      {boxes(o, speakerSide).map((bx, i) => (
        <div
          key={i}
          className="absolute top-[10%] flex h-[80%] flex-col justify-end rounded-md border-2 border-dashed p-[1.2%]"
          style={{
            left: `${bx.left}%`,
            width: `${bx.width}%`,
            borderColor: selected ? "var(--color-accent)" : "rgb(231 228 221 / 0.55)",
            background: "rgb(16 18 17 / 0.45)",
          }}
          role="img"
          aria-label={`Graphic ${o.cueId} placeholder, ${status?.state ?? "not built"}`}
        >
          {i === 0 && (
            <span className="text-[clamp(9px,1.1cqw,13px)] leading-tight text-ink">
              <strong className="mr-1">{o.cueId}</strong>
              <span className="text-ink-2">{status ? stateText(status) : "not built"}</span>
              <span className="mt-0.5 line-clamp-2 block text-ink-2">{o.brief}</span>
            </span>
          )}
        </div>
      ))}
    </>
  );
}

const stateText = (s: GraphicStatus) =>
  ({ none: "not built", queued: "queued", building: "Claude is building it", rendering: "rendering", ready: "ready", error: "build failed" })[s.state];
