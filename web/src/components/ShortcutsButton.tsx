import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";

export const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["J  K  L", "Shuttle back / stop / forward (repeat to speed up)"],
  ["← →", "Step one frame (⇧ for one second)"],
  ["Click a word", "Seek there; click a struck word to restore or re-cut it"],
  ["⇧ Click", "Extend the word selection"],
  ["⌫ / Delete", "Cut the selected words (or delete your own selected cut)"],
  ["Esc", "Clear selection / stop a take preview"],
  ["⌘Z  ⇧⌘Z", "Undo / redo"],
  ["⌘ + scroll, + / −", "Zoom the timeline"],
  ["← → on a graphic", "Nudge it one frame (⇧ for ten)"],
  ["`", "Show or hide the log"],
];

export function ShortcutsButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="btn btn-sm btn-ghost btn-icon"
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
        title="Keyboard shortcuts"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="keyboard" size={15} />
      </button>
      {open && (
        <div role="dialog" aria-label="Keyboard shortcuts" className="absolute right-0 top-9 z-40 w-[360px] rounded-lg border border-line-strong bg-raised p-3 shadow-2xl">
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink">{k}</dt>
                <dd className="text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
