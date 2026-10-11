// Compiles Claude's edit plan (plan.json, word ids) into the editable edit (edit.json, time spans).
// Deterministic and forgiving: bad ids are skipped with a warning, gaps in Claude's coverage are
// filled from the aligner, and anything nobody accounted for is cut so stray chatter never ships.
import type {
  Candidates, Clip, Cut, Edit, EditPlan, Overlay, ScriptDoc, TakeGroup, TakeOption, Transcript, Word, WordRange,
} from "./schema.ts";
import { indexWords, wordsInRange, type WordIndex } from "./timeline.ts";

export type CompileContext = {
  script: ScriptDoc;
  transcript: Transcript;
  candidates: Candidates;
  clips: Clip[];
  previous?: Edit | null;
};

export type CompileResult = { edit: Edit; warnings: string[] };

// Silence kept before the first / after the last spoken word of a clip when trimming its head and
// tail. Larger than any padding the timeline adds, so the trim never clips a pre-roll.
const HEAD_TAIL_MARGIN = 0.5;

type Resolved = { clipId: string; words: Word[]; start: number; end: number; startWordId: string; endWordId: string };

export function planToEdit(plan: EditPlan, ctx: CompileContext): CompileResult {
  const { script, transcript, candidates, clips, previous } = ctx;
  const warnings: string[] = [];
  const idx = indexWords(transcript);
  const sentenceOrder = new Map(script.sentences.map((s, i) => [s.id, i]));

  const resolve = (r: WordRange, what: string): Resolved | null => {
    const a = idx.byId.get(r.startWordId);
    const b = idx.byId.get(r.endWordId);
    if (!a || !b) {
      warnings.push(`${what}: unknown word id ${!a ? r.startWordId : r.endWordId}; skipped`);
      return null;
    }
    if (a.word.clipId !== b.word.clipId) {
      warnings.push(`${what}: ${r.startWordId}–${r.endWordId} spans two clips; skipped`);
      return null;
    }
    if (a.i > b.i) warnings.push(`${what}: ${r.startWordId}–${r.endWordId} is reversed; swapped`);
    const words = wordsInRange(idx, r.startWordId, r.endWordId)!;
    const first = words[0]!;
    const last = words.at(-1)!;
    return { clipId: first.clipId, words, start: first.start, end: last.end, startWordId: first.id, endWordId: last.id };
  };
  const toOption = (r: Resolved): TakeOption => ({
    startWordId: r.startWordId, endWordId: r.endWordId, clipId: r.clipId, start: r.start, end: r.end,
  });
  const overlaps = (a: { clipId: string; start: number; end: number }, b: { clipId: string; start: number; end: number }) =>
    a.clipId === b.clipId && a.start < b.end && a.end > b.start;

  // ---------- take groups ----------

  const groups: TakeGroup[] = [];
  plan.takes.forEach((t, i) => {
    const label = `take ${i + 1} (${t.sentenceIds.join(", ")})`;
    for (const sid of t.sentenceIds) if (!sentenceOrder.has(sid)) warnings.push(`${label}: unknown sentence id ${sid}`);
    const chosen = resolve(t.chosen, `${label} chosen`);
    if (!chosen) return;
    const options = [toOption(chosen)];
    t.alternates.forEach((alt, j) => {
      const r = resolve(alt, `${label} alternate ${j + 1}`);
      if (!r) return;
      if (options.some((o) => overlaps(o, r))) {
        warnings.push(`${label}: alternate ${r.startWordId}–${r.endWordId} overlaps another option; dropped`);
        return;
      }
      options.push(toOption(r));
    });
    groups.push({ id: "", sentenceIds: t.sentenceIds, options, chosen: 0, why: t.why });
  });

  // Plan ad-lib ranges count as "seen by Claude" for coverage.
  const adlibs = plan.adlibs
    .map((a, i) => ({ a, r: resolve(a, `ad-lib ${i + 1}`) }))
    .filter((x): x is { a: EditPlan["adlibs"][number]; r: Resolved } => x.r !== null);

  // Aligner occurrences Claude left out: a retake of a planned sentence becomes an alternate; a
  // sentence Claude never planned gets its own group with the aligner's pick, so nothing plays twice.
  const claimed = () => [...groups.flatMap((g) => g.options), ...adlibs.map((x) => x.r)];
  for (const cs of candidates.sentences) {
    const loose: { r: Resolved; j: number }[] = [];
    cs.occurrences.forEach((occ, j) => {
      const r = resolve(occ, `aligner occurrence of ${cs.sentenceId}`);
      if (!r || claimed().some((c) => overlaps(c, r))) return;
      const g = groups.find((g) => g.sentenceIds.includes(cs.sentenceId));
      if (g) {
        g.options.push(toOption(r));
        warnings.push(`retake of ${cs.sentenceId} at ${r.startWordId}–${r.endWordId} was not in the plan; added as an alternate take`);
      } else {
        loose.push({ r, j });
      }
    });
    if (!loose.length) continue;
    const pick = loose.find((x) => x.j === cs.chosen) ?? loose.reduce((best, x) =>
      (cs.occurrences[x.j]!.score > cs.occurrences[best.j]!.score ? x : best));
    groups.push({
      id: "",
      sentenceIds: [cs.sentenceId],
      options: [pick, ...loose.filter((x) => x !== pick)].map((x) => toOption(x.r)),
      chosen: 0,
      why: "Aligner's pick; Claude's plan did not cover this sentence.",
    });
    warnings.push(`sentence ${cs.sentenceId} was not in the plan; using the aligner's take ${pick.r.startWordId}–${pick.r.endWordId}`);
  }

  const groupPos = (g: TakeGroup) => Math.min(...g.sentenceIds.map((s) => sentenceOrder.get(s) ?? Infinity));
  groups.sort((a, b) => groupPos(a) - groupPos(b));
  groups.forEach((g, i) => (g.id = `tg${i + 1}`));

  // ---------- clip order: by where each clip's chosen takes sit in the script ----------

  const clipIds = [...clips.map((c) => c.id)];
  for (const clipId of idx.byClip.keys()) {
    if (!clipIds.includes(clipId)) {
      clipIds.push(clipId);
      warnings.push(`clip ${clipId} is in the transcript but not in the project`);
    }
  }
  const span = new Map<string, { lo: number; hi: number }>();
  for (const g of groups) {
    const opt = g.options[g.chosen]!;
    const pos = groupPos(g);
    if (!Number.isFinite(pos)) continue;
    const s = span.get(opt.clipId) ?? { lo: Infinity, hi: -Infinity };
    span.set(opt.clipId, { lo: Math.min(s.lo, pos), hi: Math.max(s.hi, pos) });
  }
  const clipOrder = [
    ...clipIds.filter((c) => span.has(c)).sort((a, b) => span.get(a)!.lo - span.get(b)!.lo),
    ...clipIds.filter((c) => !span.has(c)),
  ];
  for (let i = 1; i < clipOrder.length; i++) {
    const a = span.get(clipOrder[i - 1]!);
    const b = span.get(clipOrder[i]!);
    if (a && b && a.hi > b.lo) {
      warnings.push(`takes in ${clipOrder[i - 1]} and ${clipOrder[i]} interleave in script order; clips play whole, one after the other`);
    }
  }

  // ---------- cuts ----------

  const carried = (previous?.cuts ?? []).filter((c) => c.by === "user");
  const usedIds = new Set(carried.map((c) => c.id));
  let n = 0;
  const nextId = () => {
    let id: string;
    do id = `k${++n}`;
    while (usedIds.has(id));
    return id;
  };
  const cuts: Cut[] = [];
  const addCut = (c: Omit<Cut, "id">) => {
    const cut: Cut = { id: nextId(), ...c };
    if (cut.note === undefined) delete cut.note;
    cuts.push(cut);
    return cut;
  };

  const wordCutIds = new Set<string>(); // words Claude cut explicitly
  plan.wordCuts.forEach((wc, i) => {
    const r = resolve(wc, `word cut ${i + 1}`);
    if (!r) return;
    r.words.forEach((w) => wordCutIds.add(w.id));
    addCut({ clipId: r.clipId, start: r.start, end: r.end, reason: wc.reason, by: "claude", enabled: true });
  });

  for (const { a, r } of adlibs) {
    addCut({ clipId: r.clipId, start: r.start, end: r.end, reason: "adlib", by: "claude", enabled: !a.keep, note: a.why });
  }

  const fillers = new Map(transcript.fillers.map((f) => [f.id, f]));
  const decided = new Set<string>();
  for (const fg of plan.fillerGaps) {
    const f = fillers.get(fg.fillerId);
    if (!f) {
      warnings.push(`filler ${fg.fillerId}: unknown id; skipped`);
      continue;
    }
    if (decided.has(f.id)) continue;
    decided.add(f.id);
    addCut({ clipId: f.clipId, start: f.start, end: f.end, reason: "filler", by: "claude", enabled: fg.cut });
    if (fg.cut && f.wordId) wordCutIds.add(f.wordId);
  }

  // Head and tail of every clip: everything before the first / after the last word anyone accounted for.
  const covered = new Set<string>();
  for (const g of groups) for (const o of g.options) wordsInRange(idx, o.startWordId, o.endWordId)?.forEach((w) => covered.add(w.id));
  for (const { r } of adlibs) r.words.forEach((w) => covered.add(w.id));

  const trims: Cut[] = [];
  const bounds = new Map<string, { first: number; last: number }>();
  for (const clipId of clipOrder) {
    const words = idx.byClip.get(clipId) ?? [];
    const duration = clips.find((c) => c.id === clipId)?.duration ?? words.at(-1)?.end ?? 0;
    const coveredIdx = words.flatMap((w, i) => (covered.has(w.id) ? [i] : []));
    if (!coveredIdx.length) {
      if (duration > 0) {
        trims.push(addCut({ clipId, start: 0, end: duration, reason: words.length ? "repeat" : "silence", by: "auto", enabled: true, note: "nothing from the script in this clip" }));
        if (words.length) warnings.push(`clip ${clipId} has no script lines or ad-libs in the plan; cut entirely`);
      }
      continue;
    }
    const first = coveredIdx[0]!;
    const last = coveredIdx.at(-1)!;
    bounds.set(clipId, { first, last });
    const head = words.slice(0, first);
    const firstStart = words[first]!.start;
    if (head.length) {
      trims.push(addCut({ clipId, start: 0, end: Math.min(head.at(-1)!.end, firstStart), reason: "repeat", by: "auto", enabled: true, note: `before the first take: "${snippet(head)}"` }));
    } else if (firstStart > HEAD_TAIL_MARGIN) {
      trims.push(addCut({ clipId, start: 0, end: firstStart - HEAD_TAIL_MARGIN, reason: "silence", by: "auto", enabled: true }));
    }
    const tail = words.slice(last + 1);
    const lastEnd = words[last]!.end;
    if (tail.length) {
      trims.push(addCut({ clipId, start: Math.max(tail[0]!.start, lastEnd), end: Math.max(duration, tail.at(-1)!.end), reason: "repeat", by: "auto", enabled: true, note: `after the last take: "${snippet(tail)}"` }));
    } else if (duration - lastEnd > HEAD_TAIL_MARGIN) {
      trims.push(addCut({ clipId, start: lastEnd + HEAD_TAIL_MARGIN, end: duration, reason: "silence", by: "auto", enabled: true }));
    }
  }
  const inTrim = (clipId: string, start: number, end: number) =>
    trims.some((t) => t.clipId === clipId && start >= t.start && end <= t.end);

  // Filler candidates Claude did not decide: Whisper's "um" tokens are cut; voiced gaps are offered, off.
  for (const f of transcript.fillers) {
    if (decided.has(f.id) || inTrim(f.clipId, f.start, f.end)) continue;
    if (f.kind === "token") {
      if (f.wordId && wordCutIds.has(f.wordId)) continue;
      addCut({ clipId: f.clipId, start: f.start, end: f.end, reason: "filler", by: "auto", enabled: true });
      if (f.wordId) wordCutIds.add(f.wordId);
    } else {
      addCut({ clipId: f.clipId, start: f.start, end: f.end, reason: "filler", by: "auto", enabled: false });
    }
  }

  // Runs of ≥ 2 words between takes that nobody accounted for ("okay, let me start again").
  let strays = 0;
  for (const clipId of clipOrder) {
    const b = bounds.get(clipId);
    if (!b) continue;
    const words = idx.byClip.get(clipId)!;
    let run: Word[] = [];
    const flush = () => {
      if (run.length >= 2) {
        addCut({ clipId, start: run[0]!.start, end: run.at(-1)!.end, reason: "repeat", by: "auto", enabled: true, note: `not in any take or ad-lib: "${snippet(run)}"` });
        strays++;
      }
      run = [];
    };
    for (let i = b.first; i <= b.last; i++) {
      const w = words[i]!;
      if (covered.has(w.id)) flush();
      else if (!wordCutIds.has(w.id)) run.push(w); // cut fillers inside a run don't break it
    }
    flush();
  }
  if (strays) warnings.push(`${strays} stretch${strays === 1 ? "" : "es"} of speech outside every take and ad-lib cut automatically`);

  cuts.push(...carried);

  // ---------- overlays ----------

  const cueIds = new Set(script.cues.map((c) => c.id));
  const seenCues = new Set<string>();
  const overlays: Overlay[] = [];
  for (const c of plan.cues) {
    if (seenCues.has(c.cueId)) {
      warnings.push(`cue ${c.cueId}: listed twice; kept the first`);
      continue;
    }
    seenCues.add(c.cueId);
    if (!cueIds.has(c.cueId)) {
      warnings.push(`cue ${c.cueId}: not in the script; skipped`);
      continue;
    }
    if (!c.include) continue;
    let anchor = idx.byId.get(c.anchorWordId);
    let end = idx.byId.get(c.endWordId);
    if (!anchor || !end) {
      warnings.push(`cue ${c.cueId}: unknown word id ${!anchor ? c.anchorWordId : c.endWordId}; skipped`);
      continue;
    }
    const pos = (x: { word: Word; i: number }) => [clipOrder.indexOf(x.word.clipId), x.i] as const;
    const [ac, ai] = pos(anchor);
    const [ec, ei] = pos(end);
    if (ec < ac || (ec === ac && ei < ai)) {
      warnings.push(`cue ${c.cueId}: end word comes before the anchor; swapped`);
      [anchor, end] = [end, anchor];
    }
    const prev = previous?.overlays.find((o) => o.cueId === c.cueId);
    const ov: Overlay = {
      id: `o-${c.cueId}`,
      cueId: c.cueId,
      enabled: prev?.enabled ?? true,
      anchorWordId: anchor.word.id,
      endWordId: end.word.id,
      offsetMs: prev?.offsetMs ?? 0,
      layout: c.layout,
      brief: c.brief,
      assetIds: prev?.assetIds ?? [],
    };
    if (prev?.durMs !== undefined) ov.durMs = prev.durMs;
    // A side the user flipped in the UI wins over Claude's pick on a re-plan.
    const side = prev?.side ?? c.side;
    if (side) ov.side = side;
    overlays.push(ov);
  }
  for (const cue of script.cues) {
    if (cue.optional) continue;
    const decision = plan.cues.find((c) => c.cueId === cue.id);
    if (!decision) warnings.push(`cue ${cue.id} (${cue.kind}) is not in the plan`);
    else if (!decision.include) warnings.push(`cue ${cue.id} (${cue.kind}) is required but Claude left it out`);
  }

  // ---------- chapters: one per ## section, at the first spoken sentence ----------

  const spokenStart = (sid: string): string | null => {
    const g = groups.find((g) => g.sentenceIds.includes(sid));
    if (g) {
      const opt = g.options[g.chosen]!;
      if (groupPos(g) === sentenceOrder.get(sid)) return opt.startWordId;
      const cs = candidates.sentences.find((c) => c.sentenceId === sid);
      for (const occ of cs?.occurrences ?? []) {
        const r = wordsInRange(idx, occ.startWordId, occ.endWordId);
        if (r?.length && overlaps(opt, { clipId: occ.clipId, start: r[0]!.start, end: r.at(-1)!.end })) return r[0]!.id;
      }
      return null;
    }
    const cs = candidates.sentences.find((c) => c.sentenceId === sid);
    const occ = cs && cs.chosen !== null ? cs.occurrences[cs.chosen] : undefined;
    return occ && idx.byId.has(occ.startWordId) ? occ.startWordId : null;
  };

  const chapters: Edit["chapters"] = [];
  script.sections.forEach((sec, i) => {
    if (sec.level !== 2) return;
    const sids = [...sec.sentenceIds];
    for (let j = i + 1; j < script.sections.length && script.sections[j]!.level > 2; j++) sids.push(...script.sections[j]!.sentenceIds);
    sids.sort((a, b) => (sentenceOrder.get(a) ?? Infinity) - (sentenceOrder.get(b) ?? Infinity));
    for (const sid of new Set(sids)) {
      const anchorWordId = spokenStart(sid);
      if (anchorWordId) {
        chapters.push({ title: chapterTitle(sec.title), anchorWordId });
        return;
      }
    }
  });

  const edit: Edit = {
    version: (previous?.version ?? 0) + 1,
    clipOrder,
    cuts,
    takeGroups: groups,
    overlays,
    chapters,
    intro: previous?.intro ?? true,
    outro: previous?.outro ?? true,
  };
  return { edit, warnings };
}

function snippet(words: Word[], max = 60): string {
  const s = words.map((w) => w.text.trim()).join(" ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "Cold open (0:00–0:40)" → "Cold open": drop the script's planning timecodes. */
export function chapterTitle(title: string): string {
  return title.replace(/\s*\(\s*~?\d{1,2}:\d{2}\s*[–—-]\s*~?\d{1,2}:\d{2}\s*\)\s*$/, "").trim() || title;
}

