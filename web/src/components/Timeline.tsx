// Output-time timeline: ruler, A-roll segments with cut notches, graphics blocks (drag to nudge,
// drag the right edge to set the length, both snapped to frames), chapter flags, and the playhead.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useDerived, useProject } from "../state/ProjectProvider.tsx";
import { usePlayer } from "../state/player.tsx";
import { nudgeOverlay, setOverlayDuration } from "../lib/editOps.ts";
import { fitZoom, formatSeconds, formatTick, MAX_PPS, MIN_PPS, rulerTicks, scrollForZoom, snapToFrame, zoomStep } from "../lib/timelineMath.ts";
import { REASON_LABEL, REASONS, reasonColor } from "../lib/format.ts";
import type { Placement } from "../lib/placement.ts";
import { Icon } from "./Icon.tsx";

const PAD = 10; // px before t = 0
const ROW = { ruler: 22, aroll: 34, gfx: 42, chapters: 22 };
const LABEL_W = 76;

type Drag = { id: string; mode: "move" | "end"; x0: number; start: number; end: number; offsetMs: number; dt: number; moved: boolean };

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable='true']");

export function Timeline() {
  const { state, edit, apply, select } = useProject();
  const { placements, joins, fps, duration } = useDerived();
  const { transport } = usePlayer();
  const b = state.bundle!;
  const tl = b.timeline;
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(900);
  const [zoom, setZoom] = useState<number | null>(null); // px per second; null = fit
  const [drag, setDrag] = useState<Drag | null>(null);
  const [scrollX, setScrollX] = useState(0);

  const pps = zoom ?? fitZoom(duration, Math.max(100, viewW - PAD * 2 - 8));
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const contentW = Math.max(viewW, Math.ceil(duration * pps) + PAD * 2 + 40);
  const x = (t: number) => PAD + t * pps;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const zoomBy = (dir: number, clientX?: number) => {
    const el = scroller.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cur = ppsRef.current;
    const phX = PAD + transport.time * cur - el.scrollLeft;
    const anchorX = clientX !== undefined ? clientX - rect.left : phX >= 0 && phX <= el.clientWidth ? phX : el.clientWidth / 2;
    const t = (el.scrollLeft + anchorX - PAD) / cur;
    const next = zoomStep(cur, dir);
    setZoom(next);
    requestAnimationFrame(() => {
      el.scrollLeft = scrollForZoom(t, anchorX - PAD, next);
    });
  };
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;

  // ⌘/ctrl + wheel zooms around the pointer; a plain vertical wheel scrolls sideways
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomRef.current(e.deltaY < 0 ? 1 : -1, e.clientX);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // + / − zoom from anywhere outside a text field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomRef.current(1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomRef.current(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // playhead: moved in the DOM on every tick; the view follows it while playing
  useEffect(() => {
    const update = () => {
      const snap = transport.getSnapshot();
      const px = PAD + snap.time * ppsRef.current;
      if (playhead.current) playhead.current.style.transform = `translateX(${px}px)`;
      const el = scroller.current;
      if (el && snap.playing && (px > el.scrollLeft + el.clientWidth - 40 || px < el.scrollLeft)) el.scrollLeft = px - 60;
    };
    update();
    return transport.subscribe(update);
  }, [transport, pps]);

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    return Math.min(duration, Math.max(0, (clientX - rect.left + el.scrollLeft - PAD) / ppsRef.current));
  };
  const scrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    transport.pause();
    transport.seek(snapToFrame(timeAt(e.clientX), fps));
    const move = (ev: PointerEvent) => transport.seek(snapToFrame(timeAt(ev.clientX), fps));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const visible = useMemo(() => {
    const from = Math.max(0, (scrollX - PAD) / pps - 2);
    const to = (scrollX + viewW) / pps + 2;
    return { from, to };
  }, [scrollX, viewW, pps]);
  const ticks = useMemo(() => rulerTicks(pps, visible.from, Math.min(duration, visible.to)), [pps, visible, duration]);
  const clipIndex = useMemo(() => new Map((edit?.clipOrder ?? []).map((c, i) => [c, i])), [edit?.clipOrder]);

  if (!tl || !edit) {
    return <p className="meta px-4 py-6">The timeline appears once there's an edit.</p>;
  }

  const selectedOverlay = state.selection?.kind === "overlay" ? state.selection.id : null;
  const selectedCut = state.selection?.kind === "cut" ? state.selection.id : null;

  // ---------- graphics drag ----------
  const startDrag = (e: ReactPointerEvent, p: Placement, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const ov = edit.overlays.find((o) => o.id === p.overlayId);
    select({ kind: "overlay", id: p.overlayId });
    setDrag({ id: p.overlayId, mode, x0: e.clientX, start: p.start, end: p.end, offsetMs: ov?.offsetMs ?? 0, dt: 0, moved: false });
  };
  const moveDrag = (e: ReactPointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    let dt = snapToFrame(dx / pps, fps);
    if (drag.mode === "move") dt = Math.min(Math.max(dt, -drag.start), duration - drag.end);
    else dt = Math.max(dt, 0.5 - (drag.end - drag.start));
    setDrag({ ...drag, dt, moved: drag.moved || Math.abs(dx) > 2 });
  };
  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved || d.dt === 0) return;
    if (d.mode === "move") apply((e) => nudgeOverlay(e, d.id, d.offsetMs + d.dt * 1000, fps));
    else apply((e) => setOverlayDuration(e, d.id, (d.end + d.dt - d.start) * 1000, fps));
  };
  const keyNudge = (e: ReactKeyboardEvent, p: Placement) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const frames = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1);
    const ov = edit.overlays.find((o) => o.id === p.overlayId);
    if (!ov) return;
    if (e.altKey) {
      const cur = ov.durMs ?? (p.end - p.start) * 1000;
      apply((ed) => setOverlayDuration(ed, ov.id, cur + (frames * 1000) / fps, fps), `dur:${ov.id}`);
    } else apply((ed) => nudgeOverlay(ed, ov.id, (ov.offsetMs ?? 0) + (frames * 1000) / fps, fps), `nudge:${ov.id}`);
  };

  return (
    <section aria-label="Timeline" className="flex flex-col">
      <div className="flex h-8 items-center gap-1 border-b border-line px-2">
        <h2 className="pane-title mr-2 pl-1">Timeline</h2>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Zoom out" title="Zoom out (−)" disabled={pps <= MIN_PPS} onClick={() => zoomBy(-1)}>
          <Icon name="minus" size={14} />
        </button>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Zoom in" title="Zoom in (+)" disabled={pps >= MAX_PPS} onClick={() => zoomBy(1)}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="btn btn-sm btn-ghost" aria-pressed={zoom === null} onClick={() => setZoom(null)} title="Fit the whole video">
          <Icon name="fit" size={14} />
          Fit
        </button>
        <span className="meta ml-1 tc">{pps >= 10 ? `${Math.round(pps)} px/s` : `${pps.toFixed(1)} px/s`}</span>
        <ul className="ml-auto flex items-center gap-3 pr-1" aria-label="Cut reasons">
          {[...REASONS, "take" as const].map((r) => (
            <li key={r} className="flex items-center gap-1 text-[11px] text-muted">
              <span className="swatch" style={{ ["--rc" as string]: reasonColor(r) }} />
              {REASON_LABEL[r]}
            </li>
          ))}
        </ul>
        <span className="meta ml-3">
          {tl.segments.length} segments, {formatSeconds(duration)}
        </span>
      </div>

      <div className="flex">
        <div className="flex-none border-r border-line text-[11px] text-muted" style={{ width: LABEL_W }} aria-hidden="true">
          <div className="flex items-center px-2" style={{ height: ROW.ruler }}>Time</div>
          <div className="flex items-center px-2" style={{ height: ROW.aroll }}>A-roll</div>
          <div className="flex items-center px-2" style={{ height: ROW.gfx }}>Graphics</div>
          <div className="flex items-center px-2" style={{ height: ROW.chapters }}>Chapters</div>
        </div>
        <div ref={scroller} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}>
          <div className="relative" style={{ width: contentW, height: ROW.ruler + ROW.aroll + ROW.gfx + ROW.chapters }}>
            {/* ruler */}
            <div
              className="absolute inset-x-0 top-0 cursor-ew-resize border-b border-line bg-sunken"
              style={{ height: ROW.ruler }}
              onPointerDown={scrub}
              role="slider"
              aria-label="Seek (output time)"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(transport.time)}
              tabIndex={-1}
            >
              {ticks.minor.map((t) => (
                <span key={`m${t}`} className="absolute bottom-0 h-1.5 w-px bg-line-strong" style={{ left: x(t) }} />
              ))}
              {ticks.major.map((t) => (
                <span key={`M${t}`} className="absolute bottom-0 h-full border-l border-line-strong" style={{ left: x(t) }}>
                  <span className="tc absolute left-1 top-0.5 text-[10.5px] text-muted">{formatTick(t, ticks.step, fps)}</span>
                </span>
              ))}
            </div>

            {/* A-roll */}
            <div className="absolute inset-x-0" style={{ top: ROW.ruler, height: ROW.aroll }} onPointerDown={scrub}>
              {tl.segments.map((s, i) => {
                const ci = clipIndex.get(s.clipId) ?? 0;
                return (
                  <div
                    key={`${s.clipId}-${s.start}`}
                    className="absolute top-[5px] bottom-[5px] rounded-[2px]"
                    style={{
                      left: x(s.outStart),
                      width: Math.max(1, (s.frames / fps) * pps - 1),
                      background: ci % 2 ? "var(--color-clip-b)" : "var(--color-clip-a)",
                      opacity: i % 2 ? 0.82 : 1,
                    }}
                    title={`${s.clipId}: source ${formatSeconds(s.start)} to ${formatSeconds(s.end)}`}
                  />
                );
              })}
              {joins.map((j, i) => {
                const reason = j.reasons[0] ?? "pause";
                const on = j.cutIds.includes(selectedCut ?? "");
                const label = j.clipChange
                  ? "Next clip starts"
                  : `${j.reasons.map((r) => REASON_LABEL[r]).join(" + ")}, ${formatSeconds(j.removed)} removed`;
                return (
                  <button
                    key={i}
                    type="button"
                    tabIndex={-1}
                    aria-label={label}
                    title={label}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      if (j.cutIds[0]) select({ kind: "cut", id: j.cutIds[0] });
                      else if (j.groupIds[0]) select({ kind: "take", id: j.groupIds[0] });
                      transport.seek(j.t);
                    }}
                    className="absolute top-0 h-full w-[9px] -translate-x-1/2"
                    style={{ left: x(j.t) }}
                  >
                    {j.clipChange ? (
                      <span className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-ink-2" />
                    ) : (
                      <span
                        className="absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2"
                        style={{
                          borderLeft: "4.5px solid transparent",
                          borderRight: "4.5px solid transparent",
                          borderTop: `${on ? 9 : 7}px solid ${on ? "var(--color-accent)" : reasonColor(reason)}`,
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* graphics */}
            <div className="absolute inset-x-0 border-t border-line" style={{ top: ROW.ruler + ROW.aroll, height: ROW.gfx }} onPointerDown={scrub}>
              {placements.map((p) => {
                const ov = edit.overlays.find((o) => o.id === p.overlayId);
                if (!ov) return null;
                const d = drag?.id === p.overlayId ? drag : null;
                const start = d && d.mode === "move" ? p.start + d.dt : p.start;
                const end = d ? p.end + d.dt : p.end;
                const g = b.graphics[ov.cueId];
                const sel = selectedOverlay === ov.id;
                const gstate = !g ? "idle" : g.state === "ready" ? (g.stale ? "warn" : "done") : g.state === "error" ? "error" : g.state === "none" ? "idle" : "running";
                return (
                  <div
                    key={p.overlayId}
                    role="button"
                    tabIndex={0}
                    aria-pressed={sel}
                    aria-label={`Graphic ${ov.cueId}${ov.enabled ? "" : " (off)"}, ${formatSeconds(start)} to ${formatSeconds(end)}. Drag to nudge, drag the right edge to change its length; arrow keys nudge by a frame.`}
                    onPointerDown={(e) => startDrag(e, p, "move")}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(e) => keyNudge(e, p)}
                    onFocus={() => select({ kind: "overlay", id: ov.id })}
                    className={`group absolute top-[5px] bottom-[5px] flex min-w-[6px] items-center gap-1.5 overflow-hidden rounded-[4px] px-1.5 text-[11px] ${
                      d ? "cursor-grabbing" : "cursor-grab"
                    } ${ov.enabled ? "bg-[#3b3833] text-ink" : "border border-dashed border-line-strong bg-transparent text-muted"}`}
                    style={{
                      left: x(start),
                      width: Math.max(6, (end - start) * pps),
                      boxShadow: sel ? "0 0 0 2px var(--color-accent)" : "inset 0 0 0 1px rgb(255 255 255 / 0.08)",
                    }}
                  >
                    <span className="dot" data-state={gstate} />
                    <span className="font-semibold">{ov.cueId}</span>
                    <span className="truncate text-ink-2">{ov.brief}</span>
                    {d && (
                      <span className="tc absolute right-2 top-0.5 rounded bg-black/60 px-1 text-[10px] text-ink">
                        {d.mode === "move" ? `${d.dt >= 0 ? "+" : ""}${Math.round(d.dt * fps)}f` : formatSeconds(end - start)}
                      </span>
                    )}
                    <span
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/15"
                      onPointerDown={(e) => startDrag(e, p, "end")}
                      aria-hidden="true"
                    />
                  </div>
                );
              })}
            </div>

            {/* chapters */}
            <div className="absolute inset-x-0 border-t border-line" style={{ top: ROW.ruler + ROW.aroll + ROW.gfx, height: ROW.chapters }}>
              {tl.chapters.map((c) => (
                <button
                  key={`${c.title}-${c.start}`}
                  type="button"
                  tabIndex={-1}
                  className="absolute top-0 flex h-full max-w-[220px] items-center gap-1 border-l-2 border-ink-2 pl-1.5 text-[11px] text-ink-2 hover:text-ink"
                  style={{ left: x(c.start) }}
                  onClick={() => transport.seek(c.start)}
                  aria-label={`Chapter: ${c.title}`}
                >
                  <span className="truncate">{c.title}</span>
                </button>
              ))}
            </div>

            {/* playhead */}
            <div ref={playhead} className="pointer-events-none absolute left-0 top-0 h-full" aria-hidden="true">
              <div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-accent" />
              <div className="absolute left-0 top-0 h-full w-px bg-accent" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
