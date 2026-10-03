import { HERMES_DEFAULT_MODEL, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type { HermesSettings } from "../HermesSettings.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export { HERMES_DEFAULT_MODEL };

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "resumeMethod" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: Pick<HermesSettings, "binaryPath">;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  settings: Pick<HermesSettings, "binaryPath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export function hermesPermissionMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "auto-accept-edits":
      return "accept_edits";
    case "full-access":
      return "dont_ask";
    case "auto":
    case "approval-required":
      return "default";
  }
}

export const makeHermesAcpRuntime = Effect.fn("makeHermesAcpRuntime")(function* (
  input: HermesAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
      authMethodId: "hermes-setup",
      resumeMethod: "resume",
      cancelBehavior: "wait-for-prompt",
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

export const applyHermesAcpSessionSelection = Effect.fn("applyHermesAcpSessionSelection")(
  function* <E>(input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "setMode" | "setModel"
    >;
    readonly runtimeMode: RuntimeMode;
    readonly model: string | null | undefined;
    readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  }): Effect.fn.Return<void, E> {
    yield* input.runtime
      .setMode(hermesPermissionMode(input.runtimeMode))
      .pipe(Effect.mapError(input.mapError));

    if (input.model && input.model !== HERMES_DEFAULT_MODEL) {
      yield* input.runtime.setModel(input.model).pipe(Effect.mapError(input.mapError));
    }
  },
);
