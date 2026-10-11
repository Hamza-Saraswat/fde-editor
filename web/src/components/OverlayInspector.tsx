// Inspector for one placed graphic: script cue, Claude's brief, layout and side, timing, the build,
// and (for B-roll) the screenshot with its crop / blur / highlight boxes.
import { useEffect, useState } from "react";
import type { Layout } from "../types.ts";
import { useDerived, useProject } from "../state/ProjectProvider.tsx";
import { usePlayer } from "../state/player.tsx";
import { nudgeOverlay, resetOverlayTiming, setOverlayDuration, updateOverlay } from "../lib/editOps.ts";
import { overlaySide } from "../lib/placement.ts";
import { formatSeconds, formatTimecode } from "../lib/timelineMath.ts";
import { Field, InspectorHeader } from "./InspectorParts.tsx";
import { Segmented } from "./Segmented.tsx";
import { Switch } from "./Switch.tsx";
import { GraphicStatusPanel } from "./GraphicStatusPanel.tsx";
import { AssetEditor } from "./AssetEditor.tsx";
import { Icon } from "./Icon.tsx";

export function OverlayInspector({ overlayId }: { overlayId: string }) {
  const { state, edit, apply } = useProject();
  const { placements, idx, fps } = useDerived();
  const { transport } = usePlayer();
  const b = state.bundle!;
  const o = edit!.overlays.find((x) => x.id === overlayId)!;
  const cue = b.script?.cues.find((c) => c.id === o.cueId);
  const p = placements.find((x) => x.overlayId === o.id);
  const speakerSide = b.project.speakerSide;
  const side = overlaySide(o, speakerSide);
  const open = speakerSide === "right" ? "left" : "right";
  const word = (id: string) => (idx ? idx.order[idx.pos.get(id) ?? -1]?.text : undefined);
  const frameMs = 1000 / fps;

  return (
    <div>
      <InspectorHeader
        title={
          <>
            <span className={`rounded px-1 text-[10.5px] font-semibold ${cue?.kind === "broll" ? "bg-[#4a3a2a] text-[#efd4b0]" : "bg-[#33405a] text-[#c6d6f2]"}`}>
              {cue?.kind === "broll" ? "B-ROLL" : "GFX"}
            </span>
            {o.cueId}
          </>
        }
      >
        <span className="meta">{o.enabled ? "On" : "Off"}</span>
        <Switch checked={o.enabled} label={o.enabled ? "Turn this graphic off" : "Turn this graphic on"} onChange={(enabled) => apply((e) => updateOverlay(e, o.id, { enabled }))} />
      </InspectorHeader>

      <div className="grid gap-4 p-3">
        {cue && (
          <Field label="Script cue">
            <p className="font-serif text-[13.5px] leading-snug text-ink">{cue.text}</p>
            {cue.flags.map((f) => (
              <p key={f} className="text-[11.5px] text-warn">
                {f}
              </p>
            ))}
          </Field>
        )}

        <Field label="Claude's brief" hint="What the graphics job builds. Changing it marks the graphic out of date.">
          <textarea
            className="field min-h-[96px] w-full font-sans text-[12.5px]"
            value={o.brief}
            onChange={(ev) => {
              const brief = ev.target.value;
              apply((e) => updateOverlay(e, o.id, { brief }), `brief:${o.id}`);
            }}
            aria-label="Brief for the graphic"
          />
        </Field>

        <div className="grid gap-3">
          <Field label="Layout">
            <Segmented<Layout>
              label="Layout"
              value={o.layout}
              onChange={(layout) => apply((e) => updateOverlay(e, o.id, { layout }))}
              options={[
                { value: "side", label: "One side", title: "On one side of the frame" },
                { value: "split", label: "Split", title: "On both sides of a centered speaker" },
                { value: "full", label: "Full frame", title: "Covers the whole frame" },
              ]}
            />
          </Field>
          {o.layout === "side" && (
            <Field
              label="Side"
              hint={speakerSide === "center" ? "You're centered, so pick a side. Flipping it rebuilds the graphic." : `Default is the open side (${open}). Flipping it rebuilds the graphic.`}
            >
              <Segmented<"left" | "right">
                label="Side of the frame"
                value={side}
                onChange={(s) => apply((e) => updateOverlay(e, o.id, { side: s }))}
                options={[
                  { value: "left", label: "Left" },
                  { value: "right", label: "Right" },
                ]}
              />
            </Field>
          )}
        </div>

        <section aria-labelledby={`timing-${o.id}`} className="grid gap-2.5 rounded-md border border-line p-2.5">
          <div className="flex items-center">
            <h3 id={`timing-${o.id}`} className="text-[12px] font-semibold text-ink-2">
              Timing
            </h3>
            <button
              type="button"
              className="btn btn-sm btn-ghost ml-auto"
              disabled={(o.offsetMs ?? 0) === 0 && o.durMs === undefined}
              onClick={() => apply((e) => resetOverlayTiming(e, o.id))}
              title="Back to Claude's placement: no nudge, length follows the words"
            >
              <Icon name="refresh" size={13} />
              Reset timing
            </button>
          </div>
          {p ? (
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <button type="button" className="rounded-md bg-sunken px-2 py-1.5 text-left hover:bg-raised" onClick={() => transport.seek(p.start)} aria-label={`Go to the start, ${formatTimecode(p.start, fps)}`}>
                <span className="meta block">Starts</span>
                <span className="tc text-ink">{formatTimecode(p.start, fps)}</span>
              </button>
              <button type="button" className="rounded-md bg-sunken px-2 py-1.5 text-left hover:bg-raised" onClick={() => transport.seek(Math.max(p.start, p.end - 1 / fps))} aria-label={`Go to the end, ${formatTimecode(p.end, fps)}`}>
                <span className="meta block">Ends</span>
                <span className="tc text-ink">{formatTimecode(p.end, fps)}</span>
              </button>
            </div>
          ) : (
            <p className="meta">Not on the timeline: its words were cut. Move it by editing the cut, or turn it off.</p>
          )}
          <p className="meta">
            Appears as “{word(o.anchorWordId) ?? o.anchorWordId}” starts{o.durMs === undefined ? `, leaves after “${word(o.endWordId) ?? o.endWordId}”` : ""}.
            {p && ` On screen for ${formatSeconds(p.end - p.start)}.`}
            {p?.estimated && " (Unsaved; the server confirms on save.)"}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Nudge (ms)"
              value={o.offsetMs ?? 0}
              step={Math.round(frameMs * 1000) / 1000}
              format={(v) => String(Math.round(v))}
              onCommit={(v) => v !== null && apply((e) => nudgeOverlay(e, o.id, v, fps))}
              hint={`${Math.round((o.offsetMs ?? 0) / frameMs)} frames`}
            />
            <NumberField
              label="Length (s)"
              value={o.durMs !== undefined ? o.durMs / 1000 : null}
              step={Math.round((1 / fps) * 1000) / 1000}
              placeholder={p ? `${(p.end - p.start).toFixed(2)} (words)` : "follows words"}
              format={(v) => v.toFixed(2)}
              onCommit={(v) => apply((e) => setOverlayDuration(e, o.id, v === null ? undefined : v * 1000, fps))}
              hint={o.durMs === undefined ? "Follows the words" : "Fixed. Clear it to follow the words."}
            />
          </div>
        </section>

        <GraphicStatusPanel overlay={o} placement={p ?? null} />

        {cue?.kind === "broll" && <AssetEditor overlay={o} />}
      </div>
    </div>
  );
}

/** Number input that commits on Enter / blur; empty commits null. */
function NumberField({
  label,
  value,
  step,
  onCommit,
  format,
  placeholder,
  hint,
}: {
  label: string;
  value: number | null;
  step: number;
  onCommit: (v: number | null) => void;
  format: (v: number) => string;
  placeholder?: string;
  hint?: string;
}) {
  const shown = value === null ? "" : format(value);
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(shown);
  }, [shown, editing]);
  const commit = () => {
    setEditing(false);
    if (draft === shown) return;
    if (draft.trim() === "") return onCommit(null);
    const n = Number(draft);
    if (Number.isFinite(n)) onCommit(n);
    else setDraft(shown);
  };
  return (
    <label className="grid gap-1">
      <span className="text-[11.5px] font-medium text-muted">{label}</span>
      <input
        type="number"
        className="field tc w-full"
        step={step}
        value={draft}
        placeholder={placeholder}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(shown);
            setEditing(false);
          }
        }}
      />
      {hint && <span className="meta">{hint}</span>}
    </label>
  );
}
