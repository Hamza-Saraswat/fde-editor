// Where everything lives. One folder per video under projects/<slug>/.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Read on every call (not at import) so tests can point it at a temp folder at any time.
export const projectsDir = () => process.env.FDE_PROJECTS_DIR ?? join(REPO_ROOT, "projects");
export const BRAND_DIR = join(REPO_ROOT, "brand");
export const PROMPTS_DIR = join(REPO_ROOT, "prompts");
export const SCHEMAS_DIR = join(REPO_ROOT, "schemas");
export const HYPERFRAMES_BIN = join(REPO_ROOT, "node_modules", ".bin", "hyperframes");
export const brandPaths = {
  spec: join(BRAND_DIR, "BRAND.md"),
  tokens: join(BRAND_DIR, "kit", "tokens.css"),
  fontsDir: join(BRAND_DIR, "fonts"),
  templatesDir: join(BRAND_DIR, "templates"),
  intro: join(BRAND_DIR, "renders", "intro.mov"),
  outro: join(BRAND_DIR, "renders", "outro.mov"),
};

export const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function projectPaths(slug: string) {
  const root = join(projectsDir(), slug);
  return {
    root,
    project: join(root, "project.json"),
    scriptMd: join(root, "script.md"),
    script: join(root, "script.json"),
    transcript: join(root, "transcript.json"),
    transcriptsDir: join(root, "transcripts"),
    candidates: join(root, "candidates.json"),
    plan: join(root, "plan.json"),
    edit: join(root, "edit.json"),
    xclips: join(root, "xclips.json"),
    assetsDir: join(root, "assets"),
    proxyDir: join(root, "proxy"),
    audioDir: join(root, "audio"),
    graphicsDir: join(root, "graphics"),
    cacheDir: join(root, "cache"),
    runsDir: join(root, "runs"),
    outDir: join(root, "out"),
    proxy: (clipId: string) => join(root, "proxy", `${clipId}.mp4`),
    wav: (clipId: string) => join(root, "audio", `${clipId}.wav`), // 48 kHz stereo, for rendering
    asrWav: (clipId: string) => join(root, "audio", `${clipId}.16k.wav`), // 16 kHz mono, for local ASR
    asrMp3: (clipId: string) => join(root, "audio", `${clipId}.mp3`), // 64 kbps mono, for the OpenAI API
    graphic: (cueId: string) => join(root, "graphics", cueId),
    graphicMov: (cueId: string) => join(root, "graphics", cueId, "render.mov"), // ProRes 4444 with alpha, for the final
    graphicWebm: (cueId: string) => join(root, "graphics", cueId, "preview.webm"), // VP9 alpha, for the browser
    graphicStill: (cueId: string) => join(root, "graphics", cueId, "still.png"),
    preview: join(root, "out", "preview.mp4"),
    final: join(root, "out", "final.mp4"),
    chapters: join(root, "out", "chapters.txt"),
    srt: join(root, "out", "captions.srt"),
    xclipsDir: join(root, "out", "x-clips"),
  };
}
export type ProjectPaths = ReturnType<typeof projectPaths>;
