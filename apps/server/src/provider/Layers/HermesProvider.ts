import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import {
  HERMES_DEFAULT_MODEL,
  makeHermesAcpRuntime,
} from "../acp/HermesAcpSupport.ts";
import type { HermesSettings } from "../HermesSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DRIVER = ProviderDriverKind.make("hermes");
const PROBE_TIMEOUT = "8 seconds";
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

const DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: HERMES_DEFAULT_MODEL,
    name: "Hermes Default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const PRESENTATION = {
  displayName: "Hermes",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
} as const;

function withTextGenerationFlag(snapshot: ServerProviderDraft): ServerProviderDraft {
  return { ...snapshot, supportsTextGeneration: false };
}

export function makeHermesProvider(input: {
  readonly settings: HermesSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto["Service"];
  readonly stampIdentity: (snapshot: ServerProviderDraft) => ServerProvider;
}) {
  const initialSnapshot = Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return input.stampIdentity(
      withTextGenerationFlag(
        buildServerProvider({
          presentation: PRESENTATION,
          enabled: input.settings.enabled,
          checkedAt,
          models: DEFAULT_MODELS,
          slashCommands: [COMPACT_SLASH_COMMAND],
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: input.settings.enabled
              ? "Checking Hermes ACP availability."
              : "Hermes is disabled in T3 Code settings.",
          },
        }),
      ),
    );
  });

  const checkProvider = Effect.gen(function* () {
    if (!input.settings.enabled) return yield* initialSnapshot;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const probe = yield* makeHermesAcpRuntime({
      hermesSettings: input.settings,
      environment: input.environment,
      childProcessSpawner: input.childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    }).pipe(
      Effect.flatMap((runtime) => runtime.initialize()),
      Effect.provideService(Crypto.Crypto, input.crypto),
      Effect.scoped,
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.result,
    );

    if (Result.isFailure(probe)) {
      return input.stampIdentity(
        withTextGenerationFlag(
          buildServerProvider({
            presentation: PRESENTATION,
            enabled: true,
            checkedAt,
            models: DEFAULT_MODELS,
            slashCommands: [COMPACT_SLASH_COMMAND],
            probe: {
              installed: false,
              version: null,
              status: "error",
              auth: { status: "unknown" },
              message: "Hermes Agent is not installed or `hermes acp` could not initialize.",
            },
          }),
        ),
      );
    }

    if (Option.isNone(probe.success)) {
      return input.stampIdentity(
        withTextGenerationFlag(
          buildServerProvider({
            presentation: PRESENTATION,
            enabled: true,
            checkedAt,
            models: DEFAULT_MODELS,
            slashCommands: [COMPACT_SLASH_COMMAND],
            probe: {
              installed: true,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "Hermes Agent is installed but ACP initialize timed out.",
            },
          }),
        ),
      );
    }

    const initialized = probe.success.value;
    return input.stampIdentity(
      withTextGenerationFlag(
        buildServerProvider({
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models: DEFAULT_MODELS,
          slashCommands: [COMPACT_SLASH_COMMAND],
          probe: {
            installed: true,
            version: initialized.agentInfo?.version || null,
            status: "ready",
            // `initialize` deliberately does not start Hermes' terminal setup flow.
            // Session start performs the advertised `hermes-setup` authentication.
            auth: { status: "unknown" },
          },
        }),
      ),
    );
  });

  return makeManagedServerProvider({
    resolveMaintenance: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null }),
      ),
    getSettings: Effect.succeed(input.settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => initialSnapshot,
    checkProvider,
  });
}

export type HermesProviderEnv = BackgroundPolicy.BackgroundPolicy | ServerSettingsService;
