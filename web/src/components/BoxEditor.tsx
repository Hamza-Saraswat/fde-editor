// Draw one crop rect, any number of blur and highlight rects, on a screenshot. Rects are 0–1 of the image.
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { Asset, PatchAssetBody, Rect } from "../types.ts";
import { Segmented } from "./Segmented.tsx";

type Mode = "crop" | "blur" | "highlight";
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const pos = (r: Rect): CSSProperties => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
const round = (r: Rect): Rect => ({ x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) });

const STYLE: Record<Mode, CSSProperties> = {
  crop: { border: "2px dashed #ffffff", boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.55)" },
  blur: { border: "1.5px solid var(--color-run)", backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)", background: "rgb(127 169 214 / 0.12)" },
  highlight: { border: "2px solid var(--color-warn)", background: "rgb(217 178 92 / 0.2)" },
};
const NAME: Record<Mode, string> = { crop: "Crop", blur: "Blur", highlight: "Highlight" };

export function BoxEditor({ asset, src, onPatch }: { asset: Asset; src: string; onPatch: (body: PatchAssetBody) => void }) {
  const [mode, setMode] = useState<Mode>("crop");
  const [draft, setDraft] = useState<Rect | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const ratio = asset.width && asset.height ? asset.width / asset.height : 4 / 3;

  const pt = (e: { clientX: number; clientY: number }) => {
    const r = area.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = pt(e);
    setDraft({ ...start.current, w: 0, h: 0 });
  };
  const move = (e: ReactPointerEvent) => {
    const s = start.current;
    if (!s) return;
    const p = pt(e);
    setDraft({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const up = () => {
    const r = draft;
    start.current = null;
    setDraft(null);
    if (!r || r.w < 0.01 || r.h < 0.01) return;
    const rect = round(r);
    if (mode === "crop") onPatch({ crop: rect });
    else if (mode === "blur") onPatch({ blur: [...asset.blur, rect] });
    else onPatch({ highlight: [...asset.highlight, rect] });
  };
  const remove = (kind: Mode, i: number) => {
    if (kind === "crop") onPatch({ crop: null });
    else if (kind === "blur") onPatch({ blur: asset.blur.filter((_, j) => j !== i) });
    else onPatch({ highlight: asset.highlight.filter((_, j) => j !== i) });
  };

  const rects: { kind: Mode; r: Rect; i: number }[] = [
    ...asset.blur.map((r, i) => ({ kind: "blur" as const, r, i })),
    ...asset.highlight.map((r, i) => ({ kind: "highlight" as const, r, i })),
    ...(asset.crop ? [{ kind: "crop" as const, r: asset.crop, i: 0 }] : []),
  ];

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Segmented<Mode>
          label="Box to draw"
          value={mode}
          onChange={setMode}
          options={[
            { value: "crop", label: "Crop", title: "Keep only this area (one box)" },
            { value: "blur", label: "Blur", title: "Blur names and identifying details" },
            { value: "highlight", label: "Highlight", title: "Mark what you talk about" },
          ]}
        />
        <span className="meta">Drag on the image</span>
      </div>
      <div className="mx-auto w-full" style={{ maxWidth: `calc(340px * ${ratio})` }}>
        <div
          ref={area}
          className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded border border-line bg-sunken"
          style={{ aspectRatio: String(ratio) }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => {
            start.current = null;
            setDraft(null);
          }}
          role="application"
          aria-label={`${asset.name}. Drag to draw a ${NAME[mode].toLowerCase()} box.`}
        >
          <img src={src} alt={asset.name} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" />
          {rects.map(({ kind, r, i }) => (
            <div key={`${kind}${i}`} className="pointer-events-none absolute" style={{ ...pos(r), ...STYLE[kind] }}>
              <button
                type="button"
                className="pointer-events-auto absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/80 text-[10px] leading-none text-white ring-1 ring-white/40 hover:bg-bad"
                aria-label={`Remove ${NAME[kind].toLowerCase()} box${kind === "crop" ? "" : ` ${i + 1}`}`}
                title={`Remove this ${NAME[kind].toLowerCase()} box`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => remove(kind, i)}
              >
                ×
              </button>
            </div>
          ))}
          {draft && <div className="pointer-events-none absolute" style={{ ...pos(draft), ...STYLE[mode], boxShadow: mode === "crop" ? STYLE.crop.boxShadow : undefined }} />}
        </div>
      </div>
      <p className="meta">
        {asset.crop ? "Cropped" : "No crop"}, {asset.blur.length} blur{asset.blur.length === 1 ? "" : "s"}, {asset.highlight.length} highlight{asset.highlight.length === 1 ? "" : "s"}.
        {mode === "crop" && asset.crop ? " Drawing a new crop replaces the old one." : ""}
      </p>
    </div>
  );
}
