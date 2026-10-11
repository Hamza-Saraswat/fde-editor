import { useProject } from "../state/ProjectProvider.tsx";

export function SaveIndicator() {
  const { state, dirty, saveNow } = useProject();
  if (!state.history) return null;
  let text = "Saved";
  let tone = "text-muted";
  if (state.saving) text = "Saving…";
  else if (state.saveError) {
    text = "Couldn't save";
    tone = "text-bad";
  } else if (dirty) text = "Unsaved";
  const offline = state.connection === "error" || (state.everConnected && state.connection === "connecting");
  return (
    <span className="flex items-center gap-2 text-[12px]" role="status" aria-live="polite">
      {offline && (
        <span className="text-warn" title="Lost the live connection to the server. Reconnecting; edits still save.">
          Reconnecting…
        </span>
      )}
      <span className={tone} title={state.saveError ?? (dirty ? "Saves 0.6 s after your last change" : "All changes saved")}>
        {text}
      </span>
      {state.saveError && (
        <button type="button" className="btn btn-sm" onClick={saveNow}>
          Retry
        </button>
      )}
    </span>
  );
}
