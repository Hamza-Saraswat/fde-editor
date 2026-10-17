// The right-hand inspector: whatever is selected (graphic, cut, take, words), else an overview.
import { useDerived, useProject } from "../state/ProjectProvider.tsx";
import { usePlayer } from "../state/player.tsx";
import { useSeek } from "../state/useSeek.ts";
import { addUserCut, deleteCut, setCutEnabled, setReasonEnabled } from "../lib/editOps.ts";
import { wordsBetween, wordsText } from "../lib/words.ts";
import { sourceToOutput } from "../lib/timemap.ts";
import { formatSeconds } from "../lib/timelineMath.ts";
import { BY_LABEL, REASON_LABEL, REASONS, reasonColor } from "../lib/format.ts";
import { OverlayInspector } from "./OverlayInspector.tsx";
import { Field, InspectorHeader } from "./InspectorParts.tsx";
import { TakeOptions } from "./TakePicker.tsx";
import { Switch } from "./Switch.tsx";
import { Icon } from "./Icon.tsx";

export function Inspector() {
  const { state, edit } = useProject();
  const sel = state.selection;
  let body = <Overview />;
  if (edit && sel?.kind === "overlay" && edit.overlays.some((o) => o.id === sel.id)) body = <OverlayInspector key={sel.id} overlayId={sel.id} />;
  else if (edit && sel?.kind === "cut" && edit.cuts.some((c) => c.id === sel.id)) body = <CutInspector cutId={sel.id} />;
  else if (edit && sel?.kind === "take" && edit.takeGroups.some((g) => g.id === sel.id)) body = <TakeInspector groupId={sel.id} />;
  else if (sel?.kind === "words") body = <WordsInspector anchor={sel.anchor} focus={sel.focus} />;
  else if (sel?.kind === "cue") body = <CueInspector cueId={sel.cueId} />;
  return <div className="h-full overflow-auto">{body}</div>;
}

function CutInspector({ cutId }: { cutId: string }) {
  const { state, edit, apply, select } = useProject();
  const { idx, joins } = useDerived();
  const { transport } = usePlayer();
  const cut = edit!.cuts.find((c) => c.id === cutId)!;
  const clip = state.bundle!.project.clips.find((c) => c.id === cut.clipId);
  const words = idx ? (idx.byClip.get(cut.clipId) ?? []).filter((w) => (w.start + w.end) / 2 >= cut.start && (w.start + w.end) / 2 <= cut.end) : [];
  const tl = state.bundle!.timeline;
  const at = cut.enabled ? joins.find((j) => j.cutIds.includes(cut.id))?.t : tl ? sourceToOutput(tl, cut.clipId, cut.start) : null;

  return (
    <div>
      <InspectorHeader
        title={
          <>
            <span className="swatch" style={{ ["--rc" as string]: reasonColor(cut.reason) }} />
            {REASON_LABEL[cut.reason]} cut
          </>
        }
      />
      <div className="grid gap-4 p-3">
        <label className="flex items-center justify-between rounded-md bg-sunken px-3 py-2">
          <span>
            <span className="block text-[12.5px] text-ink">{cut.enabled ? "Cut from the video" : "Kept in the video"}</span>
            <span className="meta">Click the struck words in the transcript to toggle too.</span>
          </span>
          <Switch checked={cut.enabled} label={cut.enabled ? "Keep this instead" : "Cut this"} onChange={(v) => apply((e) => setCutEnabled(e, cut.id, v))} />
        </label>
        {words.length > 0 && (
          <Field label="Words">
            <p className={`font-serif text-[14px] ${cut.enabled ? "text-muted line-through" : "text-ink"}`} style={{ textDecorationColor: reasonColor(cut.reason) }}>
              {wordsText(words)}
            </p>
          </Field>
        )}
        <dl className="grid grid-cols-[90px_1fr] gap-y-1.5 text-[12px]">
          <dt className="text-muted">Decided by</dt>
          <dd>{BY_LABEL[cut.by]}</dd>
          <dt className="text-muted">Recording</dt>
          <dd className="truncate" title={clip?.name}>
            {cut.clipId}
            {clip ? `, ${clip.name}` : ""}
          </dd>
          <dt className="text-muted">Source time</dt>
          <dd className="tc">
            {formatSeconds(cut.start)} to {formatSeconds(cut.end)}
          </dd>
          <dt className="text-muted">Length</dt>
          <dd className="tc">{formatSeconds(cut.end - cut.start)}</dd>
        </dl>
        {cut.note && (
          <Field label="Why">
            <p className="text-[12.5px] text-ink-2">{cut.note}</p>
          </Field>
        )}
        <div className="flex flex-wrap gap-2">
          {at != null && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                transport.seek(Math.max(0, at - 2));
                transport.play();
              }}
            >
              <Icon name="play" size={11} />
              Play around it
            </button>
          )}
          {cut.by === "user" && (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => {
                apply((e) => deleteCut(e, cut.id));
                select(null);
              }}
            >
              <Icon name="trash" size={13} />
              Delete this cut
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TakeInspector({ groupId }: { groupId: string }) {
  const { state, edit } = useProject();
  const g = edit!.takeGroups.find((x) => x.id === groupId)!;
  const script = state.bundle!.script;
  const text = g.sentenceIds.map((id) => script?.sentences.find((s) => s.id === id)?.text ?? id).join(" ");
  return (
    <div>
      <InspectorHeader title={`Takes: ${g.sentenceIds.join(", ")}`} />
      <div className="grid gap-4 p-3">
        <Field label="Script">
          <p className="font-serif text-[14px] text-ink">{text}</p>
        </Field>
        <Field label="Claude's pick">
          <p className="text-[12.5px] text-ink-2">{g.why}</p>
        </Field>
        <TakeOptions group={g} />
      </div>
    </div>
  );
}

function WordsInspector({ anchor, focus }: { anchor: string; focus: string }) {
  const { apply, select } = useProject();
  const { idx } = useDerived();
  const { seekWord } = useSeek();
  if (!idx) return <Overview />;
  const words = wordsBetween(idx, anchor, focus);
  const dur = words.length ? words.at(-1)!.end - words[0]!.start : 0;
  return (
    <div>
      <InspectorHeader title={`${words.length} word${words.length === 1 ? "" : "s"} selected`} />
      <div className="grid gap-4 p-3">
        <p className="font-serif text-[14px] text-ink">{wordsText(words)}</p>
        <p className="meta">
          {formatSeconds(dur)} of source. Shift-click another word in the transcript to extend the selection.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              apply((e) => addUserCut(e, words));
              select(null);
            }}
          >
            <Icon name="scissors" size={14} />
            Cut selection
          </button>
          <button type="button" className="btn" onClick={() => words[0] && seekWord(words[0].id, true)}>
            <Icon name="play" size={11} />
            Play from here
          </button>
        </div>
      </div>
    </div>
  );
}

function CueInspector({ cueId }: { cueId: string }) {
  const { state } = useProject();
  const cue = state.bundle!.script?.cues.find((c) => c.id === cueId);
  if (!cue) return <Overview />;
  return (
    <div>
      <InspectorHeader title={`${cue.kind === "gfx" ? "Graphic" : "B-roll"} cue ${cue.id}`} />
      <div className="grid gap-4 p-3">
        <p className="font-serif text-[14px] text-ink">{cue.text}</p>
        {cue.flags.map((f) => (
          <p key={f} className="text-[12px] text-warn">
            {f}
          </p>
        ))}
        <p className="rounded-md bg-sunken px-3 py-2 text-[12.5px] text-ink-2">
          {cue.optional ? "Optional cue. " : ""}Claude didn't place this cue in the edit, so there's no graphic for it. Re-run Plan edit to have it reconsidered.
        </p>
      </div>
    </div>
  );
}

function Overview() {
  const { state, edit, apply } = useProject();
  const { duration } = useDerived();
  if (!edit) return null;
  const b = state.bundle!;
  const graphics = Object.values(b.graphics);
  const count = (s: string) => graphics.filter((g) => g.state === s).length;
  const building = graphics.filter((g) => g.state === "queued" || g.state === "building" || g.state === "rendering").length;
  const stale = graphics.filter((g) => g.stale).length;
  return (
    <div>
      <header className="flex h-9 items-center border-b border-line px-3">
        <h2 className="pane-title">Overview</h2>
        <span className="meta ml-auto tc">{formatSeconds(duration)} long</span>
      </header>
      <div className="grid gap-5 p-3">
        <section aria-labelledby="ov-cuts">
          <h3 id="ov-cuts" className="mb-2 text-[12px] font-semibold text-ink-2">
            Cuts by reason
          </h3>
          <ul className="grid gap-1">
            {REASONS.map((r) => {
              const cuts = edit.cuts.filter((c) => c.reason === r);
              if (!cuts.length) return null;
              const on = cuts.filter((c) => c.enabled);
              const secs = on.reduce((s, c) => s + (c.end - c.start), 0);
              return (
                <li key={r} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raised">
                  <span className="swatch" style={{ ["--rc" as string]: reasonColor(r) }} />
                  <span className="flex-1 text-[12.5px] text-ink">{REASON_LABEL[r]}</span>
                  <span className="meta tc">
                    {on.length}/{cuts.length}, {formatSeconds(secs)}
                  </span>
                  <Switch checked={on.length === cuts.length} label={`${on.length === cuts.length ? "Keep" : "Cut"} every ${REASON_LABEL[r].toLowerCase()}`} onChange={(v) => apply((e) => setReasonEnabled(e, r, v))} />
                </li>
              );
            })}
          </ul>
        </section>
        <section aria-labelledby="ov-picture">
          <h3 id="ov-picture" className="mb-2 text-[12px] font-semibold text-ink-2">
            Picture
          </h3>
          <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raised">
            <span className="flex-1 text-[12.5px] text-ink">Punch in on jump cuts</span>
            <Switch checked={Boolean(edit.punchIn)} label={edit.punchIn ? "Stop punching in on jump cuts" : "Punch in on jump cuts"} onChange={(v) => apply((e) => ({ ...e, punchIn: v }))} />
          </div>
          <p className="meta mt-1 px-2">Zooms in a little toward you on every other section, so each cut in one continuous take reads as a camera change. For camera footage: on a screen recording it crops the screen.</p>
        </section>
        <section aria-labelledby="ov-gfx">
          <h3 id="ov-gfx" className="mb-2 text-[12px] font-semibold text-ink-2">
            Graphics
          </h3>
          <p className="text-[12.5px] text-ink-2">
            {edit.overlays.filter((o) => o.enabled).length} of {edit.overlays.length} placed and on. {count("ready")} built
            {building ? `, ${building} building` : ""}
            {count("error") ? `, ${count("error")} failed` : ""}
            {stale ? `, ${stale} out of date` : ""}.
          </p>
        </section>
        <section className="meta grid gap-1">
          <p>Select a graphic, a cut or a take to edit it here.</p>
          <p>
            Click a struck word in the transcript to restore it. Select words and press <kbd>⌫</kbd> to cut them.
          </p>
        </section>
      </div>
    </div>
  );
}
