import { createHash } from "node:crypto";
import { homedir } from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { loadHermesAntigravityPluginBundle } from "./HermesAntigravityPluginBundle.ts";

const PLUGIN_ID = "google-antigravity";
const MANAGED_MARKER = ".t3code-managed.json";

export type HermesAntigravityPluginInstallStatus =
  | "installed"
  | "updated"
  | "current"
  | "skipped-user-managed";

export interface HermesAntigravityPluginInstallResult {
  readonly status: HermesAntigravityPluginInstallStatus;
  readonly pluginDirectory: string;
}

export function resolveHermesHome(
  path: Path.Path["Service"],
  environment: NodeJS.ProcessEnv,
): string {
  const configured = environment.HERMES_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".hermes");
}

/**
 * Materialize T3's bundled Hermes model-provider plugin into the active
 * HERMES_HOME. A pre-existing plugin without T3's marker is user-owned and is
 * never overwritten. Once T3 creates the marker, later T3 builds may update
 * the managed files when their content hash changes.
 */
export const ensureHermesAntigravityPlugin = Effect.fn(
  "ensureHermesAntigravityPlugin",
)(function* (environment: NodeJS.ProcessEnv = process.env) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bundle = yield* loadHermesAntigravityPluginBundle();

  const hermesHome = resolveHermesHome(path, environment);
  const pluginDirectory = path.join(
    hermesHome,
    "plugins",
    "model-providers",
    PLUGIN_ID,
  );
  const pythonPath = path.join(pluginDirectory, "__init__.py");
  const manifestPath = path.join(pluginDirectory, "plugin.yaml");
  const markerPath = path.join(pluginDirectory, MANAGED_MARKER);

  const [pythonExists, manifestExists, markerExists] = yield* Effect.all([
    fs.exists(pythonPath),
    fs.exists(manifestPath),
    fs.exists(markerPath),
  ]);

  // Respect an existing out-of-tree plugin. The marker is the ownership
  // boundary; merely sharing the same provider id never grants T3 permission
  // to overwrite user code.
  if ((pythonExists || manifestExists) && !markerExists) {
    return {
      status: "skipped-user-managed",
      pluginDirectory,
    } satisfies HermesAntigravityPluginInstallResult;
  }

  const digest = createHash("sha256")
    .update(bundle.python, "utf8")
    .update("\0", "utf8")
    .update(bundle.manifest, "utf8")
    .digest("hex");
  const markerContents = `${JSON.stringify(
    {
      schemaVersion: 1,
      managedBy: "t3code",
      plugin: PLUGIN_ID,
      sha256: digest,
    },
    null,
    2,
  )}\n`;

  if (pythonExists && manifestExists && markerExists) {
    const existingMarker = yield* fs
      .readFileString(markerPath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (existingMarker === markerContents) {
      return {
        status: "current",
        pluginDirectory,
      } satisfies HermesAntigravityPluginInstallResult;
    }
  }

  yield* fs.makeDirectory(pluginDirectory, { recursive: true });
  yield* Effect.all(
    [
      writeFileStringAtomically({ filePath: pythonPath, contents: bundle.python }),
      writeFileStringAtomically({ filePath: manifestPath, contents: bundle.manifest }),
    ],
    { concurrency: "unbounded" },
  );
  yield* writeFileStringAtomically({ filePath: markerPath, contents: markerContents });

  return {
    status: markerExists ? "updated" : "installed",
    pluginDirectory,
  } satisfies HermesAntigravityPluginInstallResult;
});
