import { randomUUID } from "node:crypto";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import {
  mutatePluginRecord,
  pluginDataDir,
  readPluginLocalState,
} from "./pluginLocalState";
import { pluginStateRoot } from "./pluginSourceSnapshot";
import {
  PLUGIN_ACTIVATION_TIMEOUT_MS,
  PLUGIN_CRASH_LOOP_THRESHOLD,
  PLUGIN_FAST_FAILURE_WINDOW_MS,
  PLUGIN_HOST_METHODS,
  PLUGIN_PROCESS_LOG_LIMIT,
  PLUGIN_WEB_APP_START_TIMEOUT_MS,
  PLUGIN_WEB_APP_STOP_TIMEOUT_MS,
  type PluginActivateParams,
  type PluginSettingsChangedParams,
  type PluginActivateResult,
  type PluginInvokeCommandParams,
  type PluginLogParams,
  type PluginRuntimeStatus,
  type PluginStartWebAppParams,
  type PluginStartWebAppResult,
  type PluginStopWebAppParams,
  type SdkEventParams,
  type PluginTransport,
  type SdkRequestParams,
} from "./pluginHostProtocol";
import {
  MAX_PLUGIN_WEB_APP_TITLE_CHARS,
  requireDeclaredWebApp,
} from "./pluginWebAppInstances";
import type { PluginSettingValue } from "./pluginManifestSchema";
import { raceWithTimeout } from "./pluginShared";

const DEACTIVATION_TIMEOUT_MS = 5_000;

const pluginHostRecordBrand: unique symbol = Symbol("PluginHostRecord");
const pluginHostStartBrand: unique symbol = Symbol("PluginHostStart");

export interface PluginHostRecordToken {
  readonly [pluginHostRecordBrand]: true;
}

export interface PluginHostRecoveryDisposition {
  readonly kind: "will-respawn" | "terminal";
  readonly record: PluginHostRecordToken;
}

export interface PluginHostStartEvidence {
  readonly [pluginHostStartBrand]: true;
  readonly pluginId: string;
  readonly record: PluginHostRecordToken;
}

export interface PluginHostPanelDeclaration {
  readonly id: string;
  readonly title: string;
  readonly placement: "editor" | "view";
  readonly entry: string;
  readonly icon?: string;
}

class HostRecordToken implements PluginHostRecordToken {
  readonly [pluginHostRecordBrand] = true;
}

class HostStartEvidence implements PluginHostStartEvidence {
  readonly [pluginHostStartBrand] = true;

  constructor(
    readonly pluginId: string,
    readonly record: PluginHostRecordToken,
  ) {}
}

export interface PluginHostOptions {
  stateDir: string;
  workspaceRoot: string;
  spawnTransport: (params: {
    pluginId: string;
    pluginRoot: string;
    onStderr: (line: string) => void;
    onRequest: (
      method: string,
      params: unknown,
    ) => Promise<unknown> | unknown;
    onNotification: (method: string, params: unknown) => void;
    onExit: (info: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
  }) => PluginTransport;
  routeSdkRequest: (
    pluginId: string,
    method: string,
    params: unknown,
    /** The requesting spawn's run id (PluginSpawn.spawnId) at request time — avoids a race against a respawn between issuing and routing the request. */
    spawnId: string,
    /** Aborts when this exact spawn stops, crashes, or is replaced. */
    signal: AbortSignal,
    emitEvent: (subscriptionId: string, event: string, data: unknown) => void,
  ) => Promise<unknown>;
  /** This plugin's settings, resolved against its manifest, for activation.
   * Named by directoryName, never pluginId — settings are stored and looked
   * up per directory, and a manifest's declared name can differ from the
   * folder it was found in. */
  readPluginSettings?: (
    directoryName: string,
  ) => Promise<Record<string, PluginSettingValue>>;
  /**
   * Offers this spawn's manifest-declared drivers to the workspace's driver
   * registry, during activation. Throwing refuses the activation, which is
   * what a colliding driver id has to do: dohc must never list two drivers
   * under one id.
   */
  onDriversRegistered?: (
    pluginId: string,
    spawnId: string,
    drivers: ReadonlyArray<{ id: string; displayName: string }>,
  ) => void;
  /** One event a plugin's driver reported, from the spawn that reported it. */
  onDriverEvent?: (pluginId: string, spawnId: string, params: unknown) => void;
  /** Releases resources that the SDK router owns for one spawn. */
  onSpawnEnd?: (pluginId: string, spawnId: string) => Promise<void>;
  /** Releases router resources that are not attached to a live host record. */
  onDispose?: () => Promise<void>;
  onStatusChange?: (pluginId: string, status: PluginRuntimeStatus) => void;
  onRecoveryDisposition?: (
    pluginId: string,
    disposition: PluginHostRecoveryDisposition,
  ) => void;
  mutatePluginRecord?: typeof mutatePluginRecord;
  now?: () => number;
  activationTimeoutMs?: number;
  webAppStartTimeoutMs?: number;
}

interface PluginSpawn {
  /**
   * One UUID per spawn attempt, not per plugin. It is the agentRunId a
   * later PR's production SDK router attaches to every write attribution
   * for this run — a respawn after a crash is a new run, so it gets a new
   * id, the same way AgentSessionManager mints a fresh run id per session.
   */
  spawnId: string;
  generation: number;
  spawnedAt: number;
  stopping: boolean;
  failureHandled: boolean;
  /**
   * Settles when this spawn stops being "starting": resolved once activation
   * succeeded, rejected with the reason it never will. A spawn id exists from
   * the moment the process is asked for, which is before the plugin can serve
   * anything, so this is what a caller waits on (#798).
   */
  activated: Promise<void>;
  resolveActivated: () => void;
  rejectActivated: (error: Error) => void;
  abortController: AbortController;
  transport?: PluginTransport;
  shutdown?: Promise<void>;
  resourceDisposal?: Promise<void>;
}

interface PluginRecord {
  ownershipToken: PluginHostRecordToken;
  pluginId: string;
  pluginRoot: string;
  /** The discovered SOURCE directory's own name, passed explicitly into
   * start() — never derived from pluginRoot, which production starts a
   * plugin from as its BUILT root, not its source folder. The identity a
   * manifest's own declared name cannot stand in for when it differs from
   * the folder it was found in. */
  directoryName: string;
  manifest: DohcPluginManifest;
  status: PluginRuntimeStatus;
  stderr: string[];
  commands?: string[];
  drivers?: string[];
  current?: PluginSpawn;
}

function isSdkRequestParams(params: unknown): params is SdkRequestParams {
  return (
    typeof params === "object" &&
    params !== null &&
    "method" in params &&
    typeof params.method === "string" &&
    params.method.length > 0
  );
}

function isPluginLogParams(params: unknown): params is PluginLogParams {
  return (
    typeof params === "object" &&
    params !== null &&
    "level" in params &&
    (params.level === "info" ||
      params.level === "warn" ||
      params.level === "error") &&
    "message" in params &&
    typeof params.message === "string"
  );
}

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function isPluginActivateResult(value: unknown): value is PluginActivateResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "commands" in value &&
    isIdList(value.commands) &&
    "drivers" in value &&
    isIdList(value.drivers)
  );
}

function findDuplicateId(ids: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

function registrationMismatch(
  pluginId: string,
  noun: "command" | "driver",
  declared: readonly string[],
  registered: readonly string[],
): string | undefined {
  const declaredIds = new Set(declared);
  const registeredIds = new Set(registered);
  const missing = declared.find((id) => !registeredIds.has(id));
  if (missing !== undefined) {
    return `Plugin "${pluginId}" activation did not register ${noun} id "${missing}" declared in its manifest.`;
  }
  const extra = registered.find((id) => !declaredIds.has(id));
  if (extra !== undefined) {
    return `Plugin "${pluginId}" activation registered ${noun} id "${extra}" that its manifest does not declare.`;
  }
  return undefined;
}

export class PluginHost {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly pendingStarts = new Set<string>();
  private readonly abortedStarts = new Set<string>();
  // A clean stop deliberately does not reset this count. A fast clean stop is
  // indistinguishable from a fast pre-ready failure, so crash-loop protection wins.
  private readonly consecutiveFastFailures = new Map<string, number>();
  private readonly activationTimeoutMs: number;
  private currentGeneration = 0;

  constructor(private readonly options: PluginHostOptions) {
    this.activationTimeoutMs =
      options.activationTimeoutMs ?? PLUGIN_ACTIVATION_TIMEOUT_MS;
  }

  async start(
    pluginRoot: string,
    // The discovered SOURCE directory's own name under plugins/ — never
    // derived from pluginRoot. Production starts a plugin from its BUILT
    // root (dohc's own .dohc/plugins/<safe-path> staging, not the source
    // folder discovery found it at), so basename(pluginRoot) would read
    // dohc's internal build-path segment instead of the actual directory a
    // settings read or a sizes report needs to name.
    directoryName: string,
    manifest: DohcPluginManifest,
  ): Promise<PluginHostStartEvidence> {
    const admittedManifest = structuredClone(manifest);
    // The manifest name is the plugin's identity — one identity, so state
    // and attribution can never drift from what the manifest declares.
    const pluginId = admittedManifest.name;
    if (this.plugins.has(pluginId) || this.pendingStarts.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" is already running.`);
    }

    this.pendingStarts.add(pluginId);
    try {
      const localState = await readPluginLocalState(
        this.options.stateDir,
        this.options.workspaceRoot,
      );
      if (this.abortedStarts.delete(pluginId)) {
        throw new Error(
          `Plugin "${pluginId}" was stopped before it started.`,
        );
      }
      if (!localState.ok) {
        throw new Error(
          `Plugin "${pluginId}" was not started. ${localState.warning}`,
        );
      }
      if (localState.state.plugins[pluginId]?.disabled === true) {
        throw new Error(
          `Plugin "${pluginId}" is disabled. Re-enabling it is not yet available in the app.`,
        );
      }

      const record: PluginRecord = {
        ownershipToken: new HostRecordToken(),
        pluginId,
        pluginRoot,
        directoryName,
        // The host record owns the declaration it admitted. Discovery and
        // pipeline state can move on while this exact record keeps running.
        manifest: admittedManifest,
        status: "starting",
        stderr: [],
      };
      this.plugins.set(pluginId, record);
      this.spawn(record);
      return new HostStartEvidence(pluginId, record.ownershipToken);
    } finally {
      this.pendingStarts.delete(pluginId);
      this.abortedStarts.delete(pluginId);
    }
  }

  async stop(pluginId: string): Promise<void> {
    if (this.pendingStarts.has(pluginId)) {
      this.abortedStarts.add(pluginId);
      return;
    }
    const record = this.plugins.get(pluginId);
    if (!record) return;
    await this.stopPluginRecord(record);
  }

  async stopRecord(
    pluginId: string,
    expected: PluginHostRecordToken,
  ): Promise<void> {
    const record = this.plugins.get(pluginId);
    if (!record || record.ownershipToken !== expected) return;
    await this.stopPluginRecord(record);
  }

  private async stopPluginRecord(record: PluginRecord): Promise<void> {
    const spawn = record.current;
    if (!spawn?.transport) {
      if (spawn) await this.endSpawn(record, spawn);
      if (this.plugins.get(record.pluginId) === record) {
        this.plugins.delete(record.pluginId);
      }
      return;
    }
    if (spawn.shutdown) {
      await spawn.shutdown;
      return;
    }

    spawn.shutdown = this.shutdown(record, spawn, spawn.transport);
    await spawn.shutdown;
  }

  async stopAll(): Promise<void> {
    const pendingPluginIds = [...this.pendingStarts];
    for (const pluginId of pendingPluginIds) this.abortedStarts.add(pluginId);
    await Promise.allSettled([...this.plugins.keys()].map((id) => this.stop(id)));
    await this.options.onDispose?.();
  }

  /** Runs a command the plugin registered during activation and returns its result. */
  async invokeCommand(pluginId: string, commandId: string): Promise<unknown> {
    const record = this.plugins.get(pluginId);
    const spawn = record?.current;
    if (!record || !spawn?.transport) {
      throw new Error(`Plugin "${pluginId}" is not running.`);
    }
    if (spawn.stopping) {
      throw new Error(`Plugin "${pluginId}" is stopping.`);
    }
    if (record.status === "starting") {
      throw new Error(`Plugin "${pluginId}" is still starting.`);
    }
    return spawn.transport.request(PLUGIN_HOST_METHODS.invokeCommand, {
      commandId,
    } satisfies PluginInvokeCommandParams);
  }

  /**
   * Sends one `driver.*` request to a running plugin and returns its result.
   *
   * `spawnId` is the spawn the caller's driver belongs to: a plugin that
   * crashed and came back is a new spawn with no memory of that driver's
   * sessions, so a request aimed at the old one must fail rather than land on
   * the new one.
   */
  async requestDriver<T = unknown>(
    pluginId: string,
    spawnId: string,
    method: string,
    params: unknown,
  ): Promise<T> {
    const record = this.plugins.get(pluginId);
    const spawn = record?.current;
    if (!record || !spawn?.transport) {
      throw new Error(`Plugin "${pluginId}" is not running.`);
    }
    if (spawn.spawnId !== spawnId) {
      throw new Error(`Plugin "${pluginId}" restarted; this driver session ended with it.`);
    }
    if (spawn.stopping) {
      throw new Error(`Plugin "${pluginId}" is stopping.`);
    }
    if (record.status === "starting") {
      throw new Error(`Plugin "${pluginId}" is still starting.`);
    }
    return spawn.transport.request<T>(method, params);
  }

  /**
   * Asks the running plugin to start (or reuse) a manifest-declared web app
   * and returns the loopback URL its guest view must load. The URL may carry
   * a one-time credential in its fragment: callers keep it in memory and
   * never log it.
   */
  async startWebApp(
    pluginId: string,
    webAppId: string,
    instanceKey: string | null,
  ): Promise<PluginStartWebAppResult> {
    const record = this.plugins.get(pluginId);
    const spawn = record?.current;
    if (!record || !spawn?.transport) {
      throw new Error(`Plugin "${pluginId}" is not running.`);
    }
    if (spawn.stopping) {
      throw new Error(`Plugin "${pluginId}" is stopping.`);
    }
    if (record.status === "starting") {
      throw new Error(`Plugin "${pluginId}" is still starting.`);
    }
    requireDeclaredWebApp(
      pluginId,
      record.manifest.webApps,
      webAppId,
      instanceKey,
    );
    const timeoutMs =
      this.options.webAppStartTimeoutMs ?? PLUGIN_WEB_APP_START_TIMEOUT_MS;
    const result = await raceWithTimeout(
      spawn.transport.request(PLUGIN_HOST_METHODS.startWebApp, {
        webAppId,
        instanceKey,
      } satisfies PluginStartWebAppParams),
      timeoutMs,
      `Plugin "${pluginId}" web app "${webAppId}" did not start within ${timeoutMs} ms.`,
    );
    if (
      typeof result !== "object" ||
      result === null ||
      !("url" in result) ||
      typeof result.url !== "string" ||
      result.url.length === 0
    ) {
      throw new Error(
        `Plugin "${pluginId}" web app "${webAppId}" returned an invalid start result: "url" must be a non-empty string.`,
      );
    }
    const title = "title" in result ? result.title : undefined;
    if (title !== undefined) {
      if (typeof title !== "string" || title.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" web app "${webAppId}" returned an invalid start result: "title" must be a non-empty string when present.`,
        );
      }
      if (title.length > MAX_PLUGIN_WEB_APP_TITLE_CHARS) {
        throw new Error(
          `Plugin "${pluginId}" web app "${webAppId}" returned a ${title.length}-character title, past the limit of ${MAX_PLUGIN_WEB_APP_TITLE_CHARS} characters for a web app title.`,
        );
      }
    }
    return { url: result.url, ...(title === undefined ? {} : { title }) };
  }

  /**
   * Tells the running plugin the guest it started this web app for is gone,
   * so it ends the session that start paired. The host calls this on the
   * recovery path only: a normal tab close leaves the app paired, because the
   * guest's session cookie already landed and the next open reuses it.
   *
   * A plugin with no live spawn has nothing to unpair — the broker takes a
   * wrapper's whole process tree down with the spawn, so its server and the
   * session are already gone.
   */
  async stopWebApp(
    pluginId: string,
    webAppId: string,
    instanceKey: string | null,
  ): Promise<void> {
    const record = this.plugins.get(pluginId);
    const spawn = record?.current;
    if (!record || !spawn?.transport || spawn.stopping) return;
    requireDeclaredWebApp(
      pluginId,
      record.manifest.webApps,
      webAppId,
      instanceKey,
    );
    await raceWithTimeout(
      spawn.transport.request(PLUGIN_HOST_METHODS.stopWebApp, {
        webAppId,
        instanceKey,
      } satisfies PluginStopWebAppParams),
      PLUGIN_WEB_APP_STOP_TIMEOUT_MS,
      `Plugin "${pluginId}" web app "${webAppId}" did not stop within ${PLUGIN_WEB_APP_STOP_TIMEOUT_MS} ms.`,
    );
  }

  private pluginStateRoot(pluginId: string): string {
    return pluginStateRoot(
      pluginDataDir(this.options.stateDir, this.options.workspaceRoot),
      pluginId,
    );
  }

  private async shutdown(
    record: PluginRecord,
    spawn: PluginSpawn,
    transport: PluginTransport,
  ): Promise<void> {
    spawn.stopping = true;
    const resourceDisposal = this.endSpawn(record, spawn);
    await Promise.all([
      raceWithTimeout(
        transport.request(PLUGIN_HOST_METHODS.deactivate, {}),
        DEACTIVATION_TIMEOUT_MS,
        `Plugin "${record.pluginId}" did not deactivate within ${DEACTIVATION_TIMEOUT_MS} ms.`,
      ).catch(() => undefined),
      resourceDisposal.catch((error: unknown) => {
        this.appendLog(
          record,
          `Spawn resource disposal failed: ${this.errorMessage(error)}`,
        );
      }),
    ]);

    try {
      await transport.dispose();
    } finally {
      if (this.plugins.get(record.pluginId) === record) {
        this.plugins.delete(record.pluginId);
      }
    }
  }

  getStatus(pluginId: string): PluginRuntimeStatus | undefined {
    return this.plugins.get(pluginId)?.status;
  }

  currentRecord(pluginId: string): PluginHostRecordToken | undefined {
    return this.plugins.get(pluginId)?.ownershipToken;
  }

  hasLiveSpawn(pluginId: string): boolean {
    const record = this.plugins.get(pluginId);
    const spawn = record?.current;
    return Boolean(record && spawn && this.isLive(record, spawn));
  }

  getStderrLog(pluginId: string): string[] {
    return [...(this.plugins.get(pluginId)?.stderr ?? [])];
  }

  /**
   * Tells a running plugin its settings changed. A plugin that is not running
   * needs no telling — it reads the new values from its next activation. The
   * caller does not wait on this: a slow plugin must never hold up the save
   * the user already made.
   *
   * `directoryName` must match the running record's own — two directories
   * can share a manifest id (a broken manifest's directory-derived fallback
   * colliding with some other, unrelated plugin's real id), and only ONE of
   * them can ever be the process actually running under this id at a time.
   * Settings are saved per directory; telling whichever process happens to
   * be running under the shared id, rather than the one the save was
   * actually for, would hand it values it never asked for.
   */
  async notifySettingsChanged(
    pluginId: string,
    directoryName: string,
    values: Record<string, PluginSettingValue>,
  ): Promise<void> {
    const record = this.plugins.get(pluginId);
    const spawn = record?.current;
    if (
      !record ||
      record.directoryName !== directoryName ||
      !spawn ||
      !spawn.transport ||
      !this.isLive(record, spawn)
    ) {
      return;
    }
    await spawn.transport.request(PLUGIN_HOST_METHODS.settingsChanged, {
      values,
    } satisfies PluginSettingsChangedParams);
  }

  getRegisteredCommands(pluginId: string): string[] | undefined {
    const commands = this.plugins.get(pluginId)?.commands;
    return commands ? [...commands] : undefined;
  }

  getRegisteredDrivers(pluginId: string): string[] | undefined {
    const drivers = this.plugins.get(pluginId)?.drivers;
    return drivers ? [...drivers] : undefined;
  }

  getSpawnId(pluginId: string): string | undefined {
    return this.plugins.get(pluginId)?.current?.spawnId;
  }

  readyPanelsForSpawn(
    pluginId: string,
    expectedSpawnId: string,
  ): {
    readonly record: PluginHostRecordToken;
    readonly panels: readonly PluginHostPanelDeclaration[];
  } | undefined {
    const record = this.plugins.get(pluginId);
    const spawn = record?.current;
    if (
      !record ||
      !spawn ||
      record.status !== "ready" ||
      spawn.spawnId !== expectedSpawnId ||
      !this.isLive(record, spawn)
    ) {
      return undefined;
    }
    return {
      record: record.ownershipToken,
      panels: (record.manifest.panels ?? []).map(
        ({ id, title, placement, entry, icon }) => ({
          id,
          title,
          placement,
          entry,
          ...(icon === undefined ? {} : { icon }),
        }),
      ),
    };
  }

  /**
   * The running spawn's activation, or undefined when the plugin has no
   * spawn. It resolves when the plugin can answer a request, and rejects
   * with the reason it never will. A caller that is about to ask the plugin
   * for something waits on this instead of reading a spawn id or a status:
   * both say "running" while the plugin is still activating, and every
   * request in that window is refused (#798).
   *
   * The wait is bounded by the activation deadline this host already races
   * every activation against.
   */
  activationOf(pluginId: string): Promise<void> | undefined {
    return this.plugins.get(pluginId)?.current?.activated;
  }

  bumpGeneration(): void {
    this.currentGeneration += 1;
    for (const record of this.plugins.values()) {
      if (record.current) {
        // endSpawn's promise is wired to the broker's disposeSpawn, which
        // can reject — this call is fire-and-forget by design
        // (bumpGeneration itself is synchronous), so an unhandled
        // teardown failure must be logged, not left to surface as an
        // unhandled rejection in the main process.
        void this.endSpawn(record, record.current).catch((error: unknown) => {
          console.error(
            `[desktop] plugin "${record.pluginId}" spawn teardown failed:`,
            error,
          );
        });
      }
    }
  }

  resetCrashAccounting(pluginId: string): void {
    this.consecutiveFastFailures.delete(pluginId);
  }

  private spawn(record: PluginRecord): void {
    const {
      promise: activated,
      resolve: resolveActivated,
      reject: rejectActivated,
    } = Promise.withResolvers<void>();
    // Nothing may be waiting on this spawn's activation, so its rejection must
    // not surface as an unhandled rejection in the main process.
    void activated.catch(() => undefined);
    const spawn: PluginSpawn = {
      spawnId: randomUUID(),
      generation: this.currentGeneration,
      spawnedAt: this.now(),
      stopping: false,
      failureHandled: false,
      activated,
      resolveActivated,
      rejectActivated,
      abortController: new AbortController(),
    };
    record.current = spawn;
    record.commands = undefined;
    this.setStatus(record, "starting");

    try {
      spawn.transport = this.options.spawnTransport({
        pluginId: record.pluginId,
        pluginRoot: record.pluginRoot,
        onStderr: (line) => this.appendLog(record, line),
        onRequest: (method, params) =>
          this.handleRequest(record, spawn, method, params),
        onNotification: (method, params) =>
          this.handleNotification(record, spawn, method, params),
        onExit: () => this.handleExit(record, spawn),
      });

      // The settings read is folded into the activation promise rather than
      // awaited before the spawn, so it is covered by the activation deadline
      // like every other part of starting a plugin.
      const activation = (async () => {
        const settings =
          await this.options.readPluginSettings?.(record.directoryName) ?? {};
        return spawn.transport!.request<unknown>(
          PLUGIN_HOST_METHODS.activate,
          {
            pluginId: record.pluginId,
            pluginRoot: record.pluginRoot,
            workspaceRoot: this.options.workspaceRoot,
            stateRoot: this.pluginStateRoot(record.pluginId),
            manifest: record.manifest,
            settings,
          } satisfies PluginActivateParams,
        );
      })();
      void raceWithTimeout(
        activation,
        this.activationTimeoutMs,
        `Plugin "${record.pluginId}" activation exceeded ${this.activationTimeoutMs} ms.`,
      ).then(
        (result) => this.handleActivationSuccess(record, spawn, result),
        (error: unknown) => this.handleActivationFailure(record, spawn, error),
      );
    } catch (error) {
      void this.handleActivationFailure(record, spawn, error);
    }
  }

  private handleActivationSuccess(
    record: PluginRecord,
    spawn: PluginSpawn,
    result: unknown,
  ): void {
    if (!this.isLive(record, spawn)) {
      // .finally() re-throws the original rejection, so this needs its own
      // .catch() too — see bumpGeneration's comment.
      void this.endSpawn(record, spawn)
        .finally(() => spawn.transport?.dispose().catch(() => undefined))
        .catch((error: unknown) => {
          console.error(
            `[desktop] plugin "${record.pluginId}" spawn teardown failed:`,
            error,
          );
        });
      return;
    }
    if (!isPluginActivateResult(result)) {
      void this.handleActivationFailure(
        record,
        spawn,
        new Error(
          'Plugin activation returned an invalid result: "commands" and "drivers" must be arrays of non-empty strings.',
        ),
      );
      return;
    }
    const duplicateCommandId = findDuplicateId(result.commands);
    if (duplicateCommandId !== undefined) {
      void this.handleActivationFailure(
        record,
        spawn,
        new Error(
          `Plugin activation returned duplicate command id "${duplicateCommandId}". Command ids must be unique.`,
        ),
      );
      return;
    }
    const duplicateDriverId = findDuplicateId(result.drivers);
    if (duplicateDriverId !== undefined) {
      void this.handleActivationFailure(
        record,
        spawn,
        new Error(
          `Plugin activation returned duplicate driver id "${duplicateDriverId}". Driver ids must be unique.`,
        ),
      );
      return;
    }
    const commandMismatch = registrationMismatch(
      record.pluginId,
      "command",
      (record.manifest.commands ?? []).map((command) => command.id),
      result.commands,
    );
    if (commandMismatch !== undefined) {
      void this.handleActivationFailure(record, spawn, new Error(commandMismatch));
      return;
    }
    const declaredDrivers = record.manifest.drivers ?? [];
    const mismatch = registrationMismatch(
      record.pluginId,
      "driver",
      declaredDrivers.map((driver) => driver.id),
      result.drivers,
    );
    if (mismatch !== undefined) {
      void this.handleActivationFailure(record, spawn, new Error(mismatch));
      return;
    }
    try {
      // The registry decides whether these drivers can join it — a colliding
      // id or a full workspace refuses here, while the plugin is still
      // starting, rather than after it is listed as ready.
      this.options.onDriversRegistered?.(record.pluginId, spawn.spawnId, declaredDrivers);
    } catch (error) {
      void this.handleActivationFailure(record, spawn, error);
      return;
    }
    record.commands = [...result.commands];
    record.drivers = [...result.drivers];
    this.setStatus(record, "ready");
    spawn.resolveActivated();
  }

  private async handleActivationFailure(
    record: PluginRecord,
    spawn: PluginSpawn,
    error: unknown,
  ): Promise<void> {
    spawn.rejectActivated(
      error instanceof Error ? error : new Error(this.errorMessage(error)),
    );
    if (!this.isLive(record, spawn)) {
      void spawn.transport?.dispose().catch(() => undefined);
      return;
    }
    spawn.failureHandled = true;
    await this.endSpawn(record, spawn).catch((resourceError: unknown) => {
      this.appendLog(
        record,
        `Spawn resource disposal failed: ${this.errorMessage(resourceError)}`,
      );
    });
    this.appendLog(record, `Activation failed: ${this.errorMessage(error)}`);
    this.setStatus(record, "failed");
    await spawn.transport?.dispose().catch((disposeError: unknown) => {
      this.appendLog(record, `Dispose failed: ${this.errorMessage(disposeError)}`);
    });
    await this.accountForFailure(record, spawn);
  }

  private handleExit(record: PluginRecord, spawn: PluginSpawn): void {
    if (!this.isLive(record, spawn)) {
      return;
    }
    spawn.failureHandled = true;
    const resourceDisposal = this.endSpawn(record, spawn);
    void resourceDisposal.catch((error: unknown) => {
      this.appendLog(
        record,
        `Spawn resource disposal failed: ${this.errorMessage(error)}`,
      );
    });
    void resourceDisposal.then(
      () => this.accountForFailure(record, spawn),
      () => this.accountForFailure(record, spawn),
    );
    this.setStatus(record, "crashed");
  }

  private async accountForFailure(
    record: PluginRecord,
    spawn: PluginSpawn,
  ): Promise<void> {
    if (!this.isCurrent(record, spawn)) {
      this.emitRecoveryDisposition(record, "terminal");
      return;
    }

    const age = this.now() - spawn.spawnedAt;
    let failures = 0;
    if (age <= PLUGIN_FAST_FAILURE_WINDOW_MS) {
      failures = (this.consecutiveFastFailures.get(record.pluginId) ?? 0) + 1;
    }
    // Reaching ready does not clear this counter. Only a failure from a spawn
    // older than the fast-failure window starts a new failure sequence.
    this.consecutiveFastFailures.set(record.pluginId, failures);

    if (failures >= PLUGIN_CRASH_LOOP_THRESHOLD) {
      try {
        await (this.options.mutatePluginRecord ?? mutatePluginRecord)(
          this.options.stateDir,
          this.options.workspaceRoot,
          record.pluginId,
          (pluginRecord) => ({ ...pluginRecord, disabled: true }),
        );
      } catch (error) {
        this.appendLog(
          record,
          `Could not save disabled state: ${this.errorMessage(error)}`,
        );
        if (this.isCurrent(record, spawn)) {
          record.current = undefined;
          record.commands = undefined;
        }
        this.emitRecoveryDisposition(record, "terminal");
        return;
      }
      if (!this.isCurrent(record, spawn)) {
        this.emitRecoveryDisposition(record, "terminal");
        return;
      }
      record.current = undefined;
      record.commands = undefined;
      this.setStatus(record, "disabled");
      this.emitRecoveryDisposition(record, "terminal");
      return;
    }

    // Re-check stopping here, not just isCurrent: a synchronous
    // onStatusChange listener can call stop() from inside handleExit's own
    // setStatus call, in the same tick. A stop that arrived mid-accounting
    // must win over a respawn.
    if (this.isCurrent(record, spawn) && !spawn.stopping) {
      this.emitRecoveryDisposition(record, "will-respawn");
      this.spawn(record);
      return;
    }
    this.emitRecoveryDisposition(record, "terminal");
  }

  private isCurrent(record: PluginRecord, spawn: PluginSpawn): boolean {
    return (
      this.currentGeneration === spawn.generation &&
      this.plugins.get(record.pluginId) === record &&
      record.current === spawn
    );
  }

  private isLive(record: PluginRecord, spawn: PluginSpawn): boolean {
    return (
      this.isCurrent(record, spawn) &&
      !spawn.stopping &&
      !spawn.failureHandled
    );
  }

  private handleRequest(
    record: PluginRecord,
    spawn: PluginSpawn,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (method !== PLUGIN_HOST_METHODS.sdkRequest) {
      throw new Error(`Method not found: ${method}`);
    }
    if (!isSdkRequestParams(params)) {
      throw new Error(
        "Malformed sdk.request params: method must be a non-empty string.",
      );
    }
    const request = params;
    return this.options.routeSdkRequest(
      record.pluginId,
      request.method,
      request.params,
      spawn.spawnId,
      spawn.abortController.signal,
      (subscriptionId, event, data) => {
        if (!this.isLive(record, spawn)) return;
        spawn.transport?.notify(
          PLUGIN_HOST_METHODS.sdkEvent,
          { subscriptionId, event, data } satisfies SdkEventParams,
        );
      },
    );
  }

  private endSpawn(record: PluginRecord, spawn: PluginSpawn): Promise<void> {
    // Every teardown path runs through here — a stop, a crash, a replaced
    // generation — so this is where a spawn that ends before it activated
    // releases whoever waits on it. Already-settled activations ignore it.
    spawn.rejectActivated(
      new Error(
        `Plugin "${record.pluginId}" stopped before it finished starting.`,
      ),
    );
    if (!spawn.abortController.signal.aborted) spawn.abortController.abort();
    if (!spawn.resourceDisposal) {
      spawn.resourceDisposal = this.options.onSpawnEnd?.(
        record.pluginId,
        spawn.spawnId,
      ) ?? Promise.resolve();
    }
    return spawn.resourceDisposal;
  }

  private handleNotification(
    record: PluginRecord,
    spawn: PluginSpawn,
    method: string,
    params: unknown,
  ): void {
    if (method === PLUGIN_HOST_METHODS.driverEvent) {
      // A spawn that is stopping, replaced, or already failed has no live
      // session left to report about, and its late events must not reach a
      // registry that has moved on.
      if (!this.isLive(record, spawn)) return;
      this.options.onDriverEvent?.(record.pluginId, spawn.spawnId, params);
      return;
    }
    if (method !== PLUGIN_HOST_METHODS.log) return;
    if (!isPluginLogParams(params)) {
      let renderedParams = "[unserializable params]";
      try {
        renderedParams = JSON.stringify(params) ?? String(params);
      } catch {
        // Keep the fallback diagnostic.
      }
      this.appendLog(
        record,
        `Malformed plugin.log notification: ${renderedParams}`,
      );
      return;
    }
    const log = params;
    this.appendLog(record, `[${log.level}] ${log.message}`);
  }

  private appendLog(record: PluginRecord, line: string): void {
    record.stderr.push(line);
    if (record.stderr.length > PLUGIN_PROCESS_LOG_LIMIT) record.stderr.shift();
  }

  private setStatus(record: PluginRecord, status: PluginRuntimeStatus): void {
    record.status = status;
    const onStatusChange = this.options.onStatusChange;
    if (!onStatusChange) return;
    const pluginId = record.pluginId;
    // Deferred, always — never synchronous. A listener that reacts to a
    // status change by calling back into this host (stop, invokeCommand,
    // another start) must never be able to reenter mid-operation, the way a
    // synchronous callback could. This is what makes that whole class of
    // race impossible, not a fix for one more instance of it.
    queueMicrotask(() => onStatusChange(pluginId, status));
  }

  private emitRecoveryDisposition(
    record: PluginRecord,
    kind: PluginHostRecoveryDisposition["kind"],
  ): void {
    const onRecoveryDisposition = this.options.onRecoveryDisposition;
    if (!onRecoveryDisposition) return;
    const pluginId = record.pluginId;
    const disposition = {
      kind,
      record: record.ownershipToken,
    } satisfies PluginHostRecoveryDisposition;
    queueMicrotask(() => onRecoveryDisposition(pluginId, disposition));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
