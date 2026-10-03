import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// vite-plus replaces these identifiers in bundled/npm/SEA builds. `typeof`
// keeps source-mode `node --watch src/bin.ts` safe when no bundler define exists.
declare const __T3CODE_HERMES_ANTIGRAVITY_PLUGIN_PY__: string;
declare const __T3CODE_HERMES_ANTIGRAVITY_PLUGIN_YAML__: string;

const embeddedPython =
  typeof __T3CODE_HERMES_ANTIGRAVITY_PLUGIN_PY__ === "string"
    ? __T3CODE_HERMES_ANTIGRAVITY_PLUGIN_PY__
    : undefined;
const embeddedManifest =
  typeof __T3CODE_HERMES_ANTIGRAVITY_PLUGIN_YAML__ === "string"
    ? __T3CODE_HERMES_ANTIGRAVITY_PLUGIN_YAML__
    : undefined;

export interface HermesAntigravityPluginBundle {
  readonly python: string;
  readonly manifest: string;
}

/**
 * Return the plugin sources embedded by the production build. Source-mode
 * development falls back to the canonical files under repo-level
 * `integrations/hermes/google-antigravity/` so there is only one Python source
 * of truth.
 */
export const loadHermesAntigravityPluginBundle = Effect.fn(
  "loadHermesAntigravityPluginBundle",
)(function* (): Effect.fn.Return<
  HermesAntigravityPluginBundle,
  FileSystem.PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  if (embeddedPython !== undefined && embeddedManifest !== undefined) {
    return { python: embeddedPython, manifest: embeddedManifest };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const integrationDirectory = path.fromFileUrl(
    new URL("../../../../integrations/hermes/google-antigravity/", import.meta.url),
  );
  const [python, manifest] = yield* Effect.all([
    fs.readFileString(path.join(integrationDirectory, "__init__.py")),
    fs.readFileString(path.join(integrationDirectory, "plugin.yaml")),
  ]);
  return { python, manifest };
});
