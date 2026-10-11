// Generates three brand-direction boards as HyperFrames compositions (2560x1440).
// Each shows the same content from video 1 so the directions compare like for like:
// lower-third over the speaker's third, title card, two job cards, a checklist and a definition card.
// Usage: node brand/directions/make-boards.mjs && hyperframes snapshot brand/directions/<id> --at 1.2
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const gsap = join(here, "../../node_modules/gsap/dist/gsap.min.js");

const directions = [
  {
    id: "a-field-notes",
    name: "Field Notes",
    pitch: "An engineer's notebook. Warm paper cards, an editorial serif voice, mono annotations. Reads as thoughtful and human.",
    fonts: { display: "Newsreader", label: "IBM Plex Mono" },
    t: {
      card: "#F4EFE6", fg: "#17140F", muted: "#6B6358", accent: "#E8501A", accent2: "#2F5D50", line: "#D9D0C2",
      radius: "10px", shadow: "0 24px 60px rgba(0,0,0,.38)", displayWeight: 600, displayCase: "none", displayTracking: "-0.015em",
      labelWeight: 500, chip: "#E8501A", chipFg: "#FFF8F0", check: "✓", cardBorder: "1px solid #E4DCCF", texture: "none",
    },
  },
  {
    id: "b-prod-console",
    name: "Prod Console",
    pitch: "Production dashboards. Dark glass panels, a lime 'it's live' signal, status chips and mono data. Reads as shipped, real, technical.",
    fonts: { display: "Schibsted Grotesk", label: "JetBrains Mono" },
    t: {
      card: "rgba(11,14,19,.92)", fg: "#E9EEF4", muted: "#8A97A8", accent: "#B8F54A", accent2: "#4FD1FF", line: "#263040",
      radius: "6px", shadow: "0 24px 60px rgba(0,0,0,.45)", displayWeight: 800, displayCase: "none", displayTracking: "-0.025em",
      labelWeight: 500, chip: "rgba(184,245,74,.14)", chipFg: "#B8F54A", check: "✓", cardBorder: "1px solid #263040", texture: "none",
    },
  },
  {
    id: "c-blueprint",
    name: "Blueprint",
    pitch: "Systems drawings. Blueprint-blue panels on a fine grid, condensed caps, dimension lines and a safety-yellow accent. Reads as architecture and how-it-works.",
    fonts: { display: "Oswald", label: "Space Mono" },
    t: {
      card: "rgba(10,36,82,.94)", fg: "#F2F7FF", muted: "#9DBCE6", accent: "#FFC93C", accent2: "#7DB8FF", line: "#3D6BB0",
      radius: "0px", shadow: "0 24px 60px rgba(0,0,0,.40)", displayWeight: 600, displayCase: "uppercase", displayTracking: "0.01em",
      labelWeight: 700, chip: "#FFC93C", chipFg: "#0A2452", check: "■", cardBorder: "1.5px solid #3D6BB0",
      texture: "repeating-linear-gradient(0deg, rgba(125,184,255,.10) 0 1px, transparent 1px 36px), repeating-linear-gradient(90deg, rgba(125,184,255,.10) 0 1px, transparent 1px 36px)",
    },
  },
];

const html = (d) => {
  const { t, fonts } = d;
  const card = `background:${t.card};background-image:${t.texture};color:${t.fg};border-radius:${t.radius};box-shadow:${t.shadow};border:${t.cardBorder};`;
  const label = `font-family:'${fonts.label}',monospace;font-weight:${t.labelWeight};font-size:26px;letter-spacing:.14em;text-transform:uppercase;color:${t.muted};`;
  const display = `font-family:'${fonts.display}',serif;font-weight:${t.displayWeight};text-transform:${t.displayCase};letter-spacing:${t.displayTracking};`;
  const chip = (txt) => `<span style="font-family:'${fonts.label}',monospace;font-size:24px;font-weight:600;letter-spacing:.06em;padding:8px 16px;border-radius:${t.radius === "0px" ? "0" : "999px"};background:${t.chip};color:${t.chipFg};">${txt}</span>`;
  const checkRow = (txt, done) => `<div style="display:flex;align-items:center;gap:22px;padding:16px 0;border-bottom:1px solid ${t.line};font-family:'${fonts.display}',serif;font-size:40px;${done ? "" : `color:${t.muted};`}">
      <span style="width:46px;height:46px;display:inline-flex;align-items:center;justify-content:center;border:2px solid ${done ? t.accent : t.line};border-radius:${t.radius === "0px" ? "0" : "8px"};color:${t.accent};font-size:30px;font-family:'${fonts.label}',monospace;">${done ? (t.check === "✓" ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="${t.accent}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>` : t.check) : ""}</span>${txt}</div>`;
  const dims = d.id === "c-blueprint"
    ? `<div style="position:absolute;left:0;right:0;top:-34px;height:2px;background:${t.accent2};opacity:.7"></div><div style="position:absolute;left:0;top:-44px;width:2px;height:22px;background:${t.accent2}"></div><div style="position:absolute;right:0;top:-44px;width:2px;height:22px;background:${t.accent2}"></div><div style="position:absolute;left:50%;top:-62px;transform:translateX(-50%);${label}color:${t.accent2};font-size:20px;background:transparent">1440 PX · SIDE PANEL</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=2560, height=1440" />
<script src="gsap.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; background: #0b0b0c; }
  #root { position: relative; width: 2560px; height: 1440px; overflow: hidden;
    background: radial-gradient(1200px 900px at 22% 55%, #4a3b2c 0%, #2a221b 45%, #141110 100%); }
  .speaker { position: absolute; left: 330px; top: 360px; width: 520px; height: 1080px; }
  .speaker .head { position:absolute; left:140px; top:60px; width:240px; height:290px; border-radius:50%; background:#6b5442; filter: blur(2px); }
  .speaker .body { position:absolute; left:0; top:330px; width:520px; height:760px; border-radius:260px 260px 0 0; background:#3b3f4a; filter: blur(2px); }
  .tag { position:absolute; left:470px; top:250px; font: 500 22px/1 'IBM Plex Mono', monospace; color: rgba(255,255,255,.35); letter-spacing:.2em; }
  .el { position: absolute; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="2560" data-height="1440">
  <div class="clip" id="scene" data-start="0" data-duration="2" data-track-index="1" style="position:absolute;inset:0;">
    <div class="speaker"><div class="head"></div><div class="body"></div></div>
    <div class="tag">YOU · LEFT THIRD</div>

    <!-- lower-third over the speaker -->
    <div class="el" style="left:120px;top:1110px;${card}padding:28px 40px;min-width:760px;">
      <div style="${display}font-size:58px;line-height:1.05;">Hamza Saraswat</div>
      <div style="${label}margin-top:12px;color:${t.accent};">AI Engineer · builds production AI</div>
    </div>

    <!-- title card -->
    <div class="el" style="left:1040px;top:110px;width:1400px;${card}padding:44px 56px;">
      ${dims}
      <div style="${label}">Video 1 · What is an AI engineer?</div>
      <div style="${display}font-size:120px;line-height:1.0;margin-top:18px;">Two jobs. <span style="color:${t.accent};">One title.</span></div>
    </div>

    <!-- two job cards -->
    <div class="el" style="left:1040px;top:470px;width:680px;${card}padding:36px 40px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">${chip("CARD A")}<span style="${label}font-size:22px;">AI engineer</span></div>
      <div style="${display}font-size:54px;line-height:1.08;margin-top:22px;">AI-powered developer</div>
      <div style="font-family:'${fonts.label}',monospace;font-size:28px;color:${t.muted};margin-top:18px;">Copilot · Claude · Node.js</div>
    </div>
    <div class="el" style="left:1760px;top:470px;width:680px;${card}padding:36px 40px;outline:3px solid ${t.accent};outline-offset:-3px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">${chip("CARD B")}<span style="${label}font-size:22px;">AI engineer</span></div>
      <div style="${display}font-size:54px;line-height:1.08;margin-top:22px;">Applied AI engineer</div>
      <div style="font-family:'${fonts.label}',monospace;font-size:28px;color:${t.muted};margin-top:18px;">RAG · agents · cross-functional</div>
    </div>

    <!-- checklist -->
    <div class="el" style="left:1040px;top:820px;width:680px;${card}padding:34px 40px;">
      <div style="${label}">The skills</div>
      ${checkRow("Call a model API", true)}${checkRow("Retrieval (RAG)", true)}${checkRow("Evals", false)}${checkRow("Ship to production", false)}
    </div>

    <!-- definition card -->
    <div class="el" style="left:1760px;top:820px;width:680px;${card}padding:34px 40px;">
      <div style="${label}color:${t.accent2};">Definition</div>
      <div style="${display}font-size:50px;line-height:1.1;margin-top:16px;">Forward Deployed Engineer</div>
      <div style="font-family:'${fonts.display}',serif;font-size:36px;line-height:1.35;margin-top:18px;color:${t.fg};opacity:.88;">An engineer who works inside the customer's world to make the product actually work there.</div>
      <div style="${label}font-size:20px;margin-top:20px;">Term coined at Palantir</div>
    </div>

    <!-- board footer: name, palette, type -->
    <div class="el" style="left:0;right:0;bottom:0;height:86px;background:rgba(0,0,0,.72);display:flex;align-items:center;gap:36px;padding:0 60px;font:500 26px/1 'IBM Plex Mono', monospace;color:#d9d9d9;letter-spacing:.06em;">
      <span style="color:#fff;font-weight:700;">${d.name.toUpperCase()}</span>
      ${[t.card, t.fg, t.accent, t.accent2, t.muted].map((c) => `<span style="width:40px;height:40px;border-radius:6px;background:${c};border:1px solid rgba(255,255,255,.25);display:inline-block;"></span>`).join("")}
      <span>${fonts.display} + ${fonts.label}</span>
    </div>
  </div>
</div>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.from(".el", { opacity: 0, y: 24, duration: 0.4, stagger: 0.05, ease: "power2.out" }, 0);
  window.__timelines["main"] = tl;
</script>
</body>
</html>`;
};

for (const d of directions) {
  const dir = join(here, d.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html(d));
  copyFileSync(gsap, join(dir, "gsap.min.js"));
}
writeFileSync(join(here, "directions.json"), JSON.stringify(directions, null, 2) + "\n");
console.log(directions.map((d) => d.id).join("\n"));
