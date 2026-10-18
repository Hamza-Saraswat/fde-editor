// Project creation, clips and assets: the parts of the API that change project.json.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { expandHome, projectPaths, projectsDir } from "../core/paths.ts";
import { ffprobeJson } from "../core/proc.ts";
import { parseScript } from "../core/script-parser.ts";
import {
  AssetSchema, EditSchema, ProjectSchema, RectSchema, ScriptDocSchema,
  type Asset, type Clip, type Project,
} from "../core/schema.ts";
import { readJsonIfExists, slugify, updateProject, writeJson } from "../core/store.ts";
import { hdrError } from "../media/prepare.ts";
import type { PipelineDeps } from "../pipeline/types.ts";
import type { PatchAssetBody } from "./api.ts";

export const bad = (message: string) => new HTTPException(400, { message });
export const notFound = (message: string) => new HTTPException(404, { message });

/** zod parse that turns a validation failure into a 400 with a readable message. */
export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const res = schema.safeParse(value);
  if (!res.success) throw bad(`Invalid request: ${z.prettifyError(res.error).slice(0, 1000)}`);
  return res.data;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export const CreateProjectBodySchema = z.object({
  scriptPath: z.string().min(1),
  title: z.string().optional(),
  speakerSide: z.enum(["left", "right", "center"]).default("left"),
  clipPaths: z.array(z.string().min(1)).default([]),
});

export const PatchProjectBodySchema = z.object({
  title: z.string().trim().min(1).optional(),
  speakerSide: z.enum(["left", "right", "center"]).optional(),
  nextVideoTitle: z.string().optional(),
});

export const AddClipsBodySchema = z.object({ paths: z.array(z.string().min(1)).min(1) });
export const PatchClipBodySchema = z.object({ mirror: z.boolean().optional(), stabilize: z.boolean().optional() });

export const PatchAssetBodySchema = z.object({
  cueId: z.string().min(1).nullable().optional(),
  crop: RectSchema.nullable().optional(),
  blur: z.array(RectSchema).optional(),
  highlight: z.array(RectSchema).optional(),
}) satisfies z.ZodType<PatchAssetBody>;

const nextNumber = (ids: string[], prefix: string) =>
  ids.reduce((max, id) => {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0) + 1;

/** ffprobe every recording (ids continue from `firstId`); 400 for missing files, unreadable files and HDR. */
export async function probeRecordings(paths: string[], firstId: number, probe: PipelineDeps["probeClip"], existing: Clip[] = []): Promise<Clip[]> {
  const clips: Clip[] = [];
  for (const [i, raw] of paths.entries()) {
    const path = resolve(expandHome(raw));
    if (!existsSync(path) || !(await stat(path)).isFile()) throw bad(`Recording not found: ${path}`);
    if ([...existing, ...clips].some((c) => c.path === path)) throw bad(`${basename(path)} is already in this project`);
    let clip: Clip;
    try {
      clip = await probe(path, `c${firstId + i}`);
    } catch (err) {
      throw bad(`${basename(path)} could not be read as a video: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
    if (clip.hdr) throw bad(hdrError(clip).message);
    clips.push(clip);
  }
  return clips;
}

/** Claim projects/<slug>, adding -2, -3 … when taken (mkdir is the atomic claim). */
async function claimSlug(base: string): Promise<string> {
  await mkdir(projectsDir(), { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    try {
      await mkdir(projectPaths(slug).root);
      return slug;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find a free folder name for ${base}`);
}

export async function createProject(body: unknown, deps: Pick<PipelineDeps, "probeClip">): Promise<Project> {
  const b = parseBody(CreateProjectBodySchema, body);
  const scriptPath = resolve(expandHome(b.scriptPath));
  if (!existsSync(scriptPath) || !(await stat(scriptPath)).isFile()) throw bad(`Script not found: ${scriptPath}`);
  const markdown = await readFile(scriptPath, "utf8");
  const script = parseScript(markdown);
  if (!script.sentences.length) throw bad(`${basename(scriptPath)} has no spoken lines (**SAY** blocks) — is it a video script?`);
  const clips = await probeRecordings(b.clipPaths, 1, deps.probeClip);

  const title = b.title?.trim() || script.title || basename(scriptPath, extname(scriptPath));
  const slug = await claimSlug(slugify(title));
  const p = projectPaths(slug);
  try {
    await copyFile(scriptPath, p.scriptMd);
    await writeJson(p.script, ScriptDocSchema, script);
    return await writeJson(p.project, ProjectSchema, {
      slug,
      title,
      createdAt: new Date().toISOString(),
      scriptSource: scriptPath,
      speakerSide: b.speakerSide,
      clips,
    });
  } catch (err) {
    await rm(p.root, { recursive: true, force: true }); // half-created folder from this request
    throw err;
  }
}

export async function patchProject(slug: string, body: unknown): Promise<Project> {
  const b = parseBody(PatchProjectBodySchema, body);
  return updateProject(slug, (p) => {
    if (b.title !== undefined) p.title = b.title;
    if (b.speakerSide !== undefined) p.speakerSide = b.speakerSide;
    if (b.nextVideoTitle !== undefined) p.nextVideoTitle = b.nextVideoTitle;
  });
}

export async function addClips(slug: string, body: unknown, deps: Pick<PipelineDeps, "probeClip">, current: Project): Promise<Project> {
  const b = parseBody(AddClipsBodySchema, body);
  const clips = await probeRecordings(b.paths, nextNumber(current.clips.map((c) => c.id), "c"), deps.probeClip, current.clips);
  return updateProject(slug, (p) => {
    p.clips.push(...clips.filter((c) => !p.clips.some((x) => x.id === c.id || x.path === c.path)));
  });
}

/** Remove a clip from project.json and from the edit's clip order (bumping the edit version). */
/** Picture fixes for one clip (mirror, stabilize). Returns whether anything changed. */
export async function patchClip(slug: string, clipId: string, body: unknown): Promise<{ project: Project; changed: boolean }> {
  const b = parseBody(PatchClipBodySchema, body);
  let found = false, changed = false;
  const project = await updateProject(slug, (p) => {
    const clip = p.clips.find((c) => c.id === clipId);
    if (!clip) return;
    found = true;
    for (const k of ["mirror", "stabilize"] as const) {
      if (b[k] !== undefined && Boolean(clip[k]) !== b[k]) {
        clip[k] = b[k];
        changed = true;
      }
    }
  });
  if (!found) throw notFound(`No clip ${clipId} in this project`);
  return { project, changed };
}

export async function removeClip(slug: string, clipId: string): Promise<{ project: Project; editChanged: boolean }> {
  let found = false;
  const project = await updateProject(slug, (p) => {
    found = p.clips.some((c) => c.id === clipId);
    p.clips = p.clips.filter((c) => c.id !== clipId);
  });
  if (!found) throw notFound(`No clip ${clipId} in this project`);
  const editFile = projectPaths(slug).edit;
  const edit = await readJsonIfExists(editFile, EditSchema).catch(() => null);
  if (edit?.clipOrder.includes(clipId)) {
    await writeJson(editFile, EditSchema, { ...edit, version: edit.version + 1, clipOrder: edit.clipOrder.filter((c) => c !== clipId) });
    return { project, editChanged: true };
  }
  return { project, editChanged: false };
}

// ---------- assets ----------

const IMAGE_TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

export type ProbeImage = (file: string) => Promise<{ width: number; height: number }>;

export const probeImage: ProbeImage = async (file) => {
  const j = (await ffprobeJson(file)) as { streams?: { codec_type?: string; width?: number; height?: number }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error("no image stream");
  return { width: v.width, height: v.height };
};

export async function addAsset(slug: string, file: unknown, probe: ProbeImage): Promise<Asset> {
  if (!(file instanceof File)) throw bad('Send the image as the multipart field "file"');
  let ext = extname(file.name).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) ext = IMAGE_TYPES[file.type] ?? "";
  if (!ext) throw bad("Only PNG, JPEG and WebP images can be added");
  if (file.size > MAX_ASSET_BYTES) throw bad("That image is larger than 50 MB");

  const p = projectPaths(slug);
  await mkdir(p.assetsDir, { recursive: true });
  const upload = join(p.assetsDir, `.upload-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  let size: { width: number; height: number };
  try {
    await writeFile(upload, Buffer.from(await file.arrayBuffer()));
    size = await probe(upload);
  } catch (err) {
    await rm(upload, { force: true });
    throw bad(`${file.name || "That file"} could not be read as an image: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  }
  // the id is picked under the project lock, so two uploads never get the same one
  let asset: Asset | undefined;
  await updateProject(slug, (proj) => {
    const id = `a${nextNumber(proj.assets.map((a) => a.id), "a")}`;
    asset = AssetSchema.parse({ id, name: file.name || `${id}${ext}`, file: `assets/${id}${ext}`, kind: "image", ...size });
    proj.assets.push(asset);
  });
  await rename(upload, join(p.root, asset!.file));
  return asset!;
}

export async function patchAsset(slug: string, assetId: string, body: unknown): Promise<Asset> {
  const b = parseBody(PatchAssetBodySchema, body);
  let asset: Asset | undefined;
  await updateProject(slug, (p) => {
    asset = p.assets.find((a) => a.id === assetId);
    if (!asset) return;
    if (b.cueId === null) delete asset.cueId;
    else if (b.cueId !== undefined) asset.cueId = b.cueId;
    if (b.crop === null) delete asset.crop;
    else if (b.crop !== undefined) asset.crop = b.crop;
    if (b.blur !== undefined) asset.blur = b.blur;
    if (b.highlight !== undefined) asset.highlight = b.highlight;
  });
  if (!asset) throw notFound(`No asset ${assetId} in this project`);
  return asset;
}

export async function deleteAsset(slug: string, assetId: string): Promise<Project> {
  let removed: Asset | undefined;
  const project = await updateProject(slug, (p) => {
    removed = p.assets.find((a) => a.id === assetId);
    p.assets = p.assets.filter((a) => a.id !== assetId);
  });
  if (!removed) throw notFound(`No asset ${assetId} in this project`);
  const abs = join(projectPaths(slug).root, removed.file);
  if (abs.startsWith(projectPaths(slug).assetsDir)) await rm(abs, { force: true });
  return project;
}
