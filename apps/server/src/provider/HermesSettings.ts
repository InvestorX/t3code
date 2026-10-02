import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Driver-local configuration for Hermes Agent.
 *
 * Hermes is intentionally instance-only for now: we do not add another
 * legacy `settings.providers.*` field. The provider registry can still
 * materialize the default disabled instance and explicit `providerInstances`
 * entries can override this configuration.
 */
export const HermesSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  binaryPath: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("hermes"))),
});

export type HermesSettings = typeof HermesSettings.Type;
