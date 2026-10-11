// JSON files on disk, validated on every read and write. Writes are atomic (temp file + rename).
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { REPO_ROOT, projectsDir, projectPaths } from "./paths.ts";
import {
  ConfigSchema, ProjectSchema, ScriptDocSchema, TranscriptSchema, CandidatesSchema, EditPlanSchema, EditSchema,
  type Config, type Project, type StageName, type StageStatus,
} from "./schema.ts";

export async function readJson<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T>> {
  return schema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function readJsonIfExists<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T> | null> {
  return existsSync(file) ? readJson(file, schema) : null;
}

export async function writeJson<T extends z.ZodType>(file: string, schema: T, value: z.input<T>): Promise<z.infer<T>> {
  const parsed = schema.parse(value);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(parsed, null, 2) + "\n");
  await rename(tmp, file);
  return parsed;
}

export async function loadConfig(): Promise<Config> {
  const file = join(REPO_ROOT, "fde-editor.config.json");
  return existsSync(file) ? readJson(file, ConfigSchema) : ConfigSchema.parse({});
}

export const files = {
  project: ProjectSchema,
  script: ScriptDocSchema,
  transcript: TranscriptSchema,
  candidates: CandidatesSchema,
  plan: EditPlanSchema,
  edit: EditSchema,
} as const;

export async function listProjects(): Promise<Project[]> {
  const dir = projectsDir();
  if (!existsSync(dir)) return [];
  const out: Project[] = [];
  for (const slug of await readdir(dir)) {
    const p = projectPaths(slug).project;
    if (existsSync(p)) out.push(await readJson(p, ProjectSchema));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadProject(slug: string): Promise<Project> {
  return readJson(projectPaths(slug).project, ProjectSchema);
}

export async function saveProject(project: Project): Promise<Project> {
  return writeJson(projectPaths(project.slug).project, ProjectSchema, project);
}

// Serialized per project so concurrent stage updates never clobber each other.
const locks = new Map<string, Promise<unknown>>();
export async function updateProject(slug: string, fn: (p: Project) => Project | void): Promise<Project> {
  const prev = locks.get(slug) ?? Promise.resolve();
  const next = prev.then(async () => {
    const p = await loadProject(slug);
    return saveProject(fn(p) ?? p);
  });
  locks.set(slug, next.catch(() => undefined));
  return next;
}

export async function setStage(slug: string, stage: StageName, status: Partial<StageStatus>): Promise<Project> {
  return updateProject(slug, (p) => {
    p.stages[stage] = { state: "idle", message: "", ...p.stages[stage], ...status, updatedAt: new Date().toISOString() };
  });
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";
}
