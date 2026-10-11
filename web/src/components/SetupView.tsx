// Before there's an edit: the recordings, the script outline, and what to run next.
import { useState } from "react";
import type { FileEntry } from "../types.ts";
import { useApp } from "../state/app.tsx";
import { useProject } from "../state/ProjectProvider.tsx";
import { runningJob } from "../state/projectStore.ts";
import { formatSeconds } from "../lib/timelineMath.ts";
import { FileBrowser } from "./FileBrowser.tsx";
import { Icon } from "./Icon.tsx";

export function SetupView() {
  const { client } = useApp();
  const { state, slug, dispatch, notify } = useProject();
  const b = state.bundle!;
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<FileEntry[]>([]);

  const next = !b.project.clips.length
    ? "Add the recordings for this video."
    : b.project.stages.import?.state === "error"
      ? "Import failed. Check the message in the pipeline bar, fix the recording, and run Import again."
      : !b.transcript
        ? runningJob(b, "transcribe")
          ? "Transcribing. The words appear here when it finishes."
          : "Next: Transcribe the recordings (pick the engine next to the step)."
        : "Next: Plan edit. Claude picks takes, cuts fillers and places the graphics.";

  const addClips = async () => {
    try {
      const project = await client.addClips(slug, picked.map((p) => p.path));
      dispatch({ type: "project", project });
      setPicked([]);
      setAdding(false);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const removeClip = async (clipId: string) => {
    try {
      dispatch({ type: "project", project: await client.removeClip(slug, clipId) });
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto grid max-w-[1080px] grid-cols-[1.1fr_1fr] gap-8 px-6 py-6">
        <p className="col-span-2 rounded-md border border-line bg-pane px-4 py-3 text-[13.5px] text-ink">{next}</p>

        <section aria-labelledby="clips-heading">
          <div className="mb-2 flex items-center">
            <h2 id="clips-heading" className="pane-title">
              Recordings
            </h2>
            <button type="button" className="btn btn-sm ml-auto" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
              <Icon name="plus" size={13} />
              Add recordings
            </button>
          </div>
          {adding && (
            <div className="mb-3">
              <FileBrowser
                kind="video"
                label="Recordings to add"
                selected={picked.map((p) => p.path)}
                onToggle={(f) => setPicked((ps) => (ps.some((p) => p.path === f.path) ? ps.filter((p) => p.path !== f.path) : [...ps, f]))}
              />
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-sm btn-primary" disabled={!picked.length} onClick={addClips}>
                  Add {picked.length || ""} recording{picked.length === 1 ? "" : "s"}
                </button>
              </div>
            </div>
          )}
          {b.project.clips.length === 0 ? (
            <p className="meta">No recordings yet.</p>
          ) : (
            <ul role="list" className="overflow-hidden rounded-md border border-line">
              {b.project.clips.map((c) => (
                <li key={c.id} className="flex items-center gap-3 border-b border-line bg-pane px-3 py-2 last:border-b-0">
                  <span className="tc w-6 text-[11.5px] text-muted">{c.id}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{c.name}</span>
                    <span className="meta block">
                      {formatSeconds(c.duration)}, {c.width}×{c.height}, {c.fps} fps, {c.codec} {c.pixFmt}
                      {c.vfr ? ", variable frame rate (conformed)" : ""}
                      {c.hdr ? ", HDR" : ""}
                    </span>
                  </span>
                  <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove ${c.name}`} onClick={() => removeClip(c.id)}>
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="outline-heading">
          <h2 id="outline-heading" className="pane-title mb-2">
            Script
          </h2>
          {b.script ? (
            <div className="rounded-md border border-line bg-pane px-4 py-3">
              <p className="mb-2 font-serif text-[15px] text-ink">{b.script.title}</p>
              <ul role="list" className="grid gap-1">
                {b.script.sections.map((s) => (
                  <li key={s.id} className={`flex items-baseline gap-2 text-[12.5px] ${s.level > 2 ? "pl-4 text-ink-2" : "text-ink"}`}>
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    <span className="meta">
                      {s.sentenceIds.length} line{s.sentenceIds.length === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="meta mt-3">
                {plural(b.script.cues.filter((c) => c.kind === "gfx").length, "graphics cue")}, {plural(b.script.cues.filter((c) => c.kind === "broll").length, "B-roll cue")}
              </p>
            </div>
          ) : (
            <p className="meta">The script is parsed during Import.</p>
          )}
        </section>
      </div>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
