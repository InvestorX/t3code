import { describe, expect, it } from "vite-plus/test";

import { resolveHermesAntigravityPluginInstallAction } from "./HermesAntigravityPluginInstaller.ts";

describe("resolveHermesAntigravityPluginInstallAction", () => {
  it("never overwrites an unmarked user plugin", () => {
    expect(
      resolveHermesAntigravityPluginInstallAction({
        pythonExists: true,
        manifestExists: true,
        markerExists: false,
        existingMarker: "",
        desiredMarker: "managed-v1",
      }),
    ).toBe("skip-user-managed");
  });

  it("treats an unchanged T3-managed plugin as current", () => {
    expect(
      resolveHermesAntigravityPluginInstallAction({
        pythonExists: true,
        manifestExists: true,
        markerExists: true,
        existingMarker: "managed-v1",
        desiredMarker: "managed-v1",
      }),
    ).toBe("current");
  });

  it("updates a T3-managed plugin when its bundled content changes", () => {
    expect(
      resolveHermesAntigravityPluginInstallAction({
        pythonExists: true,
        manifestExists: true,
        markerExists: true,
        existingMarker: "managed-v1",
        desiredMarker: "managed-v2",
      }),
    ).toBe("write");
  });

  it("repairs a partially missing T3-managed plugin", () => {
    expect(
      resolveHermesAntigravityPluginInstallAction({
        pythonExists: false,
        manifestExists: true,
        markerExists: true,
        existingMarker: "managed-v1",
        desiredMarker: "managed-v1",
      }),
    ).toBe("write");
  });
});
