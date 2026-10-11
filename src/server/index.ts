// Local HTTP server entry point: `pnpm dev:server` / `pnpm start`. Listens on 127.0.0.1 only.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, recoverInterruptedStages } from "./app.ts";

export { createApp, recoverInterruptedStages, type AppDeps, type ServerApp } from "./app.ts";

export const HOST = "127.0.0.1";

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4317);
  await recoverInterruptedStages();
  const { app, dispose } = createApp();
  const server = serve({ fetch: app.fetch, port, hostname: HOST }, (info) => {
    console.log(`fde-editor server listening on http://${HOST}:${info.port}`);
  });
  const shutdown = (signal: string) => {
    console.log(`\n${signal}: cancelling running jobs and shutting down`);
    dispose(); // aborts every job, which kills its ffmpeg / claude / hyperframes children
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

/** True when this file is the process entry point (not when a test imports it). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
