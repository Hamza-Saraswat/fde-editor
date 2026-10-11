import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { createHttpClient, type ApiClient } from "./api.ts";
import { App } from "./components/App.tsx";

// ?mock=1 swaps the server for an in-memory fake (loaded on demand, so it stays out of the main bundle).
async function pickClient(): Promise<ApiClient> {
  if (new URLSearchParams(window.location.search).get("mock") === "1") {
    const { createMockClient } = await import("./dev/mock.ts");
    return createMockClient();
  }
  return createHttpClient();
}

void pickClient().then((client) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
});
