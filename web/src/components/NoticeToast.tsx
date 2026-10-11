import { useEffect } from "react";
import { useProject } from "../state/ProjectProvider.tsx";
import { Icon } from "./Icon.tsx";

export function NoticeToast() {
  const { state, dispatch } = useProject();
  const n = state.notice;
  useEffect(() => {
    if (!n || n.tone !== "info") return;
    const t = window.setTimeout(() => dispatch({ type: "dismissNotice" }), 5000);
    return () => window.clearTimeout(t);
  }, [n, dispatch]);
  if (!n) return null;
  const color = n.tone === "error" ? "var(--color-bad)" : n.tone === "warn" ? "var(--color-warn)" : "var(--color-run)";
  return (
    <div
      role={n.tone === "info" ? "status" : "alert"}
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[640px] -translate-x-1/2 items-start gap-3 rounded-lg border border-line-strong bg-raised py-2.5 pl-3 pr-2 shadow-2xl"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <p className="text-[12.5px] text-ink">{n.text}</p>
      <button type="button" className="btn btn-sm btn-ghost btn-icon flex-none" aria-label="Dismiss" onClick={() => dispatch({ type: "dismissNotice" })}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
