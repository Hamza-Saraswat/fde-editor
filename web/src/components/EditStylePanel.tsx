// Edit style for this video: how hard the edit cuts, over the channel defaults in fde-editor.config.json.
// The server re-applies the style to the cuts, so a change here reloads the edit. Cut stats underneath
// help keep the edits consistent from video to video.
import { useState } from "react";
import { useApp } from "../state/app.tsx";
import { useProject } from "../state/ProjectProvider.tsx";
import type { EditStyle } from "../types.ts";
import { Segmented } from "./Segmented.tsx";
import { ClipFixes } from "./ClipFixes.tsx";

type Resolved = Required<Omit<EditStyle, "maxPauseMs">> & { maxPauseMs: number };

const MS = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s` : `${v} ms`);

function Choice({ label, value, options, onChange, disabled }: { label: string; value: number; options: number[]; onChange: (v: number) => void; disabled: boolean }) {
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <label className="flex items-center gap-2 px-2 py-1">
      <span className="flex-1 text-[12.5px] text-ink">{label}</span>
      <select className="field h-7" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {all.map((v) => (
          <option key={v} value={v}>
            {v === 0 ? "off" : MS(v)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function EditStylePanel() {
  const { config } = useApp();
  const { state, edit, setStyle } = useProject();
  const [busy, setBusy] = useState(false);
  if (!edit || !config) return null;
  const own = edit.style ?? {};
  const style: Resolved = {
    ...config.edit.style,
    maxPauseMs: config.edit.maxPauseMs,
    ...Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined)),
    ...(edit.punchIn && !own.jumpCuts ? { jumpCuts: "punch-in" as const } : {}),
  } as Resolved;
  const change = async (patch: Partial<EditStyle>) => {
    setBusy(true);
    try {
      await setStyle(patch);
    } finally {
      setBusy(false);
    }
  };

  const tl = state.bundle?.timeline;
  const lens = tl ? tl.segments.map((s) => s.frames / tl.fps) : [];
  const judged = edit.cuts.filter((c) => c.enabled && c.join);
  const inPause = judged.filter((c) => c.join!.quietBefore || c.join!.quietAfter).length;
  const joins = Math.max(0, lens.length - 1);
  const perMin = tl && tl.duration > 0 ? (joins / tl.duration) * 60 : 0;
  // joins inside one take where no cut removed anything: a long pause was trimmed
  const segs = tl?.segments ?? [];
  const pauseTrims = segs.slice(1).filter((s, i) => {
    const a = segs[i]!;
    return a.clipId === s.clipId && !edit.cuts.some((c) => c.enabled && c.clipId === s.clipId && c.start < s.start && c.end > a.end);
  }).length;
  const framings = segs.slice(1).filter((s, i) => (s.zoom ?? 1) !== (segs[i]!.zoom ?? 1)).length;

  return (
    <section aria-labelledby="ov-style">
      <h3 id="ov-style" className="mb-2 text-[12px] font-semibold text-ink-2">
        Edit style
      </h3>
      <div className="grid gap-1">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="flex-1 text-[12.5px] text-ink">Ums and uhs</span>
          <Segmented
            label="Which fillers to cut"
            value={style.fillers}
            onChange={(fillers) => void change({ fillers })}
            options={[
              { value: "natural", label: "Natural", title: "Keep the short ones of normal speech; cut only stalls", disabled: busy },
              { value: "all", label: "Cut all", disabled: busy },
              { value: "keep", label: "Keep all", disabled: busy },
            ]}
          />
        </div>
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="flex-1 text-[12.5px] text-ink">Stutters</span>
          <Segmented
            label="Which stutters to cut"
            value={style.disfluencies}
            onChange={(disfluencies) => void change({ disfluencies })}
            options={[
              { value: "natural", label: "Natural", title: "Keep a tiny stutter when cutting it would splice inside continuous speech", disabled: busy },
              { value: "clean", label: "Clean", title: "Cut every stutter", disabled: busy },
              { value: "light", label: "Light", title: "Keep stutters; cut only false starts, corrections and asides", disabled: busy },
            ]}
          />
        </div>
        {style.fillers === "natural" && (
          <Choice label="Cut stalls longer than" value={style.fillerMinMs} options={[250, 300, 400, 500, 700, 1000]} disabled={busy} onChange={(fillerMinMs) => void change({ fillerMinMs })} />
        )}
        <Choice label="Trim pauses longer than" value={style.maxPauseMs} options={[700, 1000, 1500, 2000, 3000]} disabled={busy} onChange={(maxPauseMs) => void change({ maxPauseMs })} />
        <Choice label="Trim them down to" value={style.pauseKeepMs} options={[400, 500, 700, 1000]} disabled={busy} onChange={(pauseKeepMs) => void change({ pauseKeepMs })} />
        <Choice label="Keep cuts at least this far apart" value={style.minSegmentMs} options={[0, 1500, 2000, 3000, 4000]} disabled={busy} onChange={(minSegmentMs) => void change({ minSegmentMs })} />
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="flex-1 text-[12.5px] text-ink">Jump cuts</span>
          <Segmented
            label="How cuts inside one take look"
            value={style.jumpCuts}
            onChange={(jumpCuts) => void change({ jumpCuts })}
            options={[
              { value: "punch-in", label: "Punch-in", title: "A cut switches between the normal and a closer framing; each framing holds a few seconds, and cuts under a full-screen cutaway don't switch", disabled: busy },
              { value: "none", label: "Hard", title: "Plain jump cuts", disabled: busy },
              { value: "soft", label: "Dissolve", title: `A ${style.softFrames}-frame dissolve across each cut`, disabled: busy },
            ]}
          />
        </div>
        {style.jumpCuts === "punch-in" && (
          <Choice label="Hold each framing at least" value={style.punchHoldMs} options={[0, 2000, 4000, 6000, 8000]} disabled={busy} onChange={(punchHoldMs) => void change({ punchHoldMs })} />
        )}
      </div>
      <h3 className="mb-1 mt-4 text-[12px] font-semibold text-ink-2">Picture</h3>
      <ul role="list" className="grid gap-1">
        {(state.bundle?.project.clips ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-2 px-2 py-1">
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={c.name}>
              {c.id} <span className="text-muted">{c.name}</span>
            </span>
            <ClipFixes clip={c} />
          </li>
        ))}
      </ul>
      {tl && (
        <p className="meta mt-2 px-2 tc">
          {joins} cuts · {perMin.toFixed(1)} a minute · {pauseTrims} pause trims · {framings} framing changes · {lens.filter((l) => l < style.minSegmentMs / 1000).length} pieces under {MS(style.minSegmentMs)}
          {judged.length ? ` · ${Math.round((100 * inPause) / judged.length)}% land in a pause` : ""}
        </p>
      )}
    </section>
  );
}
