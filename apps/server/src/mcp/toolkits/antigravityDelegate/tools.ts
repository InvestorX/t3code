import {
  ProviderInstanceId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProviderInstanceRegistry.ProviderInstanceRegistry,
];

export const AntigravityDelegateInput = Schema.Struct({
  task: TrimmedNonEmptyString.annotate({
    description:
      "A self-contained task for the Antigravity coding agent. Include the goal, constraints, and expected result.",
  }),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Optional Antigravity model id. Omit to use the Antigravity provider's current/default model.",
    }),
  ),
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description:
        "Optional T3 Antigravity provider instance. Omit to use the default `antigravity` instance.",
    }),
  ),
});
export type AntigravityDelegateInput = typeof AntigravityDelegateInput.Type;

export class AntigravityDelegateHermesOnlyError extends Schema.TaggedError<AntigravityDelegateHermesOnlyError>()(
  "AntigravityDelegateHermesOnlyError",
  {},
) {
  override get message(): string {
    return "The Antigravity delegate is available only from a Hermes Agent session.";
  }
}

export class AntigravityDelegateParentSessionNotFoundError extends Schema.TaggedError<AntigravityDelegateParentSessionNotFoundError>()(
  "AntigravityDelegateParentSessionNotFoundError",
  {},
) {
  override get message(): string {
    return "The parent Hermes session is no longer active.";
  }
}

export class AntigravityDelegateProviderUnavailableError extends Schema.TaggedError<AntigravityDelegateProviderUnavailableError>()(
  "AntigravityDelegateProviderUnavailableError",
  { providerInstanceId: ProviderInstanceId },
) {
  override get message(): string {
    return `Antigravity provider instance '${this.providerInstanceId}' is unavailable or disabled.`;
  }
}

export class AntigravityDelegateFailedError extends Schema.TaggedError<AntigravityDelegateFailedError>()(
  "AntigravityDelegateFailedError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Antigravity delegation failed: ${this.detail}`;
  }
}

export const AntigravityDelegateToolError = Schema.Union([
  AntigravityDelegateHermesOnlyError,
  AntigravityDelegateParentSessionNotFoundError,
  AntigravityDelegateProviderUnavailableError,
  AntigravityDelegateFailedError,
]);
export type AntigravityDelegateToolError = typeof AntigravityDelegateToolError.Type;

export const AntigravityDelegateResult = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  response: Schema.String,
  approvalDenied: Schema.Boolean,
  deniedApprovals: Schema.Array(Schema.String),
});
export type AntigravityDelegateResult = typeof AntigravityDelegateResult.Type;

const AntigravityDelegateTool = Tool.make("antigravity_delegate", {
  description:
    "Delegate a focused coding or repository task to T3 Code's configured Antigravity agent and return its response. The delegated session uses the same workspace and never receives this MCP toolkit, so it cannot recursively delegate. It inherits the parent Hermes runtime access mode; any additional approval request that still reaches T3 is declined rather than silently escalating permissions.",
  parameters: AntigravityDelegateInput,
  success: AntigravityDelegateResult,
  failure: AntigravityDelegateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate to Antigravity")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const AntigravityDelegateToolkit = Toolkit.make(AntigravityDelegateTool);
