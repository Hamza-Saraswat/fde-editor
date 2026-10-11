// "/p/:slug": header, pipeline bar, then the review workspace (or setup / output), plus the log drawer.
import { useEffect, useState } from "react";
import { ProjectProvider, useDerived, useProject } from "../state/ProjectProvider.tsx";
import { PlayerProvider } from "../state/player.tsx";
import { navigate } from "../lib/router.ts";
import { HealthBanner } from "./HealthBanner.tsx";
import { ProjectHeader } from "./ProjectHeader.tsx";
import { PipelineBar } from "./PipelineBar.tsx";
import { ReviewWorkspace } from "./ReviewWorkspace.tsx";
import { SetupView } from "./SetupView.tsx";
import { OutputPanel } from "./OutputPanel.tsx";
import { LogDrawer } from "./LogDrawer.tsx";
import { NoticeToast } from "./NoticeToast.tsx";

export type View = "review" | "output";

export function ProjectScreen({ slug }: { slug: string }) {
  return (
    <ProjectProvider slug={slug}>
      <Body />
    </ProjectProvider>
  );
}

function Body() {
  const { state, dispatch, edit } = useProject();
  const { fps, duration } = useDerived();
  const [view, setView] = useState<View>("review");
  const [logOpen, setLogOpen] = useState(false);

  // ` toggles the log anywhere outside a text field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "`" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setLogOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (logOpen) dispatch({ type: "logsSeen" });
  }, [logOpen, state.logs.length, dispatch]);

  if (!state.bundle) {
    return (
      <main className="grid h-full place-items-center">
        {state.loadError ? (
          <div role="alert" className="max-w-md text-center">
            <p className="text-ink">Couldn't open this project.</p>
            <p className="meta mt-1">{state.loadError}</p>
            <button type="button" className="btn mt-4" onClick={() => navigate("/")}>
              Back to projects
            </button>
          </div>
        ) : (
          <p className="meta">Opening project…</p>
        )}
      </main>
    );
  }

  return (
    <PlayerProvider fps={fps} duration={duration}>
      <div className="flex h-full flex-col">
        <ProjectHeader view={view} onView={setView} />
        <HealthBanner compact />
        <PipelineBar logOpen={logOpen} onToggleLog={() => setLogOpen((o) => !o)} />
        <div className="relative min-h-0 flex-1">
          <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`} className="h-full">
            {view === "output" ? <OutputPanel /> : edit ? <ReviewWorkspace /> : <SetupView />}
          </div>
          {logOpen && <LogDrawer onClose={() => setLogOpen(false)} />}
        </div>
        <NoticeToast />
      </div>
    </PlayerProvider>
  );
}
