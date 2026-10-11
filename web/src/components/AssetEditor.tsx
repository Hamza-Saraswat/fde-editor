// B-roll screenshots for a cue: attach (upload or pick an existing one), then draw crop / blur /
// highlight boxes on it. Box changes save straight to the asset (PATCH), outside undo.
import { useRef, useState } from "react";
import type { Asset, Overlay, PatchAssetBody } from "../types.ts";
import { useApp } from "../state/app.tsx";
import { useProject } from "../state/ProjectProvider.tsx";
import { attachAsset, detachAsset } from "../lib/editOps.ts";
import { BoxEditor } from "./BoxEditor.tsx";
import { Icon } from "./Icon.tsx";

export function AssetEditor({ overlay: o }: { overlay: Overlay }) {
  const { client } = useApp();
  const { state, slug, dispatch, apply, notify, refresh } = useProject();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const all = state.bundle!.project.assets.filter((a) => a.kind === "image");
  const attached = all.filter((a) => a.cueId === o.cueId || o.assetIds.includes(a.id));
  const others = all.filter((a) => !attached.includes(a));
  const [currentId, setCurrentId] = useState<string | null>(attached[0]?.id ?? null);
  const current = attached.find((a) => a.id === currentId) ?? attached[0] ?? null;

  const fail = (e: unknown) => {
    notify(e instanceof Error ? e.message : String(e), "error");
    void refresh();
  };

  const attach = async (asset: Asset) => {
    dispatch({ type: "asset", asset: { ...asset, cueId: o.cueId } });
    apply((e) => attachAsset(e, o.id, asset.id));
    setCurrentId(asset.id);
    try {
      dispatch({ type: "asset", asset: await client.patchAsset(slug, asset.id, { cueId: o.cueId }) });
    } catch (e) {
      fail(e);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const asset = await client.uploadAsset(slug, file);
      dispatch({ type: "asset", asset });
      await attach(asset);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const detach = async (asset: Asset) => {
    const { cueId: _drop, ...rest } = asset;
    dispatch({ type: "asset", asset: rest as Asset });
    apply((e) => detachAsset(e, o.id, asset.id));
    setCurrentId(null);
    try {
      await client.patchAsset(slug, asset.id, { cueId: null });
    } catch (e) {
      fail(e);
    }
  };

  const patch = async (asset: Asset, body: PatchAssetBody) => {
    const next: Asset = { ...asset, blur: body.blur ?? asset.blur, highlight: body.highlight ?? asset.highlight };
    if (body.crop === null) delete next.crop;
    else if (body.crop) next.crop = body.crop;
    dispatch({ type: "asset", asset: next });
    try {
      dispatch({ type: "asset", asset: await client.patchAsset(slug, asset.id, body) });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section aria-labelledby={`assets-${o.id}`} className="grid gap-2.5 rounded-md border border-line p-2.5">
      <div className="flex items-center gap-2">
        <h3 id={`assets-${o.id}`} className="text-[12px] font-semibold text-ink-2">
          Screenshot
        </h3>
        <span className="ml-auto flex items-center gap-1.5">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            aria-label="Screenshot file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => fileInput.current?.click()}>
            <Icon name="image" size={13} />
            {busy ? "Uploading…" : "Attach screenshot"}
          </button>
        </span>
      </div>

      {others.length > 0 && (
        <select
          className="field w-full"
          aria-label="Use a screenshot already in this project"
          value=""
          onChange={(e) => {
            const a = others.find((x) => x.id === e.target.value);
            if (a) void attach(a);
          }}
        >
          <option value="">Use a screenshot already in this project…</option>
          {others.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.cueId ? ` (on ${a.cueId})` : ""}
            </option>
          ))}
        </select>
      )}

      {attached.length > 1 && (
        <div role="tablist" aria-label="Attached screenshots" className="seg">
          {attached.map((a) => (
            <button key={a.id} type="button" role="tab" aria-selected={current?.id === a.id} onClick={() => setCurrentId(a.id)}>
              {a.name}
            </button>
          ))}
        </div>
      )}

      {current ? (
        <>
          <BoxEditor asset={current} src={client.mediaUrl(slug, current.file)} onPatch={(body) => void patch(current, body)} />
          <div className="flex items-center gap-2">
            <span className="meta min-w-0 flex-1 truncate" title={current.name}>
              {current.name}, {current.width}×{current.height}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void detach(current)}>
              Detach
            </button>
          </div>
        </>
      ) : (
        <p className="meta">Attach the screenshot this cue shows. Then crop out identifying lines, blur names, and highlight what you talk about.</p>
      )}
    </section>
  );
}
