import type { ApiClient } from "../api.ts";
import { navigate, useRoute } from "../lib/router.ts";
import { AppProvider } from "../state/app.tsx";
import { ProjectsScreen } from "./ProjectsScreen.tsx";
import { ProjectScreen } from "./ProjectScreen.tsx";

export function App({ client }: { client: ApiClient }) {
  const route = useRoute();
  return (
    <AppProvider client={client}>
      {route.name === "projects" && <ProjectsScreen />}
      {route.name === "project" && <ProjectScreen key={route.slug} slug={route.slug} />}
      {route.name === "missing" && (
        <main className="grid h-full place-items-center">
          <div className="text-center">
            <p className="text-ink-2">Nothing lives at {route.path}.</p>
            <button type="button" className="btn mt-3" onClick={() => navigate("/")}>
              Go to projects
            </button>
          </div>
        </main>
      )}
    </AppProvider>
  );
}
