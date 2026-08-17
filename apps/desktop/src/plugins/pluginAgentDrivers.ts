import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentDriver,
  AgentEvent,
  AgentProbe,
  AgentSession,
  AgentSessionStartInput,
  PermissionDecision,
} from "../agents/AgentDriver";
import {
  PLUGIN_DRIVER_PROBE_TIMEOUT_MS,
  PLUGIN_HOST_METHODS,
  type PluginDriverAnswerPermissionParams,
  type PluginDriverAnswerUserInputParams,
  type PluginDriverPromptParams,
  type PluginDriverPromptResult,
  type PluginDriverProbeParams,
  type PluginDriverSessionParams,
  type PluginDriverSetModelParams,
  type PluginDriverStartSessionParams,
  type PluginDriverStartSessionResult,
} from "./pluginHostProtocol";
import { errorMessage, raceWithTimeout } from "./pluginShared";

/**
 * How many plugin-contributed drivers one workspace may register.
 *
 * dohc ships three drivers for two harnesses, and the BYOAI plan is one
 * plugin per harness: a person connecting Claude Code, Codex, and one harness
 * of their own registers three. Sixteen is several times that, and it is the
 * number that keeps the merged list inside the bound the agent panel's IPC
 * contract already carries (20 rows, three of them dohc's own). Registering
 * past it refuses the plugin rather than break the list every other driver is
 * shown in.
 */
export const MAX_WORKSPACE_PLUGIN_DRIVERS = 16;

// What the panel contract accepts, applied here because a plugin is where
// untrusted values enter. A display string is cut to fit; an id is not, since
// a cut id names a different thing than the one the driver meant.
const MAX_VERSION_CHARS = 200;
const MAX_LABEL_CHARS = 200;
const MAX_ERROR_MESSAGE_CHARS = 500;
const MAX_MODELS = 50;
const MAX_MODEL_TEXT_CHARS = 200;
const MAX_EMAIL_CHARS = 320;
const MAX_ITEM_ID_CHARS = 300;
// A message id is "<stream>:<itemId>", and "assistant" is the longer stream.
const MAX_TEXT_DELTA_ITEM_ID_CHARS = MAX_ITEM_ID_CHARS - "assistant:".length;
const MAX_REQUEST_ID_CHARS = 200;
const MAX_TURN_ID_CHARS = 200;
const MAX_OPTION_ID_CHARS = 200;
const MAX_OPTION_NAME_CHARS = 100;
const MAX_PERMISSION_OPTIONS = 8;
const MAX_TITLE_CHARS = 200;
const MAX_DETAIL_CHARS = 500;
const MAX_TEXT_CHARS = 10_000;
const MAX_LOCATIONS = 20;
const MAX_LOCATION_CHARS = 1_000;
const MAX_PLAN_STEPS = 50;
const MAX_PLAN_STEP_CHARS = 500;
const MAX_SESSION_ID_CHARS = 200;

function clamp(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : value.slice(0, max);
}

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

const ProbeSchema = z.object({
  installed: z.boolean(),
  version: z.string().optional(),
  auth: z.object({
    status: z.enum(["authenticated", "unauthenticated", "unknown"]),
    label: z.string().optional(),
    email: z.string().optional(),
    loginHint: z.string().optional(),
  }),
  models: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    planIncluded: z.boolean(),
    options: z.array(z.object({
      id: z.string().min(1),
      values: z.array(z.string()),
      default: z.string().optional(),
    })).optional(),
  })),
  errorMessage: z.string().optional(),
});

const PermissionOptionSchema = z.object({
  optionId: z.string().min(1).max(MAX_OPTION_ID_CHARS),
  name: z.string().min(1).max(MAX_OPTION_NAME_CHARS),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
});

const PermissionDecisionSchema = z.union([
  PermissionOptionSchema.shape.kind,
  z.literal("cancel"),
]);

/**
 * The event contract, as the boundary reads it.
 *
 * Two rules live here and nowhere else. Identity — an item id, a request id,
 * an option id — is checked, because dohc answers a permission by the id the
 * driver sent and a cut id answers nothing. Display text is cut to what the
 * surfaces accept, because a long title is still a title. And the harness's
 * own payload has no field to arrive in: `raw` is not declared, so a driver
 * that sends one has it stripped here, which is what AgentDriver's own
 * comment asks of every consumer past the process boundary.
 */
const EventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session-state"),
    state: z.enum(["starting", "ready", "running", "error", "closed"]),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("text-delta"),
    itemId: z.string().min(1).max(MAX_TEXT_DELTA_ITEM_ID_CHARS),
    stream: z.enum(["assistant", "reasoning"]),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("item"),
    phase: z.enum(["started", "updated", "completed"]),
    item: z.object({
      id: z.string().min(1).max(MAX_ITEM_ID_CHARS),
      type: z.enum([
        "tool_call",
        "command",
        "file_change",
        "mcp_tool_call",
        "web_search",
        "plan",
        "other",
      ]),
      title: z.string(),
      detail: z.string().optional(),
      status: z.enum(["pending", "in_progress", "completed", "failed"]),
      locations: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    kind: z.literal("plan"),
    steps: z.array(z.object({
      step: z.string(),
      status: z.enum(["pending", "inProgress", "completed"]),
    })),
  }),
  z.object({
    kind: z.literal("permission-request"),
    requestId: z.string().min(1).max(MAX_REQUEST_ID_CHARS),
    requestType: z.enum(["command", "file-change", "file-read", "tool", "other"]),
    title: z.string(),
    detail: z.string().optional(),
    locations: z.array(z.string()).optional(),
    options: z.array(PermissionOptionSchema).max(MAX_PERMISSION_OPTIONS),
  }),
  z.object({
    kind: z.literal("permission-resolved"),
    requestId: z.string().min(1).max(MAX_REQUEST_ID_CHARS),
    decision: PermissionDecisionSchema,
  }),
  z.object({
    kind: z.literal("token-usage"),
    used: z.number().finite(),
    max: z.number().finite().optional(),
    input: z.number().finite().optional(),
    output: z.number().finite().optional(),
  }),
  z.object({
    kind: z.literal("turn-completed"),
    turnId: z.string().min(1).max(MAX_TURN_ID_CHARS),
    status: z.enum(["completed", "failed", "cancelled"]),
    errorMessage: z.string().optional(),
  }),
  z.object({
    kind: z.literal("auth"),
    event: z.enum([
      "account-updated",
      "rate-limits",
      "mcp-oauth-completed",
      "login-required",
    ]),
    detail: z.string().optional(),
  }),
  z.object({
    kind: z.literal("error"),
    message: z.string(),
    fatal: z.boolean(),
  }),
]);

const EventParamsSchema = z.object({
  sessionKey: z.string().min(1),
  event: EventSchema,
});

const StartSessionResultSchema = z.object({
  sessionId: z.string().min(1).max(MAX_SESSION_ID_CHARS),
  resumeCursor: JsonValue.optional(),
  supports: z.object({
    setModel: z.boolean(),
    answerUserInput: z.boolean(),
  }),
});

function locations(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values
    .slice(0, MAX_LOCATIONS)
    .map((location) => location.slice(0, MAX_LOCATION_CHARS));
}

/** Cuts display text to what dohc's surfaces show. Identity is left alone. */
function boundEvent(event: z.infer<typeof EventSchema>): AgentEvent {
  switch (event.kind) {
    case "session-state":
      return {
        kind: "session-state",
        state: event.state,
        ...(event.reason === undefined
          ? {}
          : { reason: clamp(event.reason, MAX_ERROR_MESSAGE_CHARS) }),
      };
    case "text-delta":
      return { ...event, text: event.text.slice(0, MAX_TEXT_CHARS) };
    case "item":
      return {
        kind: "item",
        phase: event.phase,
        item: {
          id: event.item.id,
          type: event.item.type,
          title: event.item.title.slice(0, MAX_TITLE_CHARS),
          ...(event.item.detail === undefined
            ? {}
            : { detail: clamp(event.item.detail, MAX_DETAIL_CHARS) }),
          status: event.item.status,
          ...(event.item.locations === undefined
            ? {}
            : { locations: locations(event.item.locations) }),
        },
      };
    case "plan":
      return {
        kind: "plan",
        steps: event.steps.slice(0, MAX_PLAN_STEPS).map((step) => ({
          step: step.step.slice(0, MAX_PLAN_STEP_CHARS),
          status: step.status,
        })),
      };
    case "permission-request":
      return {
        kind: "permission-request",
        requestId: event.requestId,
        requestType: event.requestType,
        title: event.title.slice(0, MAX_TITLE_CHARS),
        ...(event.detail === undefined
          ? {}
          : { detail: clamp(event.detail, MAX_DETAIL_CHARS) }),
        ...(event.locations === undefined
          ? {}
          : { locations: locations(event.locations) }),
        options: event.options,
      };
    case "turn-completed":
      return {
        kind: "turn-completed",
        turnId: event.turnId,
        status: event.status,
        ...(event.errorMessage === undefined
          ? {}
          : { errorMessage: clamp(event.errorMessage, MAX_ERROR_MESSAGE_CHARS) }),
      };
    case "auth":
      return {
        kind: "auth",
        event: event.event,
        ...(event.detail === undefined
          ? {}
          : { detail: clamp(event.detail, MAX_DETAIL_CHARS) }),
      };
    case "error":
      return {
        kind: "error",
        message: event.message.slice(0, MAX_ERROR_MESSAGE_CHARS),
        fatal: event.fatal,
      };
    default:
      return event;
  }
}

function normalizeProbe(value: unknown): AgentProbe {
  const parsed = ProbeSchema.safeParse(value);
  if (!parsed.success) {
    return {
      installed: false,
      auth: { status: "unknown" },
      models: [],
      errorMessage: "This driver's plugin reported a result dohc cannot read.",
    };
  }
  const probe = parsed.data;
  return {
    installed: probe.installed,
    ...(probe.version === undefined
      ? {}
      : { version: clamp(probe.version, MAX_VERSION_CHARS) }),
    auth: {
      status: probe.auth.status,
      ...(probe.auth.label === undefined
        ? {}
        : { label: clamp(probe.auth.label, MAX_LABEL_CHARS) }),
      // Personal data, carried no further than this process: the panel
      // summary the renderer receives is built without these two fields, and
      // nothing on this path logs them.
      ...(probe.auth.email === undefined
        ? {}
        : { email: clamp(probe.auth.email, MAX_EMAIL_CHARS) }),
      ...(probe.auth.loginHint === undefined
        ? {}
        : { loginHint: clamp(probe.auth.loginHint, MAX_LABEL_CHARS) }),
    },
    models: probe.models.slice(0, MAX_MODELS).map((model) => ({
      id: model.id.slice(0, MAX_MODEL_TEXT_CHARS),
      name: model.name.slice(0, MAX_MODEL_TEXT_CHARS),
      planIncluded: model.planIncluded,
      ...(model.options === undefined ? {} : { options: model.options }),
    })),
    ...(probe.errorMessage === undefined
      ? {}
      : { errorMessage: clamp(probe.errorMessage, MAX_ERROR_MESSAGE_CHARS) }),
  };
}

/** What this module needs from PluginHost, and nothing more. */
export interface PluginDriverRequestHost {
  requestDriver<T = unknown>(
    pluginId: string,
    spawnId: string,
    method: string,
    params: unknown,
  ): Promise<T>;
}

export interface PluginAgentDriversOptions {
  host: PluginDriverRequestHost;
  /** The ids dohc's own drivers hold. No plugin may take one. */
  reservedDriverIds: readonly string[];
  /** Where a boundary refusal is reported. Defaults to the main-process log. */
  onWarning?: (message: string) => void;
}

interface DriverSessionState {
  pluginId: string;
  spawnId: string;
  driverId: string;
  onEvent: (event: AgentEvent) => void;
  permissionPolicy: AgentSessionStartInput["permissionPolicy"];
}

interface DriverRegistration {
  spawnId: string;
  drivers: Map<string, AgentDriver>;
}

/**
 * Plugin-contributed drivers, as dohc's own driver registry sees them.
 *
 * One of these per workspace. It holds what a plugin driver needs that a
 * plugin process cannot hold itself: the session bookkeeping that survives a
 * crash, the permission policy that never leaves this process, and the
 * boundary that reads a plugin's events before dohc's surfaces do.
 *
 * dohc keeps kill authority over a driver's harness without the plugin's
 * help. Every harness process a driver starts is a brokered child of that
 * plugin's spawn, and the same spawn teardown that calls `endSpawn` here
 * takes that whole process tree down — a dohc-side decision the plugin is
 * told about, not asked about.
 */
export function createPluginAgentDrivers(options: PluginAgentDriversOptions) {
  const registrations = new Map<string, DriverRegistration>();
  const sessions = new Map<string, DriverSessionState>();
  const reserved = new Set(options.reservedDriverIds);
  const warn = options.onWarning ??
    ((message: string) => console.error(`[desktop] ${message}`));

  function registeredCount(): number {
    let total = 0;
    for (const registration of registrations.values()) {
      total += registration.drivers.size;
    }
    return total;
  }

  function ownerOf(driverId: string): string | undefined {
    for (const [pluginId, registration] of registrations) {
      if (registration.drivers.has(driverId)) return pluginId;
    }
    return undefined;
  }

  function endSession(sessionKey: string): void {
    sessions.delete(sessionKey);
  }

  async function tellDriverThePolicyAnswer(
    state: DriverSessionState,
    sessionKey: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    try {
      await options.host.requestDriver(
        state.pluginId,
        state.spawnId,
        PLUGIN_HOST_METHODS.driverAnswerPermission,
        {
          sessionKey,
          requestId,
          decision,
        } satisfies PluginDriverAnswerPermissionParams,
      );
    } catch (error) {
      warn(
        `plugin "${state.pluginId}" could not be told the permission policy's answer: ${errorMessage(error)}`,
      );
    }
  }

  function createSession(
    pluginId: string,
    spawnId: string,
    driverId: string,
    sessionKey: string,
    started: z.infer<typeof StartSessionResultSchema>,
  ): AgentSession {
    const request = <T = unknown>(method: string, params: unknown): Promise<T> =>
      options.host.requestDriver<T>(pluginId, spawnId, method, params);

    const session: AgentSession = {
      sessionId: started.sessionId,
      resumeCursor: started.resumeCursor,
      async prompt(input) {
        const result = await request<PluginDriverPromptResult>(
          PLUGIN_HOST_METHODS.driverPrompt,
          {
            sessionKey,
            text: input.text,
            ...(input.attachments === undefined
              ? {}
              : { attachments: input.attachments }),
          } satisfies PluginDriverPromptParams,
        );
        const turnId = z.string().min(1).max(MAX_TURN_ID_CHARS)
          .safeParse(result?.turnId);
        if (!turnId.success) {
          throw new Error(
            `Driver "${driverId}" returned a turn id dohc cannot use. A turn id must be 1 to ${MAX_TURN_ID_CHARS} characters.`,
          );
        }
        return { turnId: turnId.data };
      },
      async cancel() {
        await request(PLUGIN_HOST_METHODS.driverCancel, {
          sessionKey,
        } satisfies PluginDriverSessionParams);
      },
      async answerPermission(requestId, decision) {
        await request(PLUGIN_HOST_METHODS.driverAnswerPermission, {
          sessionKey,
          requestId,
          decision,
        } satisfies PluginDriverAnswerPermissionParams);
      },
      async stop() {
        await request(PLUGIN_HOST_METHODS.driverStop, {
          sessionKey,
        } satisfies PluginDriverSessionParams);
      },
      async dispose() {
        endSession(sessionKey);
        await request(PLUGIN_HOST_METHODS.driverDispose, {
          sessionKey,
        } satisfies PluginDriverSessionParams);
      },
    };
    // Optional members exist only where the driver implements them, because
    // every caller decides what a session can do by testing for them.
    if (started.supports.setModel) {
      session.setModel = async (modelId: string) => {
        await request(PLUGIN_HOST_METHODS.driverSetModel, {
          sessionKey,
          modelId,
        } satisfies PluginDriverSetModelParams);
      };
    }
    if (started.supports.answerUserInput) {
      session.answerUserInput = async (requestId, answers) => {
        await request(PLUGIN_HOST_METHODS.driverAnswerUserInput, {
          sessionKey,
          requestId,
          answers,
        } satisfies PluginDriverAnswerUserInputParams);
      };
    }
    return session;
  }

  function createDriver(
    pluginId: string,
    spawnId: string,
    declared: { id: string; displayName: string },
  ): AgentDriver {
    return {
      id: declared.id,
      displayName: declared.displayName,
      async probe(): Promise<AgentProbe> {
        const result = await raceWithTimeout(
          options.host.requestDriver(
            pluginId,
            spawnId,
            PLUGIN_HOST_METHODS.driverProbe,
            { driverId: declared.id } satisfies PluginDriverProbeParams,
          ),
          PLUGIN_DRIVER_PROBE_TIMEOUT_MS,
          `Driver "${declared.id}" did not answer a probe within ${PLUGIN_DRIVER_PROBE_TIMEOUT_MS} ms.`,
        );
        return normalizeProbe(result);
      },
      async startSession(input: AgentSessionStartInput): Promise<AgentSession> {
        const sessionKey = randomUUID();
        // Registered before the request, because a driver reports "starting"
        // — and a failure to start — before this call returns.
        sessions.set(sessionKey, {
          pluginId,
          spawnId,
          driverId: declared.id,
          onEvent: input.onEvent,
          permissionPolicy: input.permissionPolicy,
        });
        try {
          const result = await options.host.requestDriver(
            pluginId,
            spawnId,
            PLUGIN_HOST_METHODS.driverStartSession,
            {
              driverId: declared.id,
              sessionKey,
              workspaceRoot: input.workspaceRoot,
              mode: input.mode,
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.resumeCursor === undefined
                ? {}
                : { resumeCursor: input.resumeCursor }),
              mcp: input.mcp,
              ...(input.logDir === undefined ? {} : { logDir: input.logDir }),
            } as PluginDriverStartSessionParams,
          );
          const started = StartSessionResultSchema.safeParse(result);
          if (!started.success) {
            throw new Error(
              `Driver "${declared.id}" returned a session dohc cannot use: it must report a session id of 1 to ${MAX_SESSION_ID_CHARS} characters, a JSON resume cursor, and which optional members it supports.`,
            );
          }
          return createSession(
            pluginId,
            spawnId,
            declared.id,
            sessionKey,
            started.data,
          );
        } catch (error) {
          endSession(sessionKey);
          throw error;
        }
      },
    };
  }

  return {
    /**
     * Takes one spawn's declared drivers into the registry, or refuses the
     * whole set. Refusing throws, which fails the plugin's activation: dohc
     * must never list two drivers under one id, and a plugin that half
     * registered would be worse than one that did not start.
     */
    register(
      pluginId: string,
      spawnId: string,
      drivers: ReadonlyArray<{ id: string; displayName: string }>,
    ): void {
      if (drivers.length === 0) {
        registrations.delete(pluginId);
        return;
      }
      const existing = registrations.get(pluginId);
      const alreadyHeld = existing?.drivers.size ?? 0;
      const total = registeredCount() - alreadyHeld + drivers.length;
      if (total > MAX_WORKSPACE_PLUGIN_DRIVERS) {
        throw new Error(
          `This workspace already has ${registeredCount() - alreadyHeld} of ${MAX_WORKSPACE_PLUGIN_DRIVERS} plugin agent drivers, and "${pluginId}" contributes ${drivers.length} more. Remove a driver plugin from this workspace first.`,
        );
      }
      for (const driver of drivers) {
        if (reserved.has(driver.id)) {
          throw new Error(
            `Driver id "${driver.id}" is one dohc ships. Rename this plugin's driver.`,
          );
        }
        const owner = ownerOf(driver.id);
        if (owner !== undefined && owner !== pluginId) {
          throw new Error(
            `Driver id "${driver.id}" is already registered by plugin "${owner}" in this workspace. Rename this plugin's driver.`,
          );
        }
      }
      registrations.set(pluginId, {
        spawnId,
        drivers: new Map(
          drivers.map((driver) => [
            driver.id,
            createDriver(pluginId, spawnId, driver),
          ]),
        ),
      });
    },

    /**
     * One spawn ended — stopped, crashed, or replaced. Its drivers leave the
     * registry and its sessions fail, because the process that was running
     * the harness is gone and the broker has taken the harness down with it.
     */
    endSpawn(pluginId: string, spawnId: string): void {
      const registration = registrations.get(pluginId);
      if (registration?.spawnId === spawnId) registrations.delete(pluginId);
      for (const [sessionKey, session] of [...sessions]) {
        if (session.pluginId !== pluginId || session.spawnId !== spawnId) {
          continue;
        }
        sessions.delete(sessionKey);
        session.onEvent({
          kind: "error",
          message: `The plugin running the "${session.driverId}" agent stopped, and its agent stopped with it.`,
          fatal: true,
        });
      }
    },

    /** One event a plugin's driver reported. */
    handleEvent(pluginId: string, spawnId: string, params: unknown): void {
      const parsed = EventParamsSchema.safeParse(params);
      if (!parsed.success) {
        warn(
          `plugin "${pluginId}" sent an agent event dohc cannot read and dropped it: ${parsed.error.issues[0]?.message ?? "invalid event"}`,
        );
        return;
      }
      const state = sessions.get(parsed.data.sessionKey);
      // A session dohc already ended, or one belonging to an earlier spawn:
      // its events describe work no surface is waiting on.
      if (!state || state.pluginId !== pluginId || state.spawnId !== spawnId) {
        return;
      }
      const event = boundEvent(parsed.data.event);
      if (event.kind !== "permission-request") {
        state.onEvent(event);
        return;
      }
      // The permission policy stays in this process — the plugin never sees
      // it. A policy that decides answers the driver straight away, exactly
      // as a built-in driver answers its own harness; a policy that declines
      // to decide leaves the request for the person to answer.
      const decision = state.permissionPolicy?.(event) ?? null;
      state.onEvent(event);
      if (decision === null) return;
      void tellDriverThePolicyAnswer(
        state,
        parsed.data.sessionKey,
        event.requestId,
        decision,
      );
    },

    /** Every registered plugin driver, for the workspace's driver registry. */
    list(): AgentDriver[] {
      const drivers: AgentDriver[] = [];
      for (const registration of registrations.values()) {
        drivers.push(...registration.drivers.values());
      }
      return drivers;
    },
  };
}

export type PluginAgentDrivers = ReturnType<typeof createPluginAgentDrivers>;
