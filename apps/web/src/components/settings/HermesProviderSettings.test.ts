import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";

const HERMES = ProviderDriverKind.make("hermes");

describe("Hermes provider settings", () => {
  it("is available in the add-provider driver catalog", () => {
    const definition = DRIVER_OPTION_BY_VALUE[HERMES];

    expect(definition?.label).toBe("Hermes");
    expect(DRIVER_OPTIONS.some((option) => option.value === HERMES)).toBe(true);
  });

  it("keeps instance enablement on the envelope and exposes only the binary path", () => {
    const definition = DRIVER_OPTION_BY_VALUE[HERMES];
    expect(definition).toBeDefined();
    if (!definition) return;

    const fields = deriveProviderSettingsFields(definition);

    expect(fields.map((field) => field.key)).toEqual(["binaryPath"]);
    expect(fields[0]?.label).toBe("Hermes binary");
  });
});
