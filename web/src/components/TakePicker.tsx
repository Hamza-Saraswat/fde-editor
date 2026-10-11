// The takes of a retaken line: each option's words, preview, and "Use this take".
import type { TakeGroup } from "../types.ts";
import { useDerived, useProject } from "../state/ProjectProvider.tsx";
import { useSeek } from "../state/useSeek.ts";
import { chooseTake } from "../lib/editOps.ts";
import { optionWords, wordsText } from "../lib/words.ts";
import { formatSeconds } from "../lib/timelineMath.ts";
import { takeNumber, takesInRecordingOrder } from "../lib/takes.ts";
import { Icon } from "./Icon.tsx";

export function TakeChip({ group, open, onToggle }: { group: TakeGroup; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`Take ${takeNumber(group, group.chosen)} of ${group.options.length} in use. ${open ? "Hide" : "Show"} takes`}
      className={`inline-flex h-5 flex-none items-center gap-1 rounded-full border px-2 font-sans text-[11px] ${open ? "border-accent text-ink" : "border-line-strong text-ink-2 hover:text-ink"}`}
    >
      Take {takeNumber(group, group.chosen)} of {group.options.length}
      <Icon name="check" size={11} className="text-ok" />
    </button>
  );
}

export function TakeOptions({ group }: { group: TakeGroup }) {
  const { apply } = useProject();
  const { idx } = useDerived();
  const { previewTake } = useSeek();
  return (
    <ol aria-label={`Takes of ${group.sentenceIds.join(", ")}`} className="grid gap-1.5">
      {takesInRecordingOrder(group).map((i) => {
        const opt = group.options[i]!;
        const chosen = i === group.chosen;
        const text = idx ? wordsText(optionWords(idx, opt)) : "";
        const label = `Take ${takeNumber(group, i)}`;
        return (
          <li key={`${opt.clipId}-${opt.startWordId}`} className={`rounded-md border px-2.5 py-2 ${chosen ? "border-accent/60 bg-accent-soft" : "border-line bg-sunken"}`}>
            <div className="flex items-center gap-2 font-sans">
              <span className="whitespace-nowrap text-[12px] font-semibold text-ink">{label}</span>
              <span className="meta whitespace-nowrap">
                {opt.clipId}, {formatSeconds(opt.end - opt.start)}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => previewTake(opt, chosen, label)} aria-label={`Play ${label}`}>
                  <Icon name="play" size={11} />
                  Play
                </button>
                {chosen ? (
                  <span className="inline-flex items-center gap-1 px-1 text-[12px] text-ink" aria-label={`${label} is in use`}>
                    <Icon name="check" size={13} className="text-ok" />
                    In use
                  </span>
                ) : (
                  <button type="button" className="btn btn-sm" onClick={() => apply((e) => chooseTake(e, group.id, i))}>
                    Use this take
                  </button>
                )}
              </span>
            </div>
            <p className={`mt-1 font-serif text-[13.5px] leading-snug ${chosen ? "text-ink" : "text-ink-2"}`}>{text || "(no words found for this take)"}</p>
          </li>
        );
      })}
    </ol>
  );
}
