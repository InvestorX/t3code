import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  HERMES_DEFAULT_MODEL,
  applyHermesAcpSessionSelection,
  makeHermesAcpRuntime,
} from "../acp/HermesAcpSupport.ts";
import type { HermesSettings } from "../HermesSettings.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("hermes");
const RESUME_VERSION = 1 as const;

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface HermesSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  stopped: boolean;
}

export interface HermesAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: HermesSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
}

function parseResume(raw: unknown): { sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== RESUME_VERSION) return undefined;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return undefined;
  return { sessionId: value.sessionId.trim() };
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  const byId = (id: string) =>
    request.options.find((option) => option.optionId === id)?.optionId;
  const byKind = (...kinds: ReadonlyArray<string>) =>
    request.options.find((option) => kinds.includes(option.kind))?.optionId;

  switch (decision) {
    case "accept":
      return byId("allow_once") ?? byKind("allow_once") ?? byId("allow_session") ?? byKind("allow_always");
    case "acceptForSession":
      return (
        byId("allow_session") ??
        byId("allow_always") ??
        byKind("allow_always") ??
        byId("allow_once") ??
        byKind("allow_once")
      );
    case "acceptAlways":
      return (
        byId("allow_always") ??
        byId("allow_session") ??
        byKind("allow_always") ??
        byId("allow_once") ??
        byKind("allow_once")
      );
    case "decline":
      return byId("deny") ?? byId("deny_always") ?? byKind("reject_once", "reject_always");
    case "cancel":
      return undefined;
  }
}

function autoApprovePermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    request.options.find((option) => option.optionId === "allow_session")?.optionId ??
    request.options.find((option) => option.optionId === "allow_always")?.optionId ??
    request.options.find((option) => option.kind === "allow_always")?.optionId ??
    request.options.find((option) => option.optionId === "allow_once")?.optionId ??
    request.options.find((option) => option.kind === "allow_once")?.optionId
  );
}

export function makeHermesAdapter(options: HermesAdapterOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* ServerConfig;
    const sessions = new Map<ThreadId, HermesSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Hermes runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({ eventId: Effect.map(randomUUID, EventId.make), createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<HermesSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const settlePendingApprovals = (ctx: HermesSessionContext) =>
      Effect.forEach(
        ctx.pendingApprovals.values(),
        (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
        { discard: true },
      );

    const stopSessionInternal = (ctx: HermesSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovals(ctx);
        if (ctx.notificationFiber) yield* Fiber.interrupt(ctx.notificationFiber);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: Adapter["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) yield* stopSessionInternal(existing);

          const sessionScope = yield* Scope.make("sequential");
          let transferred = false;
          yield* Effect.addFinalizer(() =>
            transferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          let ctx!: HermesSessionContext;
          const resumeSessionId = parseResume(input.resumeCursor)?.sessionId;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const environment =
            options.environment || mcpSession?.agentDeviceEnvironment
              ? McpProviderSession.withAgentDeviceEnvironment(
                  options.environment ?? process.env,
                  mcpSession,
                )
              : undefined;

          const acp = yield* makeHermesAcpRuntime({
            hermesSettings: options.settings,
            childProcessSpawner: spawner,
            cwd,
            ...(environment ? { environment } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        { name: "Authorization", value: mcpSession.authorizationHeader },
                      ],
                    },
                  ],
                }
              : {}),
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );

          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              if (input.runtimeMode === "full-access") {
                const optionId = autoApprovePermissionOptionId(params);
                if (optionId) {
                  return { outcome: { outcome: "selected" as const, optionId } };
                }
              }

              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.make(yield* randomUUID);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              pendingApprovals.set(requestId, { decision });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail: permissionRequest.detail ?? "Hermes requests permission to continue.",
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision);
              pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              if (resolved === "cancel") return { outcome: { outcome: "cancelled" as const } };
              const optionId = selectPermissionOptionId(params, resolved);
              return optionId
                ? { outcome: { outcome: "selected" as const, optionId } }
                : { outcome: { outcome: "cancelled" as const } };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to process Hermes permission request.",
                    cause,
                  }),
              ),
            ),
          );

          const started = yield* acp.start().pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );

          const requestedModel =
            input.modelSelection?.instanceId === options.instanceId
              ? input.modelSelection.model
              : HERMES_DEFAULT_MODEL;
          yield* applyHermesAcpSessionSelection({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            model: requestedModel,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/configure", cause),
          });

          const timestamp = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: requestedModel,
            threadId: input.threadId,
            resumeCursor: { schemaVersion: RESUME_VERSION, sessionId: started.sessionId },
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            activeTurnId: undefined,
            promptsInFlight: 0,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                  case "ConfigOptionsUpdated":
                    return;
                  case "AvailableCommandsUpdated":
                    yield* (options.onAvailableCommands?.(event.availableCommands, cwd) ?? Effect.void);
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ThoughtDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ConnectionTerminated":
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Hermes runtime notification.", { cause }),
            ),
            Effect.forkIn(ctx.scope),
          );
          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          transferred = true;

          yield* options.onSessionStarted?.(started, cwd) ?? Effect.void;
          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Hermes ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: Adapter["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUID);
        ctx.promptsInFlight += 1;
        return yield* Effect.gen(function* () {
          const selectedModel =
            input.modelSelection?.instanceId === options.instanceId
              ? input.modelSelection.model
              : (ctx.session.model ?? HERMES_DEFAULT_MODEL);
          yield* applyHermesAcpSessionSelection({
            runtime: ctx.acp,
            runtimeMode: ctx.session.runtimeMode,
            model: selectedModel,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/configure", cause),
          });
          ctx.activeTurnId = turnId;
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            model: selectedModel,
            updatedAt: yield* nowIso,
          };
          if (!steeringTurnId) {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: selectedModel },
            });
          }

          const prompt: Array<EffectAcpSchema.ContentBlock> = [];
          const rawPrompt = input.input?.trim() ?? "";
          if (rawPrompt) prompt.push({ type: "text", text: rawPrompt });
          for (const attachment of input.attachments ?? []) {
            if (attachment.type !== "image") continue;
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            prompt.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
          if (prompt.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or image attachments.",
            });
          }
          if (!/^\/[^\s/]+(?:\s|$)/.test(rawPrompt)) {
            prompt.push({
              type: "text",
              text: buildRuntimeInstructions({ harness: "Hermes", model: selectedModel }),
            });
          }

          const result = yield* ctx.acp.prompt({ prompt }).pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause),
            ),
          );
          yield* ctx.acp.drainEvents;
          const turn = ctx.turns.find((entry) => entry.id === turnId);
          if (turn) turn.items.push({ prompt, result });
          else ctx.turns.push({ id: turnId, items: [{ prompt, result }] });

          if (ctx.promptsInFlight === 1) {
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason ?? null,
              },
            });
          }
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            }),
          ),
        );
      });

    const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovals(ctx);
        yield* ctx.acp.cancel.pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
          ),
        );
      });

    const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail: `Hermes structured user-input request '${requestId}' is not supported yet.`,
        });
      });

    const readThread: Adapter["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: Adapter["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Hermes ACP sessions do not expose provider-side rollback through T3 yet.",
        });
      });

    const stopSession: Adapter["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );
    const listSessions: Adapter["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
    const hasSession: Adapter["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });
    const stopAll: Adapter["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      compaction: { type: "slash-command", command: "/compress" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      readThread,
      rollbackThread,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies Adapter;
  });
}