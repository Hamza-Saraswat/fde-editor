// Edit style for this video: how hard the edit cuts, over the channel defaults in fde-editor.config.json.
// The server re-applies the style to the cuts, so a change here reloads the edit. Cut stats underneath
// help keep the edits consistent from video to video.
import { useState } from "react";
import { useApp } from "../state/app.tsx";
import { useProject } from "../state/ProjectProvider.tsx";
import type { EditStyle } from "../types.ts";
import { Segmented } from "./Segmented.tsx";

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
  const joins = Math.max(0, lens.length - 1);
  const perMin = tl && tl.duration > 0 ? (joins / tl.duration) * 60 : 0;

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
        {style.fillers === "natural" && (
          <Choice label="Cut stalls longer than" value={style.fillerMinMs} options={[250, 300, 400, 500, 700, 1000]} disabled={busy} onChange={(fillerMinMs) => void change({ fillerMinMs })} />
        )}
        <Choice label="Longest pause kept" value={style.maxPauseMs} options={[300, 400, 500, 700, 1000, 1500]} disabled={busy} onChange={(maxPauseMs) => void change({ maxPauseMs })} />
        <Choice label="Avoid slivers shorter than" value={style.minSegmentMs} options={[0, 800, 1200, 2000]} disabled={busy} onChange={(minSegmentMs) => void change({ minSegmentMs })} />
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="flex-1 text-[12.5px] text-ink">Jump cuts</span>
          <Segmented
            label="How cuts inside one take look"
            value={style.jumpCuts}
            onChange={(jumpCuts) => void change({ jumpCuts })}
            options={[
              { value: "soft", label: "Soft", title: `A ${style.softFrames}-frame dissolve across each cut`, disabled: busy },
              { value: "punch-in", label: "Punch-in", title: "Zoom in a little on every other section (camera footage)", disabled: busy },
              { value: "none", label: "Hard", disabled: busy },
            ]}
          />
        </div>
      </div>
      {tl && (
        <p className="meta mt-2 px-2 tc">
          {joins} cuts · {perMin.toFixed(1)} a minute · {lens.filter((l) => l < 1).length} pieces under 1 s
        </p>
      )}
    </section>
  );
}
