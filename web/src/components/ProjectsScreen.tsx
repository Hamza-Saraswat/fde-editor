// "/": every project, and the New project flow.
import { useCallback, useEffect, useState } from "react";
import type { Project } from "../types.ts";
import { useApp } from "../state/app.tsx";
import { navigate, projectPath } from "../lib/router.ts";
import { formatDate } from "../lib/format.ts";
import { PIPELINE, STAGE_LABEL } from "../lib/stages.ts";
import { HealthBanner } from "./HealthBanner.tsx";
import { NewProjectPanel } from "./NewProjectPanel.tsx";
import { Icon } from "./Icon.tsx";
import { MockChip } from "./MockChip.tsx";

export function ProjectsScreen() {
  const { client } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    client.projects().then(
      (p) => {
        setProjects(p);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [client]);
  useEffect(load, [load]);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="flex h-12 flex-none items-center gap-3 border-b border-line bg-pane px-4">
        <span className="font-semibold tracking-tight text-ink">fde-editor</span>
        <span className="text-faint">/</span>
        <h1 className="text-[13px] font-medium text-ink-2">Projects</h1>
        <MockChip />
        <button type="button" className="btn btn-primary ml-auto" onClick={() => setCreating(true)} disabled={creating}>
          <Icon name="plus" size={14} />
          New project
        </button>
      </header>
      <HealthBanner />

      <main className="mx-auto w-full max-w-[1080px] px-6 py-6">
        {creating && (
          <NewProjectPanel
            onCancel={() => setCreating(false)}
            onCreated={(p) => {
              setCreating(false);
              navigate(projectPath(p.slug));
            }}
          />
        )}

        {error && (
          <div role="alert" className="mb-4 rounded-md border border-line bg-[#2b2120] px-3 py-2 text-[12.5px]">
            Couldn't load projects: {error}{" "}
            <button type="button" className="btn btn-sm ml-2" onClick={load}>
              Try again
            </button>
          </div>
        )}

        {projects && projects.length === 0 && !creating && (
          <div className="rounded-lg border border-dashed border-line-strong px-6 py-12 text-center">
            <p className="text-[15px] text-ink">No projects yet.</p>
            <p className="meta mt-1">Pick a script and the recordings that go with it to start one.</p>
            <button type="button" className="btn btn-primary mt-4" onClick={() => setCreating(true)}>
              New project
            </button>
          </div>
        )}

        {projects && projects.length > 0 && (
          <section aria-labelledby="projects-heading">
            <h2 id="projects-heading" className="pane-title mb-2">
              {projects.length} project{projects.length === 1 ? "" : "s"}
            </h2>
            <ul role="list" className="overflow-hidden rounded-lg border border-line">
              {projects.map((p) => (
                <li key={p.slug} className="border-b border-line last:border-b-0">
                  <a
                    href={projectPath(p.slug) + window.location.search}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) return;
                      e.preventDefault();
                      navigate(projectPath(p.slug));
                    }}
                    className="grid grid-cols-[minmax(0,1fr)_110px_70px_minmax(0,400px)] items-center gap-4 bg-pane px-4 py-3 no-underline hover:bg-raised"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-ink">{p.title}</span>
                      <span className="meta block truncate">{p.slug}</span>
                    </span>
                    <span className="meta">{formatDate(p.createdAt)}</span>
                    <span className="meta">
                      {p.clips.length} clip{p.clips.length === 1 ? "" : "s"}
                    </span>
                    <StageChips project={p} />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!projects && !error && <p className="meta">Loading projects…</p>}
      </main>
    </div>
  );
}

function StageChips({ project }: { project: Project }) {
  const shown = PIPELINE.filter((s) => project.stages[s] && project.stages[s]!.state !== "idle");
  if (!shown.length) return <span className="meta">Not started</span>;
  return (
    <span className="flex flex-wrap justify-end gap-1" aria-label="Pipeline status">
      {shown.map((s) => {
        const st = project.stages[s]!;
        return (
          <span
            key={s}
            title={`${STAGE_LABEL[s]}: ${st.state}${st.message ? `. ${st.message}` : ""}`}
            className="inline-flex h-5 items-center gap-1.5 rounded-full border border-line px-2 text-[11px] text-ink-2"
          >
            <span className="dot" data-state={st.state} />
            {STAGE_LABEL[s]}
          </span>
        );
      })}
    </span>
  );
}
