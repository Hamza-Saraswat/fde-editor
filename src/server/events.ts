// Per-project event bus and the SSE endpoint the UI listens on (GET /api/projects/:slug/events).
// Each event is one unnamed SSE message whose data is a JSON ServerEvent.
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ServerEvent } from "./api.ts";

export type Listener = (event: ServerEvent) => void;

export class EventBus {
  private subs = new Map<string, Set<Listener>>();

  subscribe(slug: string, fn: Listener): () => void {
    let set = this.subs.get(slug);
    if (!set) this.subs.set(slug, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.subs.delete(slug);
    };
  }

  emit(slug: string, event: ServerEvent): void {
    for (const fn of [...(this.subs.get(slug) ?? [])]) {
      try {
        fn(event);
      } catch (err) {
        console.error("[events] listener failed:", err);
      }
    }
  }

  listeners(slug: string): number {
    return this.subs.get(slug)?.size ?? 0;
  }
}

export const HEARTBEAT_MS = 15_000;

/** text/event-stream of ServerEvent for one project; a comment line every 15 s keeps proxies from timing out. */
export function sseResponse(c: Context, bus: EventBus, slug: string, heartbeatMs = HEARTBEAT_MS): Response {
  return streamSSE(c, async (stream) => {
    let queue: Promise<unknown> = Promise.resolve();
    const send = (chunk: () => Promise<unknown>) => {
      queue = queue.then(chunk).catch(() => undefined); // keep order; a dead stream just drops writes
    };
    const unsubscribe = bus.subscribe(slug, (event) => send(() => stream.writeSSE({ data: JSON.stringify(event) })));
    const heartbeat = setInterval(() => send(() => stream.write(": ping\n\n")), heartbeatMs);
    const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
    send(() => stream.write(": connected\n\n"));
    await closed;
    clearInterval(heartbeat);
    unsubscribe();
  });
}
