// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";

import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ApprovalRequestId,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import {
  AntigravityDelegateFailedError,
  AntigravityDelegateHermesOnlyError,
  AntigravityDelegateParentSessionNotFoundError,
  AntigravityDelegateProviderUnavailableError,
  AntigravityDelegateToolkit,
} from "./tools.ts";

const HERMES = ProviderDriverKind.make("hermes");
const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const DEFAULT_ANTIGRAVITY_INSTANCE = defaultInstanceIdForDriver(ANTIGRAVITY);
const MAX_RESPONSE_CHARS = 100_000;
const DELEGATE_TIMEOUT = "10 minutes";
const EVENT_DRAIN_GRACE = "2 seconds";

function appendBounded(current: string, delta: string): string {
  if (current.length >= MAX_RESPONSE_CHARS || delta.length === 0) return current;
  const available = MAX_RESPONSE_CHARS - current.length;
  return current + delta.slice(0, available);
}

function failureDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  return AntigravityDelegateToolkit.of({
    antigravity_delegate: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const invocation = yield* McpInvocationContext.McpInvocationContext;
          const parent = yield* instances.getInstance(invocation.providerInstanceId);
          if (!parent || parent.driverKind !== HERMES) {
            return yield* new AntigravityDelegateHermesOnlyError({});
          }

          const parentSessions = yield* parent.adapter.listSessions();
          const parentSession = parentSessions.find(
            (session) => session.threadId === invocation.threadId,
          );
          if (!parentSession?.cwd) {
            return yield* new AntigravityDelegateParentSessionNotFoundError({});
          }

          const targetInstanceId = input.providerInstanceId ?? DEFAULT_ANTIGRAVITY_INSTANCE;
          const target = yield* instances.getInstance(targetInstanceId);
          if (!target || target.driverKind !== ANTIGRAVITY || !target.enabled) {
            return yield* new AntigravityDelegateProviderUnavailableError({
              providerInstanceId: targetInstanceId,
            });
          }

          const model = input.model ?? ANTIGRAVITY_DEFAULT_MODEL;
          const modelSelection = { instanceId: target.instanceId, model } as const;
          const syntheticThreadId = ThreadId.make(
            `hermes-antigravity-delegate-${randomUUID()}`,
          );
          const response = yield* Ref.make("");
          const deniedApprovals = yield* Ref.make<ReadonlyArray<string>>([]);
          const turnCompleted = yield* Deferred.make<void>();
          let sessionStarted = false;

          const stopSyntheticSession = Effect.suspend(() =>
            sessionStarted
              ? target.adapter.stopSession(syntheticThreadId).pipe(Effect.ignore)
              : Effect.void,
          );

          const collectEvent = (event: Parameters<Parameters<typeof Stream.runForEach>[1]>[0]) => {
            if (event.threadId !== syntheticThreadId) return Effect.void;
            if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
              return Ref.update(response, (current) => appendBounded(current, event.payload.delta));
            }
            if (event.type === "request.opened" && event.requestId) {
              const requestId = ApprovalRequestId.make(String(event.requestId));
              const detail = `${event.payload.requestType}: ${event.payload.detail}`;
              return Ref.update(deniedApprovals, (current) => [...current, detail]).pipe(
                Effect.andThen(
                  target.adapter
                    .respondToRequest(syntheticThreadId, requestId, "decline")
                    .pipe(Effect.ignore),
                ),
              );
            }
            if (event.type === "turn.completed") {
              return Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
            }
            return Effect.void;
          };

          // Subscribe before the synthetic session starts so permission and
          // assistant events cannot be emitted before the delegate listens.
          yield* target.adapter.streamEvents.pipe(
            Stream.runForEach(collectEvent),
            Effect.forkScoped,
          );
          yield* Effect.yieldNow();

          const delegated = Effect.gen(function* () {
            yield* target.adapter
              .startSession({
                threadId: syntheticThreadId,
                provider: ANTIGRAVITY,
                providerInstanceId: target.instanceId,
                cwd: parentSession.cwd,
                runtimeMode: parentSession.runtimeMode,
                modelSelection,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AntigravityDelegateFailedError({
                      detail: `Could not start Antigravity: ${failureDetail(cause)}`,
                      cause,
                    }),
                ),
              );
            sessionStarted = true;

            const turn = yield* target.adapter
              .sendTurn({
                threadId: syntheticThreadId,
                input: input.task,
                modelSelection,
              })
              .pipe(
                Effect.timeoutOption(DELEGATE_TIMEOUT),
                Effect.mapError(
                  (cause) =>
                    new AntigravityDelegateFailedError({
                      detail: failureDetail(cause),
                      cause,
                    }),
                ),
              );
            if (Option.isNone(turn)) {
              return yield* new AntigravityDelegateFailedError({
                detail: `Timed out after ${DELEGATE_TIMEOUT}.`,
              });
            }

            // sendTurn normally drains the provider runtime before returning;
            // this short wait only lets the adapter's public PubSub consumer
            // observe the final completion/delta events before we stop it.
            yield* Deferred.await(turnCompleted).pipe(
              Effect.timeoutOption(EVENT_DRAIN_GRACE),
              Effect.ignore,
            );
          }).pipe(Effect.ensuring(stopSyntheticSession));

          yield* delegated;
          const text = yield* Ref.get(response);
          const denied = yield* Ref.get(deniedApprovals);
          return {
            providerInstanceId: target.instanceId,
            model,
            response:
              text ||
              (denied.length > 0
                ? "Antigravity requested additional approval. The delegate declined it to avoid escalating the parent Hermes session's permissions."
                : "Antigravity completed without a textual response."),
            approvalDenied: denied.length > 0,
            deniedApprovals: [...denied],
          };
        }),
      ),
  });
});

export const AntigravityDelegateToolkitHandlersLive = AntigravityDelegateToolkit.toLayer(make);
