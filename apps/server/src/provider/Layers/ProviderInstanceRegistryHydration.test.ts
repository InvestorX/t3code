import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("synthesizes a disabled default instance for instance-native drivers", () => {
    const instances = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    const hermes = instances[ProviderInstanceId.make("hermes")];

    expect(hermes).toEqual({
      driver: ProviderDriverKind.make("hermes"),
      enabled: false,
      config: {
        enabled: true,
        binaryPath: "hermes",
      },
    });
  });

  it("preserves an explicit Hermes provider instance instead of synthesizing defaults", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        [ProviderInstanceId.make("hermes")]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: true,
          config: {
            enabled: true,
            binaryPath: "/opt/hermes/bin/hermes",
          },
        },
      },
    };

    const instances = deriveProviderInstanceConfigMap(settings);

    expect(instances[ProviderInstanceId.make("hermes")]).toEqual({
      driver: ProviderDriverKind.make("hermes"),
      enabled: true,
      config: {
        enabled: true,
        binaryPath: "/opt/hermes/bin/hermes",
      },
    });
  });
});
