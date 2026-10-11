// Seeking the player to words, takes and source moments through the timeline map.
import { useMemo } from "react";
import type { TakeOption } from "../types.ts";
import { useDerived, useProject } from "./ProjectProvider.tsx";
import { usePlayer } from "./player.tsx";
import { optionWords, wordsText } from "../lib/words.ts";
import type { WordTime } from "../lib/timemap.ts";
import { sourceToOutput } from "../lib/timemap.ts";

export function useSeek() {
  const { state } = useProject();
  const { idx, wordTimes } = useDerived();
  const { transport, playSource } = usePlayer();
  const timeline = state.bundle?.timeline ?? null;
  const byId = useMemo(() => new Map(wordTimes.map((w) => [w.id, w])), [wordTimes]);

  /** Output time of a word, or of the next word that plays when it was cut. */
  const wordTime = (id: string): WordTime | null => {
    const direct = byId.get(id);
    if (direct || !idx) return direct ?? null;
    let p = idx.pos.get(id);
    if (p === undefined) return null;
    for (; p < idx.order.length; p++) {
      const t = byId.get(idx.order[p]!.id);
      if (t) return t;
    }
    return null;
  };

  const seekWord = (id: string, play = false) => {
    const t = wordTime(id);
    if (!t) return false;
    transport.seek(Math.max(0, t.start - 0.05));
    if (play) transport.play();
    return true;
  };

  /** Play a take: in the cut when it's the kept one, else from the source proxy. */
  const previewTake = (opt: TakeOption, kept: boolean, label: string) => {
    const words = idx ? optionWords(idx, opt) : [];
    if (kept) {
      const first = words.find((w) => byId.has(w.id));
      const out = first ? byId.get(first.id)!.start : timeline ? sourceToOutput(timeline, opt.clipId, opt.start) : null;
      if (out !== null) {
        transport.seek(Math.max(0, out - 0.05));
        transport.play();
        return;
      }
    }
    playSource({ clipId: opt.clipId, start: Math.max(0, opt.start - 0.15), end: opt.end + 0.25, label, text: wordsText(words) });
  };

  return { wordTime, seekWord, previewTake };
}
