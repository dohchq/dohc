import {
  createDohcClient,
  createPluginChildProcessClient,
  createProcessTransport,
  type PluginActivateContext,
  type PluginAgentDriver,
  type PluginAgentSession,
  type PluginHandler,
  type PluginJsonValue,
  type PluginSettings,
  type PluginSettingValue,
} from "@dohc/sdk/node";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_HOST_METHODS,
  type PluginActivateParams,
  type PluginDriverAnswerPermissionParams,
  type PluginDriverAnswerUserInputParams,
  type PluginDriverEventParams,
  type PluginDriverPromptParams,
  type PluginDriverProbeParams,
  type PluginDriverProbeResult,
  type PluginDriverPromptResult,
  type PluginDriverSessionParams,
  type PluginDriverSetModelParams,
  type PluginDriverStartSessionParams,
  type PluginDriverStartSessionResult,
  type PluginInvokeCommandParams,
  type PluginStartWebAppParams,
  type PluginStartWebAppResult,
  type PluginSettingsChangedParams,
  type PluginStopWebAppParams,
} from "./pluginHostProtocol.ts";
const transport = createProcessTransport();
const client = createDohcClient({ transport });
const childProcesses = createPluginChildProcessClient(transport);
const commandRuns = new Map<string, (...args: unknown[]) => unknown>();
const drivers = new Map<string, PluginAgentDriver>();
const driverSessions = new Map<string, PluginAgentSession>();
let activeHandler: PluginHandler | null = null;

// This process serves exactly one plugin, so its settings are process state.
// The host sends the first set with activate and a complete set on every
// change, so `currentSettings` is never a merge of two sources.
let currentSettings: Record<string, PluginSettingValue> = {};
const settingsListeners = new Set<
  (values: Record<string, PluginSettingValue>) => void
>();

const settings: PluginSettings = {
  get: () => ({ ...currentSettings }),
  onChange(listener) {
    settingsListeners.add(listener);
    return () => {
      settingsListeners.delete(listener);
    };
  },
};

// Local on purpose, not pluginShared's: this file is a standalone child
// entry that plain Node also executes directly from source (PluginHost's
// tests fork it as-is), where an extension-less relative import does not
// resolve under type stripping.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPluginHandler(value: unknown): value is PluginHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    "activate" in value &&
    typeof value.activate === "function"
  );
}

transport.onRequest(PLUGIN_HOST_METHODS.activate, async (rawParams) => {
  const params = rawParams as PluginActivateParams;
  const pluginModule = await import(
    pathToFileURL(join(params.pluginRoot, params.manifest.entry)).href
  ) as { default?: unknown };
  const handler = pluginModule.default;
  if (!isPluginHandler(handler)) {
    throw new Error(
      `Plugin entry "${params.manifest.entry}" must export a default object with an activate(ctx) function.`,
    );
  }

  currentSettings = params.settings ?? {};

  const registeredCommandIds: string[] = [];
  const registeredDriverIds: string[] = [];
  const ctx: PluginActivateContext = {
    pluginId: params.pluginId,
    workspaceRoot: params.workspaceRoot,
    pluginRoot: params.pluginRoot,
    stateRoot: params.stateRoot,
    client,
    childProcesses,
    settings,
    commands: {
      register(id, run) {
        registeredCommandIds.push(id);
        commandRuns.set(id, run);
      },
    },
    drivers: {
      register(id, driver) {
        registeredDriverIds.push(id);
        drivers.set(id, driver);
      },
    },
  };

  await handler.activate(ctx);
  activeHandler = handler;

  return { commands: registeredCommandIds, drivers: registeredDriverIds };
});

transport.onRequest(PLUGIN_HOST_METHODS.settingsChanged, (rawParams) => {
  const params = rawParams as PluginSettingsChangedParams;
  currentSettings = params.values ?? {};
  // A listener that throws must not fail the whole change for the others,
  // and must never take the plugin process down with it.
  for (const listener of settingsListeners) {
    try {
      listener({ ...currentSettings });
    } catch (error) {
      transport.notify(PLUGIN_HOST_METHODS.log, {
        level: "error",
        message: `A settings listener failed: ${errorMessage(error)}`,
      });
    }
  }
  return {};
});

transport.onRequest(PLUGIN_HOST_METHODS.deactivate, async () => {
  await activeHandler?.deactivate?.();
  return {};
});

transport.onRequest(PLUGIN_HOST_METHODS.startWebApp, async (rawParams) => {
  const params = rawParams as PluginStartWebAppParams;
  if (!activeHandler?.startWebApp) {
    throw new Error(
      "This plugin declares web apps but its handler does not implement startWebApp(webAppId, instanceKey).",
    );
  }
  const started = await activeHandler.startWebApp(
    params.webAppId,
    params.instanceKey,
  );
  if (
    typeof started !== "object" ||
    started === null ||
    typeof started.url !== "string" ||
    started.url.length === 0
  ) {
    throw new Error(
      "startWebApp must return { url } with a non-empty string url.",
    );
  }
  return {
    url: started.url,
    ...(started.title === undefined ? {} : { title: started.title }),
  } satisfies PluginStartWebAppResult;
});

transport.onRequest(PLUGIN_HOST_METHODS.stopWebApp, async (rawParams) => {
  const params = rawParams as PluginStopWebAppParams;
  if (!activeHandler?.stopWebApp) {
    throw new Error(
      "This plugin implements startWebApp but its handler does not implement stopWebApp(webAppId, instanceKey).",
    );
  }
  await activeHandler.stopWebApp(params.webAppId, params.instanceKey);
  return {};
});

transport.onRequest(PLUGIN_HOST_METHODS.invokeCommand, async (rawParams) => {
  const params = rawParams as PluginInvokeCommandParams;
  const run = commandRuns.get(params.commandId);
  if (!run) {
    throw new Error(`Command "${params.commandId}" is not registered.`);
  }
  return run();
});

function requireDriver(driverId: string): PluginAgentDriver {
  const driver = drivers.get(driverId);
  if (!driver) throw new Error(`Driver "${driverId}" is not registered.`);
  return driver;
}

function requireDriverSession(sessionKey: string): PluginAgentSession {
  const session = driverSessions.get(sessionKey);
  if (!session) throw new Error("This driver session has already ended.");
  return session;
}

// A resume cursor travels as JSON. A value that cannot make the trip would
// otherwise fail inside the transport's own send, where nothing answers the
// request the host is waiting on.
function assertJsonValue(value: unknown, label: string): void {
  if (value === undefined) return;
  let rendered: string | undefined;
  try {
    rendered = JSON.stringify(value);
  } catch {
    rendered = undefined;
  }
  if (rendered === undefined) throw new Error(`${label} must be JSON data.`);
}

transport.onRequest(PLUGIN_HOST_METHODS.driverProbe, async (rawParams) => {
  const params = rawParams as PluginDriverProbeParams;
  return await requireDriver(params.driverId).probe() satisfies
    PluginDriverProbeResult;
});

transport.onRequest(PLUGIN_HOST_METHODS.driverStartSession, async (rawParams) => {
  const params = rawParams as PluginDriverStartSessionParams;
  const driver = requireDriver(params.driverId);
  const { sessionKey } = params;
  const session = await driver.startSession({
    workspaceRoot: params.workspaceRoot,
    mode: params.mode,
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.resumeCursor === undefined
      ? {}
      : { resumeCursor: params.resumeCursor }),
    mcp: params.mcp,
    ...(params.logDir === undefined ? {} : { logDir: params.logDir }),
    onEvent(event) {
      transport.notify(PLUGIN_HOST_METHODS.driverEvent, {
        sessionKey,
        event,
      } satisfies PluginDriverEventParams);
    },
  });
  assertJsonValue(session.resumeCursor, "A driver session's resumeCursor");
  driverSessions.set(sessionKey, session);
  return {
    sessionId: session.sessionId,
    ...(session.resumeCursor === undefined
      ? {}
      : { resumeCursor: session.resumeCursor as PluginJsonValue }),
    supports: {
      setModel: typeof session.setModel === "function",
      answerUserInput: typeof session.answerUserInput === "function",
    },
  } satisfies PluginDriverStartSessionResult;
});

transport.onRequest(PLUGIN_HOST_METHODS.driverPrompt, async (rawParams) => {
  const params = rawParams as PluginDriverPromptParams;
  const session = requireDriverSession(params.sessionKey);
  const result = await session.prompt({
    text: params.text,
    ...(params.attachments === undefined
      ? {}
      : { attachments: params.attachments }),
  });
  if (typeof result?.turnId !== "string" || result.turnId.length === 0) {
    throw new Error("A driver session's prompt must return a turn id.");
  }
  return { turnId: result.turnId } satisfies PluginDriverPromptResult;
});

transport.onRequest(PLUGIN_HOST_METHODS.driverCancel, async (rawParams) => {
  const params = rawParams as PluginDriverSessionParams;
  await requireDriverSession(params.sessionKey).cancel();
  return {};
});

transport.onRequest(
  PLUGIN_HOST_METHODS.driverAnswerPermission,
  async (rawParams) => {
    const params = rawParams as PluginDriverAnswerPermissionParams;
    await requireDriverSession(params.sessionKey).answerPermission(
      params.requestId,
      params.decision,
    );
    return {};
  },
);

transport.onRequest(
  PLUGIN_HOST_METHODS.driverAnswerUserInput,
  async (rawParams) => {
    const params = rawParams as PluginDriverAnswerUserInputParams;
    const session = requireDriverSession(params.sessionKey);
    if (!session.answerUserInput) {
      throw new Error("This driver session does not take user input.");
    }
    await session.answerUserInput(params.requestId, params.answers);
    return {};
  },
);

transport.onRequest(PLUGIN_HOST_METHODS.driverSetModel, async (rawParams) => {
  const params = rawParams as PluginDriverSetModelParams;
  const session = requireDriverSession(params.sessionKey);
  if (!session.setModel) {
    throw new Error("This driver session cannot change model.");
  }
  await session.setModel(params.modelId);
  return {};
});

transport.onRequest(PLUGIN_HOST_METHODS.driverStop, async (rawParams) => {
  const params = rawParams as PluginDriverSessionParams;
  await requireDriverSession(params.sessionKey).stop();
  return {};
});

transport.onRequest(PLUGIN_HOST_METHODS.driverDispose, async (rawParams) => {
  const params = rawParams as PluginDriverSessionParams;
  const session = driverSessions.get(params.sessionKey);
  if (!session) return {};
  // The host asked for this session to end. It is gone from here either way,
  // so a failing dispose reports itself without leaving a session the host
  // believes it disposed.
  driverSessions.delete(params.sessionKey);
  await session.dispose();
  return {};
});

process.on("uncaughtException", (error) => {
  transport.notify(PLUGIN_HOST_METHODS.log, {
    level: "error",
    message: error.message,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  transport.notify(PLUGIN_HOST_METHODS.log, {
    level: "error",
    message: errorMessage(reason),
  });
  process.exit(1);
});
