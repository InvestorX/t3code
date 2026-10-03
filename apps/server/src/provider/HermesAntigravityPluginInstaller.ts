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

export type HermesAntigravityPluginInstallAction =
  | "write"
  | "current"
  | "skip-user-managed";

interface HermesPathOps {
  readonly resolve: (...segments: ReadonlyArray<string>) => string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}

export function resolveHermesHome(
  path: HermesPathOps,
  environment: NodeJS.ProcessEnv,
): string {
  const configured = environment.HERMES_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".hermes");
}

export function resolveHermesAntigravityPluginInstallAction(input: {
  readonly pythonExists: boolean;
  readonly manifestExists: boolean;
  readonly markerExists: boolean;
  readonly existingMarker: string;
  readonly desiredMarker: string;
}): HermesAntigravityPluginInstallAction {
  if ((input.pythonExists || input.manifestExists) && !input.markerExists) {
    return "skip-user-managed";
  }
  if (
    input.pythonExists &&
    input.manifestExists &&
    input.markerExists &&
    input.existingMarker === input.desiredMarker
  ) {
    return "current";
  }
  return "write";
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
  const existingMarker = markerExists
    ? yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""))
    : "";

  const action = resolveHermesAntigravityPluginInstallAction({
    pythonExists,
    manifestExists,
    markerExists,
    existingMarker,
    desiredMarker: markerContents,
  });
  if (action === "skip-user-managed") {
    return {
      status: "skipped-user-managed",
      pluginDirectory,
    } satisfies HermesAntigravityPluginInstallResult;
  }
  if (action === "current") {
    return {
      status: "current",
      pluginDirectory,
    } satisfies HermesAntigravityPluginInstallResult;
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
