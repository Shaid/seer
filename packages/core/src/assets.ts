/**
 * Generic runtime asset loader — fetch preprocessed JSON (and optionally
 * binary) assets produced by the offline pipeline (@seer-project/pipeline) at
 * runtime, in the browser.
 *
 * This deliberately lives in @seer-project/core (browser-safe, zero deps) rather
 * than @seer-project/pipeline (Node-only — uses node:fs, never imported by
 * browser-bundled code, see docs/architecture-overview.md §8). Bundling
 * this loader together with pipeline's Node-only code would pull fs/pngjs
 * into the browser build the moment a consumer's runtime code calls it.
 *
 * Two entry points:
 *   - `loadAssets(basePath, schema)` — one-shot: define a schema, get typed
 *     assets back. Simple and direct.
 *   - `createAssetLoader(basePath)` — factory: returns a reusable loader
 *     function. Useful when you want to load several asset sets from the
 *     same base path, or when you need the loader to be configurable
 *     (e.g. different base paths per game/platform at runtime).
 *
 * JSON files (*.json) are auto-parsed. Other extensions are fetched as raw
 * text — register custom handlers in the consumer layer for textures,
 * binary data, etc.
 *
 * Browser-safe: uses globalThis.fetch, no Node built-ins.
 */

/** A schema maps asset keys to their file paths (relative to basePath). */
export type AssetSchema = Record<string, string>;

/**
 * Infers the loaded type from a schema: each `.json` path becomes `unknown`
 * (cast to the consumer's own type at the call site); other extensions
 * become `string`. The consumer specifies the concrete return type.
 */
export type InferredAssets<S extends AssetSchema> = {
  [K in keyof S]: S[K] extends `${string}.json` ? unknown : string;
};

async function fetchAsset(basePath: string, path: string): Promise<unknown | string> {
  const url = `${basePath}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  if (path.endsWith('.json')) return res.json();
  return res.text();
}

/**
 * One-shot asset loader. Define a schema mapping asset keys to file paths,
 * and get a typed object back.
 *
 * @example
 * ```ts
 * interface MyAssets { atlas: { cellWidth: number }; map: { cols: number } }
 * const assets = await loadAssets<MyAssets>('/assets/game1/amiga', {
 *   atlas: 'atlas.json',
 *   map:   'map.json',
 * });
 * // assets.atlas is typed as MyAssets['atlas']
 * ```
 */
export async function loadAssets<T extends object>(
  basePath: string,
  schema: { [K in keyof T]: string },
): Promise<T> {
  const keys = Object.keys(schema) as (keyof T)[];
  const entries = await Promise.all(
    keys.map(async (key) => {
      const value = await fetchAsset(basePath, schema[key] as string);
      return [key, value] as const;
    }),
  );
  return Object.fromEntries(entries) as T;
}

/**
 * Create a reusable loader bound to a base path. Call the returned function
 * with a schema to load that set of assets.
 *
 * @example
 * ```ts
 * const load = createAssetLoader('/assets/game1/amiga');
 * const manifests = await load<{ atlas: AtlasMeta }>({ atlas: 'atlas.json' });
 * ```
 */
export function createAssetLoader(basePath: string) {
  return <T extends object>(schema: { [K in keyof T]: string }): Promise<T> =>
    loadAssets<T>(basePath, schema);
}
