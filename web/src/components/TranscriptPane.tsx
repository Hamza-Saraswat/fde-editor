// The paper edit: every word in playback order. Cuts are struck through in their reason's colour.
// Click a struck word to restore it (or re-cut it); click kept words to seek, shift-click to extend
// a selection, then ⌫ to cut it. The word being spoken is highlighted and followed while playing.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Cut } from "../types.ts";
import { useDerived, useProject } from "../state/ProjectProvider.tsx";
import { usePlayer } from "../state/player.tsx";
import { useSeek } from "../state/useSeek.ts";
import { addUserCut, toggleCut } from "../lib/editOps.ts";
import { gapFillers, toLines, wordlessCuts, wordsBetween } from "../lib/words.ts";
import { wordAt } from "../lib/timemap.ts";
import { REASON_LABEL, reasonColor } from "../lib/format.ts";
import { formatSeconds } from "../lib/timelineMath.ts";
import { EmptyPane } from "./ScriptPane.tsx";
import { Icon } from "./Icon.tsx";

export function TranscriptPane() {
  const { state, edit, apply, select } = useProject();
  const { idx, statuses, fillerIds, wordTimes } = useDerived();
  const { transport } = usePlayer();
  const { seekWord } = useSeek();
  const [follow, setFollow] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const b = state.bundle!;
  const transcript = b.transcript;
  const sel = state.selection;

  const lines = useMemo(() => (idx ? toLines(idx.order) : []), [idx]);
  const loose = useMemo(() => (idx && edit ? wordlessCuts(idx, edit) : new Map<string, Cut[]>()), [idx, edit]);
  const gaps = useMemo(() => (transcript ? gapFillers(transcript) : new Map()), [transcript]);
  const clipName = (id: string) => b.project.clips.find((c) => c.id === id)?.name ?? id;

  const selRange = useMemo(() => {
    if (sel?.kind !== "words" || !idx) return null;
    const a = idx.pos.get(sel.anchor) ?? 0;
    const f = idx.pos.get(sel.focus) ?? 0;
    return [Math.min(a, f), Math.max(a, f)] as const;
  }, [sel, idx]);
  const selWords = useMemo(() => (sel?.kind === "words" && idx ? wordsBetween(idx, sel.anchor, sel.focus) : []), [sel, idx]);

  // current word: patched straight into the DOM on every playhead tick, no re-render
  const wordTimesRef = useRef(wordTimes);
  wordTimesRef.current = wordTimes;
  const followRef = useRef(follow);
  followRef.current = follow;
  useEffect(() => {
    let current: HTMLElement | null = null;
    let lastId: string | null = null;
    const update = () => {
      const snap = transport.getSnapshot();
      const id = wordAt(wordTimesRef.current, snap.time);
      if (id === lastId) return;
      lastId = id;
      current?.removeAttribute("aria-current");
      current = id ? document.getElementById(`tw-${id}`) : null;
      if (!current) return;
      current.setAttribute("aria-current", "true");
      const box = body.current;
      if (snap.playing && followRef.current && box) {
        const r = current.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        if (r.top < br.top + 40 || r.bottom > br.bottom - 40) {
          const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          box.scrollTo({ top: box.scrollTop + (r.top - br.top) - br.height / 3, behavior: reduce ? "auto" : "smooth" });
        }
      }
    };
    update();
    const unsub = transport.subscribe(update);
    return () => {
      unsub();
      current?.removeAttribute("aria-current");
    };
  }, [transport, lines]);

  if (!transcript || !idx || !edit) return <EmptyPane title="Transcript" text="The words appear here after Transcribe." />;

  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-wid], [data-cut]");
    if (!el) return;
    if (el.dataset.cut) {
      const id = el.dataset.cut;
      apply((ed) => toggleCut(ed, id));
      select({ kind: "cut", id });
      return;
    }
    const id = el.dataset.wid!;
    const st = statuses.get(id);
    if (e.altKey) {
      seekWord(id);
      return;
    }
    if (st?.kind === "cut" || st?.kind === "restored") {
      apply((ed) => toggleCut(ed, st.cutId));
      select({ kind: "cut", id: st.cutId });
      return;
    }
    if (st?.kind === "alt") {
      select({ kind: "take", id: st.groupId });
      return;
    }
    if (e.shiftKey && sel?.kind === "words") {
      select({ kind: "words", anchor: sel.anchor, focus: id });
      return;
    }
    select({ kind: "words", anchor: id, focus: id });
    seekWord(id);
  };

  const focusCut = sel?.kind === "cut" ? sel.id : null;
  const selDur = selWords.length ? selWords.at(-1)!.end - selWords[0]!.start : 0;

  const marker = (c: Cut) => (
    <span
      key={c.id}
      data-cut={c.id}
      role="button"
      tabIndex={-1}
      data-enabled={c.enabled}
      data-focus-cut={focusCut === c.id ? "" : undefined}
      className="gapmark cursor-pointer"
      style={{ ["--rc" as string]: reasonColor(c.reason) }}
      title={`${REASON_LABEL[c.reason]}, ${formatSeconds(c.end - c.start)}. Click to ${c.enabled ? "keep it" : "cut it again"}.`}
      aria-label={`${REASON_LABEL[c.reason]} ${formatSeconds(c.end - c.start)}, ${c.enabled ? "cut" : "kept"}. Toggle.`}
    >
      {c.reason === "silence" ? "pause" : c.reason === "filler" ? "um" : REASON_LABEL[c.reason].toLowerCase()} {formatSeconds(c.end - c.start)}
    </span>
  );

  return (
    <section aria-label="Transcript" className="flex h-full flex-col">
      <header className="flex h-9 flex-none items-center gap-2 border-b border-line px-3">
        <h2 className="pane-title">Transcript</h2>
        <span className="meta truncate">
          {transcript.words.length} words, {transcript.engine}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {selWords.length > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                apply((ed) => addUserCut(ed, selWords));
                select(null);
              }}
              title="Cut the selected words (⌫)"
            >
              <Icon name="scissors" size={13} />
              Cut {selWords.length} word{selWords.length === 1 ? "" : "s"}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-pressed={follow}
            onClick={() => setFollow((f) => !f)}
            title="Scroll with playback"
          >
            <span className={`h-2 w-2 rounded-full ${follow ? "bg-accent" : "border border-line-strong"}`} />
            Follow
          </button>
        </span>
      </header>
      {selWords.length > 0 && (
        <p className="flex-none border-b border-line bg-sunken px-3 py-1 text-[11.5px] text-ink-2" role="status">
          {selWords.length} word{selWords.length === 1 ? "" : "s"} selected ({formatSeconds(selDur)}). Shift-click to extend, ⌫ to cut, Esc to clear.
        </p>
      )}
      <div ref={body} className="manuscript min-h-0 flex-1 overflow-auto px-4 pb-8 pt-2" onClick={onClick} onMouseDown={(e) => e.shiftKey && e.preventDefault()}>
        {(loose.get(`^${lines[0]?.clipId}`) ?? []).map(marker)}
        {lines.map((line, li) => (
          <div key={li}>
            {line.clipStart && (
              <p className="mb-1 mt-3 flex items-center gap-2 font-sans text-[11px] text-muted first:mt-0">
                <Icon name="film" size={12} />
                {line.clipId}: {clipName(line.clipId)}
                {li > 0 && (loose.get(`^${line.clipId}`) ?? []).map(marker)}
              </p>
            )}
            <p className="mb-1.5">
              {line.words.map((w) => {
                const st = statuses.get(w.id);
                const pos = idx.pos.get(w.id) ?? -1;
                const inSel = selRange && pos >= selRange[0] && pos <= selRange[1];
                const rc = st && (st.kind === "cut" || st.kind === "restored") ? reasonColor(st.reason) : undefined;
                const focus = st && (st.kind === "cut" || st.kind === "restored") && st.cutId === focusCut;
                const label =
                  st?.kind === "cut" ? `${w.text} (cut: ${REASON_LABEL[st.reason]})` : st?.kind === "restored" ? `${w.text} (kept; ${REASON_LABEL[st.reason]} cut is off)` : st?.kind === "alt" ? `${w.text} (other take)` : undefined;
                return (
                  <span key={w.id}>
                    <span
                      id={`tw-${w.id}`}
                      data-wid={w.id}
                      data-st={st?.kind ?? "kept"}
                      data-filler={fillerIds.has(w.id) ? "" : undefined}
                      data-sel={inSel ? "" : undefined}
                      data-focus-cut={focus ? "" : undefined}
                      role="button"
                      tabIndex={-1}
                      aria-label={label}
                      className="wd"
                      style={rc ? { ["--rc" as string]: rc } : undefined}
                    >
                      {w.text}
                    </span>
                    {(loose.get(w.id) ?? []).map(marker)}
                    {(gaps.get(w.id) ?? []).length > 0 && !loose.get(w.id)?.length && (
                      <span className="gapmark" style={{ ["--rc" as string]: "var(--color-r-filler)" }} data-enabled="false" title="Voiced gap with no word: probably an um. No cut here.">
                        gap
                      </span>
                    )}{" "}
                  </span>
                );
              })}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
