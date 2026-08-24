import type {
  PluginHostPanelDeclaration,
  PluginHostRecordToken,
  PluginHostRecoveryDisposition,
} from "./PluginHost";
import type { PluginRuntimeStatus } from "./pluginHostProtocol";
import type {
  PluginSurfaceHostChange,
  PluginSurfaceHostReady,
  PluginSurfaceStopTarget,
} from "./pluginSurfaces";

interface PluginSurfaceLifecycle {
  hostChanged(change: PluginSurfaceHostChange): void;
  hostReady(identity: PluginSurfaceHostReady): Promise<void>;
  stop(target: PluginSurfaceStopTarget): Promise<void>;
}

interface PluginSurfaceHost {
  currentRecord(pluginId: string): PluginHostRecordToken | undefined;
  getSpawnId(pluginId: string): string | undefined;
  getStatus(pluginId: string): PluginRuntimeStatus | undefined;
  readyPanelsForSpawn(
    pluginId: string,
    expectedSpawnId: string,
  ): {
    readonly record: PluginHostRecordToken;
    readonly panels: readonly PluginHostPanelDeclaration[];
  } | undefined;
}

export interface PluginSurfaceHostLifecycleOptions {
  workspaceId: string;
  host: PluginSurfaceHost;
  surfaces: PluginSurfaceLifecycle;
  onRuntimeStatus(pluginId: string, status: PluginRuntimeStatus): void;
  onError(error: unknown, context: string): void;
}

/**
 * Keeps retained plugin surfaces aligned with one host's spawn lifecycle.
 * A spawn end revokes live authority, a current ready successor can regrant
 * it, and a terminal recovery outcome retires the retained surfaces.
 */
export class PluginSurfaceHostLifecycle {
  readonly #endedRecords = new Map<
    string,
    { record: PluginHostRecordToken; willRespawn: boolean }
  >();

  constructor(private readonly options: PluginSurfaceHostLifecycleOptions) {}

  spawnEnded(pluginId: string): void {
    const record = this.options.host.currentRecord(pluginId);
    if (record) {
      this.#endedRecords.set(pluginId, { record, willRespawn: false });
    } else {
      this.#endedRecords.delete(pluginId);
    }
    this.options.surfaces.hostChanged({
      kind: "terminal",
      workspaceId: this.options.workspaceId,
      pluginId,
    });
  }

  recoveryDisposition(
    pluginId: string,
    disposition: PluginHostRecoveryDisposition,
  ): void {
    const ended = this.#endedRecords.get(pluginId);
    if (!ended || ended.record !== disposition.record) return;
    if (this.options.host.currentRecord(pluginId) !== disposition.record) {
      this.#endedRecords.delete(pluginId);
      return;
    }
    if (disposition.kind === "will-respawn") {
      ended.willRespawn = true;
      return;
    }

    this.#endedRecords.delete(pluginId);
    this.#observe(
      () => this.options.surfaces.stop({
        kind: "plugin",
        workspaceId: this.options.workspaceId,
        pluginId,
      }),
      `stop retained surfaces for terminal plugin "${pluginId}"`,
    );
  }

  statusChanged(pluginId: string, status: PluginRuntimeStatus): void {
    this.options.onRuntimeStatus(pluginId, status);
    if (status !== "ready") return;

    const spawnId = this.options.host.getSpawnId(pluginId);
    if (
      this.options.host.getStatus(pluginId) !== "ready" ||
      !spawnId
    ) {
      return;
    }
    const ended = this.#endedRecords.get(pluginId);
    if (!ended?.willRespawn) return;
    const readyPanels = this.options.host.readyPanelsForSpawn(pluginId, spawnId);
    if (!readyPanels || readyPanels.record !== ended.record) return;
    this.#endedRecords.delete(pluginId);
    this.#observe(
      () => this.options.surfaces.hostReady({
        workspaceId: this.options.workspaceId,
        pluginId,
        spawnId,
        hostRecord: readyPanels.record,
        declaredPanels: readyPanels.panels,
      }),
      `regrant retained surfaces for ready plugin "${pluginId}"`,
    );
  }

  #observe(operation: () => Promise<void>, context: string): void {
    let result: Promise<void>;
    try {
      result = operation();
    } catch (error) {
      this.options.onError(error, context);
      return;
    }
    void result.catch((error: unknown) => {
      this.options.onError(error, context);
    });
  }
}
