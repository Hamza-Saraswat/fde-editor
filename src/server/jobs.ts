// Job manager: runs pipeline stages in the background. At most one running job per (project, stage);
// every job can be cancelled through its AbortController. Job and stage changes go out as SSE events,
// the stage status is also written to project.json, and the last 20 jobs per project stay in memory
// for ProjectBundle.jobs.
import type { StageName, StageStatus } from "../core/schema.ts";
import { setStage } from "../core/store.ts";
import type { StageContext } from "../pipeline/types.ts";
import type { JobInfo } from "./api.ts";
import type { EventBus } from "./events.ts";

export type StageRunner = (stage: StageName, slug: string, ctx: StageContext<unknown>) => Promise<string>;

export const KEEP_JOBS = 20;
export const MESSAGE_LIMIT = 500;

export class JobConflictError extends Error {
  constructor(public job: JobInfo) {
    super(`${job.stage} is already running`);
  }
}

type Running = {
  info: JobInfo;
  slug: string;
  controller: AbortController;
  done: Promise<void>;
};

export type JobManagerOptions = {
  emitIntervalMs?: number; // progress events: at most one per this many ms (default 200 = 5/s)
  persistIntervalMs?: number; // progress writes to project.json (default 1000)
  setStage?: typeof setStage; // override for tests
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)) || "Unknown error";

/** Calls fn at most once per `ms`, always delivering the last call (trailing edge). */
function throttle(ms: number, fn: () => void) {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  const call = () => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        fn();
      }, ms - (now - last));
    }
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return call;
}

export class JobManager {
  private history = new Map<string, JobInfo[]>(); // per project, oldest first
  private running = new Map<string, Running>(); // key: slug \0 stage
  private pendingStarts = 0;
  private seq = 0;
  private readonly emitMs: number;
  private readonly persistMs: number;
  private readonly writeStage: typeof setStage;

  constructor(private bus: EventBus, private runner: StageRunner, opts: JobManagerOptions = {}) {
    this.emitMs = opts.emitIntervalMs ?? 200;
    this.persistMs = opts.persistIntervalMs ?? 1000;
    this.writeStage = opts.setStage ?? setStage;
  }

  /** Jobs of one project, newest first (running ones included). */
  list(slug: string): JobInfo[] {
    return [...(this.history.get(slug) ?? [])].reverse().map((j) => ({ ...j }));
  }

  find(slug: string, jobId: string): JobInfo | undefined {
    const j = this.history.get(slug)?.find((x) => x.id === jobId);
    return j && { ...j };
  }

  runningJob(slug: string, stage: StageName): JobInfo | undefined {
    const r = this.running.get(key(slug, stage));
    return r && { ...r.info };
  }

  /** Start a stage; throws JobConflictError if that stage is already running for this project. */
  start(slug: string, stage: StageName, options?: unknown): JobInfo {
    const existing = this.running.get(key(slug, stage));
    if (existing) throw new JobConflictError({ ...existing.info });

    const info: JobInfo = {
      id: `${stage}-${Date.now().toString(36)}-${++this.seq}`,
      stage,
      state: "running",
      startedAt: new Date().toISOString(),
      message: "Starting…",
      progress: 0,
    };
    const list = this.history.get(slug) ?? [];
    list.push(info);
    // drop the oldest finished jobs beyond the limit (running ones always stay)
    while (list.length > KEEP_JOBS) {
      const i = list.findIndex((j) => j.state !== "running");
      if (i < 0) break;
      list.splice(i, 1);
    }
    this.history.set(slug, list);

    const controller = new AbortController();
    const run: Running = { info, slug, controller, done: Promise.resolve() };
    this.running.set(key(slug, stage), run);
    run.done = this.execute(run, options);
    return { ...info };
  }

  /** Cancel whatever runs for this stage, wait for it to stop, then start fresh (used for chains and auto-previews). */
  async restart(slug: string, stage: StageName, options?: unknown): Promise<JobInfo> {
    this.pendingStarts++;
    try {
      for (let r = this.running.get(key(slug, stage)); r; r = this.running.get(key(slug, stage))) {
        r.controller.abort();
        await r.done;
      }
      return this.start(slug, stage, options);
    } finally {
      this.pendingStarts--;
    }
  }

  /** Cancel a job by id. Returns its info (unchanged if it had already finished), or undefined if unknown. */
  cancel(slug: string, jobId: string): JobInfo | undefined {
    for (const r of this.running.values()) {
      if (r.slug === slug && r.info.id === jobId) {
        r.controller.abort();
        return { ...r.info };
      }
    }
    return this.find(slug, jobId);
  }

  cancelStage(slug: string, stage: StageName): void {
    this.running.get(key(slug, stage))?.controller.abort();
  }

  cancelAll(): void {
    for (const r of this.running.values()) r.controller.abort();
  }

  /** Resolves when nothing is running or about to start (chained jobs included). */
  async idle(timeoutMs = 60_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.running.size || this.pendingStarts) {
      if (Date.now() > until) throw new Error(`jobs still running after ${timeoutMs} ms`);
      await Promise.race([...[...this.running.values()].map((r) => r.done), new Promise((r) => setTimeout(r, 10))]);
    }
  }

  private async execute(run: Running, options: unknown): Promise<void> {
    await Promise.resolve(); // let start() return before the stage begins
    const { info, slug, controller } = run;
    const stage = info.stage;
    const chained: { stage: StageName; options?: unknown }[] = [];
    const emitJob = () => this.bus.emit(slug, { type: "job", job: { ...info } });
    const stageStatus = (state: StageStatus["state"]): StageStatus => ({
      state,
      message: info.message,
      ...(info.progress !== undefined ? { progress: info.progress } : {}),
      updatedAt: new Date().toISOString(),
    });
    const persist = (state: StageStatus["state"]) =>
      this.writeStage(slug, stage, { state, message: info.message, progress: info.progress }).catch((err: unknown) =>
        console.error(`[jobs] could not write ${stage} status for ${slug}:`, errorText(err)));

    const emitProgress = throttle(this.emitMs, () => {
      if (info.state !== "running") return;
      emitJob();
      this.bus.emit(slug, { type: "stage", stage, status: stageStatus("running") });
    });
    const persistProgress = throttle(this.persistMs, () => {
      if (info.state === "running") void persist("running");
    });

    const ctx: StageContext<unknown> = {
      signal: controller.signal,
      options,
      emit: (event) => this.bus.emit(slug, event),
      progress: (fraction, message) => {
        if (info.state !== "running") return;
        if (fraction !== undefined && Number.isFinite(fraction)) info.progress = Math.min(1, Math.max(0, fraction));
        if (message) info.message = message.slice(0, MESSAGE_LIMIT);
        emitProgress();
        persistProgress();
      },
      chain: (next, nextOptions) => chained.push({ stage: next, options: nextOptions }),
    };

    emitJob();
    this.bus.emit(slug, { type: "stage", stage, status: stageStatus("running") });
    await persist("running");

    let state: JobInfo["state"];
    let message: string;
    try {
      controller.signal.throwIfAborted();
      message = await this.runner(stage, slug, ctx);
      controller.signal.throwIfAborted();
      state = "done";
    } catch (err) {
      if (controller.signal.aborted) {
        state = "cancelled";
        message = "Cancelled";
      } else {
        state = "error";
        message = errorText(err);
        console.error(`[jobs] ${slug}/${stage} failed:`, err instanceof Error ? (err.stack ?? err.message) : err);
      }
    }
    emitProgress.cancel();
    persistProgress.cancel();

    info.state = state;
    info.message = message.slice(0, MESSAGE_LIMIT);
    info.endedAt = new Date().toISOString();
    if (state === "done") info.progress = 1;
    const stageState: StageStatus["state"] = state === "done" ? "done" : state === "error" ? "error" : "idle";
    await persist(stageState);
    this.running.delete(key(slug, stage));
    emitJob();
    this.bus.emit(slug, { type: "stage", stage, status: stageStatus(stageState) });
    this.bus.emit(slug, { type: "bundle-changed" });

    if (state === "done") {
      for (const c of chained) {
        this.restart(slug, c.stage, c.options).catch((err: unknown) =>
          console.error(`[jobs] could not chain ${c.stage} after ${stage} for ${slug}:`, errorText(err)));
      }
    }
  }
}

const key = (slug: string, stage: StageName) => `${slug}\u0000${stage}`;
