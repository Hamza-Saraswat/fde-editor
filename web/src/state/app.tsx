// App-wide context: the API client, server health and config.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { ApiClient } from "../api.ts";
import type { Config, Health } from "../types.ts";

type AppCtx = {
  client: ApiClient;
  health: Health | null;
  healthError: string | null;
  config: Config | null;
  refreshHealth: () => void;
};

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);

  const refreshHealth = useCallback(() => {
    client.health().then(
      (h) => {
        setHealth(h);
        setHealthError(null);
      },
      (e: unknown) => setHealthError(e instanceof Error ? e.message : String(e)),
    );
  }, [client]);

  useEffect(() => {
    refreshHealth();
    client.config().then(setConfig, () => setConfig(null));
  }, [client, refreshHealth]);

  return <Ctx.Provider value={{ client, health, healthError, config, refreshHealth }}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}
