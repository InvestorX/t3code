import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Driver configuration shared by the server registry and provider settings UI.
 *
 * `enabled` defaults to true inside the decoded config because the canonical
 * on/off switch for instance-native providers is the ProviderInstanceConfig
 * envelope. The server synthesizes Hermes' built-in default slot with an
 * explicit envelope-level `enabled: false`, so Hermes remains opt-in while an
 * explicitly enabled instance is not accidentally disabled again by schema
 * defaults during decode.
 */
export const HermesSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  binaryPath: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("hermes")),
    Schema.annotateKey({
      title: "Hermes binary",
      description: "Executable used to launch `hermes acp`. Leave as `hermes` when it is on PATH.",
    }),
  ),
});

export type HermesSettings = typeof HermesSettings.Type;
