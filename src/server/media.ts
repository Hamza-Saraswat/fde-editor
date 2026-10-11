// File responses for /media/:slug/* (and the built UI): content types, ETag revalidation and HTTP
// Range requests (the browser's <video> seeks with them). Paths are confined to a root folder.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";

export const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".srt": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export const contentType = (file: string) => CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

/** Absolute path of `rel` inside `root`, or null when it would escape it (../, absolute paths). */
export function safeResolve(root: string, rel: string): string | null {
  const base = resolve(root);
  if (rel.includes("\0")) return null;
  const abs = resolve(base, rel);
  return abs.startsWith(base + sep) ? abs : null;
}

export type ByteRange = { start: number; end: number }; // inclusive

/** Parse a Range header against a file size: null = serve the whole file, "unsatisfiable" = 416. Only the first range is honoured. */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.split(",")[0] ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export type SendFileOptions = { cacheControl?: string };

/** Respond with a file (404 if it is not a regular file). Supports Range, If-Range, If-None-Match and HEAD. */
export async function sendFile(c: Context, file: string, opts: SendFileOptions = {}): Promise<Response> {
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return c.json({ error: "Not found" }, 404);
  const size = st.size;
  const etag = `W/"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "Content-Type": contentType(file),
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Last-Modified": st.mtime.toUTCString(),
    "Cache-Control": opts.cacheControl ?? "no-cache",
  };
  const ifRange = c.req.header("if-range");
  const range = ifRange && ifRange !== etag ? null : parseRange(c.req.header("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  if (!range && c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const head = c.req.method === "HEAD";
  const body = (start: number, end: number) =>
    head || size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>);
  if (range) {
    return new Response(body(range.start, range.end), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(range.end - range.start + 1) },
    });
  }
  return new Response(body(0, size - 1), { status: 200, headers: { ...headers, "Content-Length": String(size) } });
}
