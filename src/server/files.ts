// GET /api/scripts (markdown scripts under config.scriptsDir) and GET /api/files (a folder browser
// for picking recordings and screenshots, confined to the user's home folder).
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { expandHome } from "../core/paths.ts";
import { stripInlineMarkdown } from "../core/script-parser.ts";
import type { FileEntry, FileListing, ScriptEntry } from "./api.ts";

export const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);
export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export class FilesError extends Error {
  constructor(public status: 403 | 404, message: string) {
    super(message);
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** First `# ` heading of a markdown document, inline markdown removed. */
export function markdownTitle(markdown: string): string | null {
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown);
  return m ? stripInlineMarkdown(m[1]!).replace(/\s+/g, " ").trim() || null : null;
}

/** Every video script (.md with an H1 and **SAY** blocks) in `root` and up to two folders below it, newest first. */
export async function listScripts(root: string, maxDepth = 2): Promise<ScriptEntry[]> {
  const base = resolve(expandHome(root));
  const out: ScriptEntry[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile() && extname(e.name).toLowerCase() === ".md") {
        try {
          const [text, st] = await Promise.all([readFile(full, "utf8"), stat(full)]);
          const title = markdownTitle(text);
          // Only video scripts: articles and notes in the same folders have no spoken **SAY** blocks.
          if (!title || !/^\*\*SAY\*\*\s*$/m.test(text)) continue;
          out.push({ path: full, title, folder: relative(base, dir) || basename(base), modified: st.mtime.toISOString() });
        } catch {
          // unreadable file: skip
        }
      }
    }
  };
  await walk(base, 0);
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);

/** Folders plus files of the wanted kind (both kinds when `kind` is undefined) in `dir`, which must be inside `home`. */
export async function listFolder(dirArg: string | undefined, kind: "video" | "image" | undefined, home: string): Promise<FileListing> {
  const homeAbs = resolve(home);
  const raw = dirArg?.trim();
  let dir: string;
  if (!raw) {
    const downloads = join(homeAbs, "Downloads");
    dir = (await stat(downloads).catch(() => null))?.isDirectory() ? downloads : homeAbs;
  } else {
    dir = resolve(raw === "~" ? homeAbs : raw.startsWith("~/") ? join(homeAbs, raw.slice(2)) : raw);
  }
  if (!inside(homeAbs, dir)) throw new FilesError(403, "Only folders inside your home folder can be browsed");
  const [homeReal, dirReal] = await Promise.all([realpath(homeAbs).catch(() => homeAbs), realpath(dir).catch(() => null)]);
  if (dirReal === null) throw new FilesError(404, `Folder not found: ${dir}`);
  if (!inside(homeReal, dirReal)) throw new FilesError(403, "Only folders inside your home folder can be browsed");
  const st = await stat(dirReal);
  if (!st.isDirectory()) throw new FilesError(404, `Not a folder: ${dir}`);

  const exts = kind === "video" ? VIDEO_EXTS : kind === "image" ? IMAGE_EXTS : new Set([...VIDEO_EXTS, ...IMAGE_EXTS]);
  const dirs: FileEntry[] = [];
  const files: FileEntry[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    const isDirLike = e.isDirectory() || e.isSymbolicLink();
    if (!isDirLike && !exts.has(extname(e.name).toLowerCase())) continue;
    const s = await stat(full).catch(() => null); // follows symlinks
    if (!s) continue;
    if (s.isDirectory()) {
      dirs.push({ name: e.name, path: full, isDir: true, size: 0, modified: s.mtime.toISOString() });
    } else if (s.isFile() && exts.has(extname(e.name).toLowerCase())) {
      files.push({ name: e.name, path: full, isDir: false, size: s.size, modified: s.mtime.toISOString() });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  files.sort((a, b) => b.modified.localeCompare(a.modified));
  return { dir, parent: dir === homeAbs ? null : dirname(dir), entries: [...dirs, ...files] };
}
