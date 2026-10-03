import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import {
  HERMES_DEFAULT_MODEL,
  makeHermesAcpRuntime,
} from "../acp/HermesAcpSupport.ts";
import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import type { HermesSettings } from "../HermesSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const DRIVER = ProviderDriverKind.make("hermes");
const PROBE_TIMEOUT = "8 seconds";
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export const HERMES_ANTIGRAVITY_FALLBACK_MODEL_IDS = [
  "gemini-3-flash-agent",
  "gemini-3.5-flash-low",
  "gemini-pro-agent",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const;

const DEFAULT_MODEL: ServerProviderModel = {
  slug: HERMES_DEFAULT_MODEL,
  name: "Hermes Default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

const ANTIGRAVITY_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> =
  HERMES_ANTIGRAVITY_FALLBACK_MODEL_IDS.map((modelId) => ({
    slug: `google-antigravity:${modelId}`,
    name: `Google Antigravity · ${modelId}`,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  }));

const DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [
  DEFAULT_MODEL,
  ...ANTIGRAVITY_FALLBACK_MODELS,
];

const PRESENTATION = {
  displayName: "Hermes",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
} as const;

function withTextGenerationFlag(snapshot: ServerProviderDraft): ServerProviderDraft {
  return { ...snapshot, supportsTextGeneration: false };
}

function normalizeModelName(modelId: string, advertisedName: string): string {
  const name = advertisedName.trim() || modelId;
  if (name.includes(" · ")) return name;
  const separator = modelId.indexOf(":");
  if (separator <= 0) return name;
  const provider = modelId.slice(0, separator);
  return `${provider} · ${name}`;
}

/** Convert the authoritative model state from a real Hermes ACP session into T3 picker rows. */
export function buildHermesModelsFromSessionStart(
  started: AcpSessionRuntimeStartResult,
): ReadonlyArray<ServerProviderModel> {
  const modelState = started.sessionSetupResult.models;
  if (!modelState || modelState.availableModels.length === 0) {
    return DEFAULT_MODELS;
  }

  const seen = new Set<string>([HERMES_DEFAULT_MODEL]);
  const discovered: ServerProviderModel[] = [];
  for (const model of modelState.availableModels) {
    const slug = model.modelId.trim();
    if (!slug || slug === HERMES_DEFAULT_MODEL || seen.has(slug)) continue;
    seen.add(slug);
    discovered.push({
      slug,
      name: normalizeModelName(slug, model.name),
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }

  // Keep the bundled Antigravity fallback rows if the live Hermes inventory is
  // temporarily sparse. Matching slugs are de-duplicated in favour of Hermes'
  // advertised names.
  for (const fallback of ANTIGRAVITY_FALLBACK_MODELS) {
    if (seen.has(fallback.slug)) continue;
    seen.add(fallback.slug);
    discovered.push(fallback);
  }

  return [DEFAULT_MODEL, ...discovered];
}

function overlayModels(
  snapshot: ServerProvider,
  models: ReadonlyArray<ServerProviderModel>,
): ServerProvider {
  return Equal.equals(snapshot.models, models) ? snapshot : { ...snapshot, models };
}

export interface HermesProviderController {
  readonly provider: ServerProviderShape;
  readonly observeSessionStarted: (
    started: AcpSessionRuntimeStartResult,
  ) => Effect.Effect<void>;
}

export function makeHermesProvider(input: {
  readonly settings: HermesSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto["Service"];
  readonly stampIdentity: (snapshot: ServerProviderDraft) => ServerProvider;
}) {
  return Effect.gen(function* () {
    const discoveredModelsRef = yield* Ref.make<ReadonlyArray<ServerProviderModel>>(DEFAULT_MODELS);
    const modelChanges = yield* PubSub.unbounded<void>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(modelChanges));

    const currentModels = Ref.get(discoveredModelsRef);
    const initialSnapshot = Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const models = yield* currentModels;
      return input.stampIdentity(
        withTextGenerationFlag(
          buildServerProvider({
            presentation: PRESENTATION,
            enabled: input.settings.enabled,
            checkedAt,
            models,
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
      const models = yield* currentModels;
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
              models,
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
              models,
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
            models,
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

    const managed = yield* makeManagedServerProvider({
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

    const withCurrentModels = (snapshot: ServerProvider) =>
      Ref.get(discoveredModelsRef).pipe(Effect.map((models) => overlayModels(snapshot, models)));
    const getSnapshot = managed.getSnapshot.pipe(Effect.flatMap(withCurrentModels));

    const provider: ServerProviderShape = {
      resolveMaintenance: managed.resolveMaintenance,
      getSnapshot,
      refresh: managed.refresh.pipe(Effect.flatMap(withCurrentModels)),
      applyUsageLimits: managed.applyUsageLimits,
      get streamChanges() {
        const baseChanges = managed.streamChanges.pipe(Stream.mapEffect(withCurrentModels));
        const discoveredChanges = Stream.fromPubSub(modelChanges).pipe(
          Stream.mapEffect(() => getSnapshot),
        );
        return Stream.merge(baseChanges, discoveredChanges);
      },
    };

    const observeSessionStarted: HermesProviderController["observeSessionStarted"] = (started) =>
      Effect.gen(function* () {
        const nextModels = buildHermesModelsFromSessionStart(started);
        const changed = yield* Ref.modify(discoveredModelsRef, (previous) =>
          Equal.equals(previous, nextModels)
            ? [false, previous] as const
            : [true, nextModels] as const,
        );
        if (changed) yield* PubSub.publish(modelChanges, undefined);
      });

    return { provider, observeSessionStarted } satisfies HermesProviderController;
  });
}

export type HermesProviderEnv = BackgroundPolicy.BackgroundPolicy | ServerSettingsService;
