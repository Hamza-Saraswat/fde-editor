// Small display helpers. Pure.
import type { CutReason } from "../types.ts";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = n / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
}

export function formatDate(iso: string | undefined, withTime = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, withTime ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { year: "numeric", month: "short", day: "numeric" });
}

export function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return formatDate(iso);
}

export const REASONS: CutReason[] = ["filler", "silence", "stumble", "false-start", "repeat", "adlib", "handling", "user"];

export const REASON_LABEL: Record<CutReason | "take" | "pause", string> = {
  filler: "Filler",
  silence: "Silence",
  stumble: "Stumble",
  "false-start": "False start",
  repeat: "Repeat",
  adlib: "Ad-lib",
  handling: "Camera touched",
  user: "Your cut",
  take: "Other take",
  pause: "Pause tightened",
};

/** CSS colour for a cut reason (theme variables live in styles.css). */
export const reasonColor = (r: CutReason | "take" | "pause") =>
  r === "pause" || r === "handling" ? "var(--color-r-silence)" : `var(--color-r-${r})`;

export const BY_LABEL = { auto: "Detected automatically", claude: "Claude's plan", user: "You" } as const;
