import { describe, expect, it } from "vite-plus/test";

import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { buildHermesModelsFromSessionStart } from "./HermesProvider.ts";

function startedWithModels(
  availableModels: ReadonlyArray<{ readonly modelId: string; readonly name: string }>,
  currentModelId = availableModels[0]?.modelId ?? "",
): AcpSessionRuntimeStartResult {
  return {
    sessionId: "hermes-session",
    initializeResult: {},
    sessionSetupResult: {
      sessionId: "hermes-session",
      models: {
        currentModelId,
        availableModels,
      },
    },
    modelConfigId: undefined,
  } as unknown as AcpSessionRuntimeStartResult;
}

describe("buildHermesModelsFromSessionStart", () => {
  it("keeps Hermes Default first and exposes provider-qualified live inventory", () => {
    const models = buildHermesModelsFromSessionStart(
      startedWithModels([
        {
          modelId: "google-antigravity:gemini-3-flash-agent",
          name: "Gemini 3 Flash Agent",
        },
        {
          modelId: "openrouter:anthropic/claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
        },
      ]),
    );

    expect(models[0]).toMatchObject({
      slug: "hermes-default",
      name: "Hermes Default",
      isDefault: true,
    });
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "google-antigravity:gemini-3-flash-agent",
          name: "google-antigravity · Gemini 3 Flash Agent",
        }),
        expect.objectContaining({
          slug: "openrouter:anthropic/claude-sonnet-4.6",
          name: "openrouter · Claude Sonnet 4.6",
        }),
      ]),
    );
  });

  it("does not invent Antigravity rows when Hermes does not advertise them", () => {
    const models = buildHermesModelsFromSessionStart(
      startedWithModels([
        {
          modelId: "openrouter:openai/gpt-5.4",
          name: "GPT 5.4",
        },
      ]),
    );

    expect(models.some((model) => model.slug.startsWith("google-antigravity:"))).toBe(false);
    expect(models.map((model) => model.slug)).toEqual([
      "hermes-default",
      "openrouter:openai/gpt-5.4",
    ]);
  });

  it("falls back only to Hermes Default when no model inventory is available", () => {
    const models = buildHermesModelsFromSessionStart(startedWithModels([]));

    expect(models.map((model) => model.slug)).toEqual(["hermes-default"]);
  });

  it("deduplicates repeated model ids and ignores an advertised sentinel", () => {
    const models = buildHermesModelsFromSessionStart(
      startedWithModels([
        { modelId: "hermes-default", name: "Hermes Default" },
        { modelId: "google-antigravity:claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { modelId: "google-antigravity:claude-sonnet-4-6", name: "Duplicate" },
      ]),
    );

    expect(models.filter((model) => model.slug === "hermes-default")).toHaveLength(1);
    expect(models.filter((model) => model.slug === "google-antigravity:claude-sonnet-4-6")).toHaveLength(1);
  });
});
