// The script as recorded: each line matched / missing / cut, take pickers on retaken lines,
// ad-libs where they were spoken, and GFX / B-ROLL cue markers that select their graphic.
import { takeNumber } from "../lib/takes.ts";
import { Fragment, useMemo, useState } from "react";
import type { Cue, Sentence, TakeGroup } from "../types.ts";
import { useDerived, useProject } from "../state/ProjectProvider.tsx";
import { useSeek } from "../state/useSeek.ts";
import { optionWords, wordsBetween, wordsText } from "../lib/words.ts";
import { TakeChip, TakeOptions } from "./TakePicker.tsx";

type Adlib = { clipId: string; startWordId: string; endWordId: string };

export function ScriptPane() {
  const { state, edit, select } = useProject();
  const { idx, statuses } = useDerived();
  const { seekWord } = useSeek();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const b = state.bundle!;
  const script = b.script;
  const cands = b.candidates;

  const model = useMemo(() => {
    if (!script || !edit) return null;
    const sentences = new Map(script.sentences.map((s) => [s.id, s]));
    const groupOf = new Map<string, TakeGroup>();
    for (const g of edit.takeGroups) for (const sid of g.sentenceIds) groupOf.set(sid, g);
    const cuesAfter = new Map<string, Cue[]>();
    for (const c of script.cues) {
      const key = c.afterSentenceId ?? `^${c.sectionId}`;
      cuesAfter.set(key, [...(cuesAfter.get(key) ?? []), c]);
    }
    const missing = new Set(cands?.missing ?? []);
    // first word of each sentence as spoken (its chosen take), for seeking and placing ad-libs
    const spoken = new Map<string, { first: string; last: string; score?: number }>();
    for (const s of script.sentences) {
      const g = groupOf.get(s.id);
      const opt = g?.options[g.chosen];
      if (opt) spoken.set(s.id, { first: opt.startWordId, last: opt.endWordId });
      const cs = cands?.sentences.find((c) => c.sentenceId === s.id);
      const occ = cs && cs.chosen !== null ? cs.occurrences[cs.chosen] : undefined;
      if (occ) spoken.set(s.id, { first: spoken.get(s.id)?.first ?? occ.startWordId, last: spoken.get(s.id)?.last ?? occ.endWordId, score: occ.score });
    }
    // each ad-lib goes after the last line spoken before it
    const adlibsAfter = new Map<string, Adlib[]>();
    if (idx) {
      for (const a of cands?.adlibs ?? []) {
        const pos = idx.pos.get(a.startWordId) ?? -1;
        let best: string | null = null;
        let bestPos = -1;
        for (const [sid, sp] of spoken) {
          const p = idx.pos.get(sp.last) ?? -1;
          if (p < pos && p > bestPos) {
            bestPos = p;
            best = sid;
          }
        }
        const key = best ?? "^start";
        adlibsAfter.set(key, [...(adlibsAfter.get(key) ?? []), a]);
      }
    }
    return { sentences, groupOf, cuesAfter, missing, spoken, adlibsAfter };
  }, [script, edit, cands, idx]);

  if (!script || !model || !edit) return <EmptyPane title="Script" text="The script appears after Import." />;

  const overlayFor = (cueId: string) => edit.overlays.find((o) => o.cueId === cueId);
  const selectedCue =
    state.selection?.kind === "overlay" ? edit.overlays.find((o) => o.id === (state.selection as { id: string }).id)?.cueId : state.selection?.kind === "cue" ? state.selection.cueId : null;

  const sentenceState = (s: Sentence): "missing" | "cut" | "matched" => {
    if (model.missing.has(s.id) || !model.spoken.has(s.id)) return "missing";
    const sp = model.spoken.get(s.id)!;
    const g = model.groupOf.get(s.id);
    const words = idx ? (g ? optionWords(idx, g.options[g.chosen]!) : wordsBetween(idx, sp.first, sp.last)) : [];
    if (words.length && words.every((w) => statuses.get(w.id)?.kind === "cut")) return "cut";
    return "matched";
  };

  const cueMarkers = (key: string) =>
    (model.cuesAfter.get(key) ?? []).map((c) => {
      const ov = overlayFor(c.id);
      const g = b.graphics[c.id];
      const on = selectedCue === c.id;
      return (
        <button
          key={c.id}
          type="button"
          onClick={() => select(ov ? { kind: "overlay", id: ov.id } : { kind: "cue", cueId: c.id })}
          aria-pressed={on}
          aria-label={`${c.kind === "gfx" ? "Graphic" : "B-roll"} cue ${c.id}: ${c.text}${ov ? (ov.enabled ? "" : " (off)") : " (not placed)"}`}
          className={`my-1.5 flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left font-sans text-[12px] ${
            on ? "border-accent bg-accent-soft" : "border-line bg-sunken hover:border-line-strong"
          } ${!ov || !ov.enabled ? "opacity-60" : ""}`}
        >
          <span className={`flex-none rounded px-1 text-[10.5px] font-semibold ${c.kind === "gfx" ? "bg-[#33405a] text-[#c6d6f2]" : "bg-[#4a3a2a] text-[#efd4b0]"}`}>
            {c.kind === "gfx" ? "GFX" : "B-ROLL"}
          </span>
          <span className="tc flex-none text-[11px] text-muted">{c.id}</span>
          <span className="line-clamp-2 min-w-0 flex-1 text-ink-2">{c.text}</span>
          {c.optional && <span className="meta flex-none">optional</span>}
          {g && <span className="dot mt-1" data-state={g.state === "ready" ? (g.stale ? "warn" : "done") : g.state === "error" ? "error" : g.state === "none" ? "idle" : "running"} title={`Graphic: ${g.state}`} />}
        </button>
      );
    });

  const adlibRows = (key: string) =>
    (model.adlibsAfter.get(key) ?? []).map((a) => {
      const words = idx ? wordsBetween(idx, a.startWordId, a.endWordId) : [];
      const st = statuses.get(a.startWordId);
      const cut = st?.kind === "cut";
      return (
        <p key={a.startWordId} className="my-1 flex items-baseline gap-2 pl-3">
          <span className="flex-none rounded px-1 font-sans text-[10.5px] font-medium" style={{ color: "var(--color-r-adlib)", border: "1px solid color-mix(in srgb, var(--color-r-adlib) 50%, transparent)" }}>
            Ad-lib
          </span>
          <button
            type="button"
            className={`text-left text-[13.5px] italic ${cut ? "text-faint line-through" : "text-ink-2"} hover:text-ink`}
            onClick={() => {
              if (st && (st.kind === "cut" || st.kind === "restored")) select({ kind: "cut", id: st.cutId });
              seekWord(a.startWordId);
            }}
            aria-label={`Ad-lib, ${cut ? "cut" : "kept"}: ${wordsText(words)}`}
          >
            {wordsText(words)}
          </button>
        </p>
      );
    });

  return (
    <section aria-label="Script" className="flex h-full flex-col">
      <header className="flex h-9 flex-none items-center gap-2 border-b border-line px-3">
        <h2 className="pane-title">Script</h2>
        <span className="meta">
          {script.sentences.length - model.missing.size} of {script.sentences.length} lines recorded
        </span>
      </header>
      <div className="manuscript min-h-0 flex-1 overflow-auto px-4 pb-6 pt-2 text-[14.5px] leading-relaxed">
        {adlibRows("^start")}
        {script.sections.map((sec) => (
          <section key={sec.id} aria-labelledby={`h-${sec.id}`}>
            <h3 id={`h-${sec.id}`} className={`font-sans font-semibold text-ink ${sec.level <= 2 ? "mb-1 mt-4 text-[13px]" : "mb-1 mt-3 pl-2 text-[12px] text-ink-2"}`}>
              {sec.title}
            </h3>
            {cueMarkers(`^${sec.id}`)}
            {sec.sentenceIds.map((sid) => {
              const s = model.sentences.get(sid);
              if (!s) return null;
              const st = sentenceState(s);
              const g = model.groupOf.get(sid);
              const multi = g && g.options.length > 1 && g.sentenceIds[0] === sid;
              const sp = model.spoken.get(sid);
              const partial = sp?.score !== undefined && sp.score < 0.75;
              return (
                <Fragment key={sid}>
                  <div className={`group -mx-1.5 flex items-start gap-2 rounded px-1.5 ${state.selection?.kind === "take" && state.selection.id === g?.id ? "bg-raised" : ""}`}>
                    <span
                      className="mt-[9px] h-1.5 w-1.5 flex-none rounded-full"
                      style={{ background: st === "matched" ? "var(--color-ink-2)" : "transparent", boxShadow: st !== "matched" ? "inset 0 0 0 1px var(--color-faint)" : undefined }}
                      aria-hidden="true"
                    />
                    <p className="min-w-0 flex-1">
                      <button
                        type="button"
                        disabled={st === "missing"}
                        onClick={() => sp && seekWord(sp.first)}
                        className={`text-left ${st === "missing" ? "text-faint" : st === "cut" ? "text-faint line-through" : "text-ink hover:text-white"}`}
                        aria-label={`${s.text} (${st === "missing" ? "not recorded" : st === "cut" ? "cut" : "recorded"}${multi ? `, take ${takeNumber(g!, g!.chosen)} of ${g!.options.length}` : ""})`}
                      >
                        {s.text}
                      </button>
                      {st === "missing" && <span className="ml-2 font-sans text-[11px] text-muted">Not recorded</span>}
                      {partial && st !== "missing" && <span className="ml-2 font-sans text-[11px] text-warn" title={`Match score ${Math.round(sp.score! * 100)}%`}>Partial match</span>}
                    </p>
                    {multi && (
                      <span className="mt-1">
                        <TakeChip
                          group={g!}
                          open={openGroup === g!.id}
                          onToggle={() => {
                            const opening = openGroup !== g!.id;
                            setOpenGroup(opening ? g!.id : null);
                            if (opening) select({ kind: "take", id: g!.id });
                          }}
                        />
                      </span>
                    )}
                  </div>
                  {multi && openGroup === g!.id && (
                    <div className="mb-2 ml-3.5 mt-1">
                      <TakeOptions group={g!} />
                    </div>
                  )}
                  {adlibRows(sid)}
                  {cueMarkers(sid)}
                </Fragment>
              );
            })}
          </section>
        ))}
      </div>
    </section>
  );
}

export function EmptyPane({ title, text }: { title: string; text: string }) {
  return (
    <section aria-label={title} className="flex h-full flex-col">
      <header className="flex h-9 flex-none items-center border-b border-line px-3">
        <h2 className="pane-title">{title}</h2>
      </header>
      <p className="meta px-4 py-4">{text}</p>
    </section>
  );
}
