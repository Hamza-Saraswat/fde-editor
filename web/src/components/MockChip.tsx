import { useApp } from "../state/app.tsx";

/** Shown in headers when the UI runs on ?mock=1 data. */
export function MockChip() {
  const { client } = useApp();
  if (!client.mock) return null;
  return (
    <span className="flex-none rounded-full border border-dashed border-line-strong px-2 text-[11px] leading-[18px] text-muted" title="?mock=1: in-memory data. Nothing is saved to disk.">
      Mock data
    </span>
  );
}
