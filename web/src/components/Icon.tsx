// Inline stroke icons (16px grid). Decorative: buttons carry their own labels.
const PATHS = {
  play: "M5 3.5v9l7.5-4.5z",
  pause: "M5 3.5v9M11 3.5v9",
  back: "M10 4 6 8l4 4",
  forward: "M6 4l4 4-4 4",
  frameBack: "M11.5 4 7.5 8l4 4M4.5 4v8",
  frameFwd: "M4.5 4l4 4-4 4M11.5 4v8",
  plus: "M8 3.5v9M3.5 8h9",
  minus: "M3.5 8h9",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  check: "M3.5 8.5l3 3 6-7",
  chevronDown: "M4.5 6.5 8 10l3.5-3.5",
  chevronRight: "M6.5 4.5 10 8l-3.5 3.5",
  folder: "M2.5 4.5h4l1.2 1.4h5.8v6.6h-11z",
  film: "M3 3.5h10v9H3zM5.5 3.5v9M10.5 3.5v9M3 6.2h2.5M3 9.8h2.5M10.5 6.2H13M10.5 9.8H13",
  image: "M2.5 3.5h11v9h-11zM2.5 10.5l3.5-3 3 2.5 2-1.5 2.5 2",
  up: "M8 12.5v-9M4.5 7 8 3.5 11.5 7",
  undo: "M6 4.5 3 7.5l3 3M3.5 7.5H10a3 3 0 0 1 0 6H8",
  redo: "M10 4.5l3 3-3 3M12.5 7.5H6a3 3 0 0 0 0 6h2",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  log: "M3 4h10M3 8h10M3 12h6",
  scissors: "M5 5.5a1.6 1.6 0 1 1-1.6-1.6A1.6 1.6 0 0 1 5 5.5zM5 10.5a1.6 1.6 0 1 1-1.6-1.6A1.6 1.6 0 0 1 5 10.5zM4.6 6.6 13 12M4.6 9.4 13 4",
  trash: "M3.5 4.5h9M6.5 4.5V3h3v1.5M4.8 4.5l.6 8.5h5.2l.6-8.5",
  refresh: "M12.5 6A4.8 4.8 0 0 0 3.6 6.4M3.5 3.5v3h3M3.5 10a4.8 4.8 0 0 0 8.9-.4M12.5 12.5v-3h-3",
  keyboard: "M2 4.5h12v7H2zM4.5 7h1M7.5 7h1M10.5 7h1M5 9.5h6",
  warn: "M8 2.5l6 10.5H2zM8 6.5v3M8 11.2v.1",
  stop: "M4.5 4.5h7v7h-7z",
  dots: "M4 8h.01M8 8h.01M12 8h.01",
  external: "M9 3.5h3.5V7M12.5 3.5 7.5 8.5M11 9.5v3H3.5V5H6.5",
  download: "M8 3v7.5M4.8 7.6 8 10.8l3.2-3.2M3.5 13h9",
  speaker: "M3 6.5h2.5L9 3.5v9l-3.5-3H3zM11 6a2.6 2.6 0 0 1 0 4",
  mute: "M3 6.5h2.5L9 3.5v9l-3.5-3H3zM11 6.5l3 3M14 6.5l-3 3",
  fit: "M2.5 6V3.5H5M11 3.5h2.5V6M13.5 10v2.5H11M5 12.5H2.5V10",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className = "" }: { name: IconName; size?: number; className?: string }) {
  const fill = name === "play" || name === "stop";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={className}
      fill={fill ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={name === "dots" ? 2.4 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
