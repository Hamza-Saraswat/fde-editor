// Where Hamza sits in frame (Project.speakerSide), with a tiny diagram of where graphics go.
import type { SpeakerSide } from "../types.ts";
import { Segmented } from "./Segmented.tsx";

const LABEL: Record<SpeakerSide, string> = { left: "Left third", center: "Centered", right: "Right third" };
const HINT: Record<SpeakerSide, string> = {
  left: "Graphics go on the right.",
  center: "Graphics go on either side, or split across both.",
  right: "Graphics go on the left.",
};

export function FramingDiagram({ side, size = 1 }: { side: SpeakerSide; size?: number }) {
  const w = 40 * size;
  const h = 22.5 * size;
  const x = side === "left" ? 9 : side === "right" ? 31 : 20;
  return (
    <svg width={w} height={h} viewBox="0 0 40 22.5" aria-hidden="true" className="flex-none">
      <rect x="0.5" y="0.5" width="39" height="21.5" rx="2" fill="var(--color-sunken)" stroke="var(--color-line-strong)" />
      {side !== "left" && <rect x="2.5" y="4" width={side === "center" ? 9 : 15} height="14" rx="1.5" fill="var(--color-accent)" opacity={side === "center" ? 0.45 : 0.75} />}
      {side !== "right" && <rect x={side === "center" ? 28.5 : 22.5} y="4" width={side === "center" ? 9 : 15} height="14" rx="1.5" fill="var(--color-accent)" opacity={side === "center" ? 0.45 : 0.75} />}
      <circle cx={x} cy="9" r="3" fill="var(--color-ink-2)" />
      <path d={`M${x - 6} 22 q0 -7 6 -7 q6 0 6 7z`} fill="var(--color-ink-2)" />
    </svg>
  );
}

const SHORT: Record<SpeakerSide, string> = { left: "Left", center: "Center", right: "Right" };

export function FramingControl({
  value,
  onChange,
  showHint = false,
  compact = false,
}: {
  value: SpeakerSide;
  onChange: (v: SpeakerSide) => void;
  showHint?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <Segmented
        label="Framing: where you sit in frame"
        value={value}
        onChange={onChange}
        options={(["left", "center", "right"] as const).map((s) => ({
          value: s,
          title: `${LABEL[s]}. ${HINT[s]}`,
          label: (
            <>
              <FramingDiagram side={s} size={0.6} />
              {compact ? SHORT[s] : LABEL[s]}
            </>
          ),
        }))}
      />
      {showHint && <span className="meta">{HINT[value]}</span>}
    </div>
  );
}
