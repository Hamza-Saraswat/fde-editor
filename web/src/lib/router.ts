// Two routes, no library: "/" (projects) and "/p/:slug" (one project). Keeps ?mock=1 across navigation.
import { useSyncExternalStore } from "react";

export type Route = { name: "projects" } | { name: "project"; slug: string } | { name: "missing"; path: string };

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { name: "projects" };
  const m = /^\/p\/([^/]+)\/?$/.exec(pathname);
  if (m) return { name: "project", slug: decodeURIComponent(m[1]!) };
  return { name: "missing", path: pathname };
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
if (typeof window !== "undefined") window.addEventListener("popstate", notify);

export function navigate(path: string) {
  const url = path + window.location.search;
  if (url === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", url);
  notify();
}

export function useRoute(): Route {
  const path = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => window.location.pathname,
  );
  return parseRoute(path);
}

export const projectPath = (slug: string) => `/p/${encodeURIComponent(slug)}`;
