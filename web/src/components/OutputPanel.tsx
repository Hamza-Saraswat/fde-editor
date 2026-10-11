// What the render produced: the final video, chapters, captions, and X clips.
import { useState } from "react";
import { useProject } from "../state/ProjectProvider.tsx";
import { runningJob } from "../state/projectStore.ts";
import { formatClock } from "../lib/timelineMath.ts";
import { Icon } from "./Icon.tsx";

export function OutputPanel() {
  const { state, runStage, dirty, saveNow } = useProject();
  const [copied, setCopied] = useState(false);
  const b = state.bundle!;
  const out = b.outputs;
  const rendering = !!runningJob(b, "render");
  const clipping = !!runningJob(b, "xclips");
  const [finalError, setFinalError] = useState(false);

  const render = () => {
    if (dirty) saveNow();
    void runStage("render");
  };
  const copy = async () => {
    if (!out.chapters) return;
    try {
      await navigator.clipboard.writeText(out.chapters);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto grid max-w-[1280px] grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] gap-6 px-6 py-5">
        <section aria-labelledby="final-heading" className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <h2 id="final-heading" className="pane-title">
              Final video
            </h2>
            <span className="meta">{b.project.stages.render?.message}</span>
            <button type="button" className="btn btn-primary ml-auto" onClick={render} disabled={rendering || !b.edit}>
              {rendering ? "Rendering…" : out.final ? "Render again" : "Render"}
            </button>
          </div>
          {out.final && !finalError ? (
            <video src={out.final} controls className="aspect-video w-full rounded-md bg-black" aria-label="Final video" onError={() => setFinalError(true)} />
          ) : (
            <div className="grid aspect-video w-full place-items-center rounded-md border border-dashed border-line-strong bg-pane text-center">
              <p className="max-w-sm text-[13px] text-ink-2">
                {finalError
                  ? "Couldn't load final.mp4. Render it again."
                  : rendering
                    ? "Rendering the final video. It shows here when it's done."
                    : "Render builds the full-resolution video with the graphics, intro and outro, plus the chapters and captions."}
              </p>
            </div>
          )}
          {out.final && (
            <p className="mt-2 text-[12px]">
              <a className="text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink" href={out.final} download>
                Download final.mp4
              </a>
            </p>
          )}
        </section>

        <div className="grid content-start gap-6">
          <section aria-labelledby="chapters-heading">
            <div className="mb-2 flex items-center gap-2">
              <h2 id="chapters-heading" className="pane-title">
                Chapters
              </h2>
              <button type="button" className="btn btn-sm ml-auto" disabled={!out.chapters} onClick={copy}>
                <Icon name={copied ? "check" : "copy"} size={13} />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {out.chapters ? (
              <textarea readOnly className="field tc h-40 w-full text-[12.5px]" value={out.chapters} aria-label="Chapters for the YouTube description" />
            ) : out.final ? (
              <p className="meta">
                No chapters for this video: YouTube needs at least 3, each 10 s or longer, starting at 0:00. This cut has{" "}
                {b.timeline?.chapters.length ?? 0} script section{b.timeline?.chapters.length === 1 ? "" : "s"}.
              </p>
            ) : (
              <p className="meta">
                Written by Render. Until then, the edit has {b.timeline?.chapters.length ?? 0} chapter{b.timeline?.chapters.length === 1 ? "" : "s"}:{" "}
                {b.timeline?.chapters.map((c) => `${formatClock(c.start)} ${c.title}`).join("; ") || "none yet"}.
              </p>
            )}
          </section>

          <section aria-labelledby="captions-heading">
            <h2 id="captions-heading" className="pane-title mb-2">
              Captions
            </h2>
            {out.srt ? (
              <a className="btn btn-sm" href={out.srt} download="captions.srt">
                <Icon name="download" size={13} />
                Download captions.srt
              </a>
            ) : (
              <p className="meta">captions.srt is written by Render.</p>
            )}
          </section>

          <section aria-labelledby="xclips-heading">
            <div className="mb-2 flex items-center gap-2">
              <h2 id="xclips-heading" className="pane-title">
                X clips
              </h2>
              <button type="button" className="btn btn-sm ml-auto" onClick={() => void runStage("xclips")} disabled={clipping || !b.edit}>
                {clipping ? "Picking clips…" : out.xclips.length ? "Make new X clips" : "Make X clips"}
              </button>
            </div>
            {out.xclips.length === 0 ? (
              <p className="meta">Claude picks 2–3 moments of 30–60 s that stand alone, and renders them with burned-in captions.</p>
            ) : (
              <ol className="grid gap-3">
                {out.xclips.map((c, i) => (
                  <li key={c.url} className="rounded-md border border-line bg-pane p-2">
                    <video src={c.url} controls className="aspect-video w-full rounded bg-black" aria-label={`X clip ${i + 1}`} preload="metadata" />
                    <p className="mt-2 font-serif text-[14px] text-ink">{c.hook}</p>
                    <p className="meta tc mt-0.5">
                      {formatClock(c.start)} to {formatClock(c.end)} ({Math.round(c.end - c.start)} s)
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
