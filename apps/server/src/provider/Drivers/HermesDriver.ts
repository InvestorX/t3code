import { ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeHermesTextGeneration } from "../../textGeneration/HermesTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { ensureHermesAntigravityPlugin } from "../HermesAntigravityPluginInstaller.ts";
import { HermesSettings } from "../HermesSettings.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import { makeHermesProvider } from "../Layers/HermesProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER = ProviderDriverKind.make("hermes");
const decodeSettings = Schema.decodeSync(HermesSettings);

export type HermesDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const settings = { ...config, enabled } satisfies HermesSettings;

      if (settings.enabled) {
        yield* ensureHermesAntigravityPlugin(processEnv).pipe(
          Effect.tap((result) =>
            result.status === "skipped-user-managed"
              ? Effect.logInfo(
                  "Hermes antigravity-cli plugin is user-managed; leaving it unchanged.",
                  { pluginDirectory: result.pluginDirectory },
                )
              : Effect.logDebug("Hermes antigravity-cli plugin prepared.", {
                  status: result.status,
                  pluginDirectory: result.pluginDirectory,
                }),
          ),
          // Hermes itself remains usable even when its optional bundled model
          // provider cannot be materialized (read-only home, policy, etc.).
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to prepare bundled Hermes antigravity-cli plugin.", {
              cause,
            }),
          ),
        );
      }

      const providerController = yield* makeHermesProvider({
        settings,
        environment: processEnv,
        childProcessSpawner: spawner,
        crypto,
        stampIdentity,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Failed to build Hermes provider snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const adapter = yield* makeHermesAdapter({
        instanceId,
        settings,
        environment: processEnv,
        onSessionStarted: (started) => providerController.observeSessionStarted(started),
      });
      const textGeneration = yield* makeHermesTextGeneration(settings, processEnv);

      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: providerController.provider,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
