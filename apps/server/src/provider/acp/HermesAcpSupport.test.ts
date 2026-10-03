import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  HERMES_DEFAULT_MODEL,
  applyHermesAcpSessionSelection,
  buildHermesAcpSpawnInput,
  hermesPermissionMode,
} from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("builds the default Hermes ACP command", () => {
    expect(
      buildHermesAcpSpawnInput({ binaryPath: "hermes" }, "/tmp/project"),
    ).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses a configured Hermes binary and forwards environment", () => {
    const env = { HERMES_HOME: "/tmp/hermes-home" };
    expect(
      buildHermesAcpSpawnInput(
        { binaryPath: "/opt/hermes/bin/hermes" },
        "/tmp/project",
        env,
      ),
    ).toEqual({
      command: "/opt/hermes/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env,
    });
  });
});

describe("hermesPermissionMode", () => {
  it("keeps approval-required and auto conservative", () => {
    expect(hermesPermissionMode("approval-required")).toBe("default");
    expect(hermesPermissionMode("auto")).toBe("default");
  });

  it("maps edit and full-access modes onto Hermes ACP modes", () => {
    expect(hermesPermissionMode("auto-accept-edits")).toBe("accept_edits");
    expect(hermesPermissionMode("full-access")).toBe("dont_ask");
  });
});

describe("applyHermesAcpSessionSelection", () => {
  it("does not send the T3 product default slug to Hermes ACP", async () => {
    const calls: Array<{ type: "mode" | "model"; value: string }> = [];
    const runtime = {
      setMode: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "mode", value });
        }),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
    };

    await Effect.runPromise(
      applyHermesAcpSessionSelection({
        runtime,
        runtimeMode: "approval-required",
        model: HERMES_DEFAULT_MODEL,
        mapError: (cause) => cause,
      }),
    );

    expect(calls).toEqual([{ type: "mode", value: "default" }]);
  });

  it("switches to an explicit Hermes ACP model after applying the mode", async () => {
    const calls: Array<{ type: "mode" | "model"; value: string }> = [];
    const runtime = {
      setMode: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "mode", value });
        }),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
    };

    await Effect.runPromise(
      applyHermesAcpSessionSelection({
        runtime,
        runtimeMode: "full-access",
        model: "openrouter:anthropic/claude-sonnet-4.6",
        mapError: (cause) => cause,
      }),
    );

    expect(calls).toEqual([
      { type: "mode", value: "dont_ask" },
      { type: "model", value: "openrouter:anthropic/claude-sonnet-4.6" },
    ]);
  });
});
