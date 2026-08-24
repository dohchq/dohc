import type { PluginHost } from "./PluginHost";
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

export interface PluginSurfaceHostLifecycleOptions {
  workspaceId: string;
  host: Pick<
    PluginHost,
    "getSpawnId" | "getStatus" | "readyPanelsForSpawn"
  >;
  surfaces: PluginSurfaceLifecycle;
  onRuntimeStatus(pluginId: string, status: PluginRuntimeStatus): void;
  onError(error: unknown, context: string): void;
}

/**
 * Keeps retained plugin surfaces aligned with one host's spawn lifecycle.
 * A spawn end revokes live authority, a current ready successor can regrant
 * it, and crash-loop disable retires the retained surfaces permanently.
 */
export class PluginSurfaceHostLifecycle {
  readonly #endedPluginIds = new Set<string>();

  constructor(private readonly options: PluginSurfaceHostLifecycleOptions) {}

  spawnEnded(pluginId: string): void {
    this.#endedPluginIds.add(pluginId);
    this.options.surfaces.hostChanged({
      kind: "terminal",
      workspaceId: this.options.workspaceId,
      pluginId,
    });
  }

  statusChanged(pluginId: string, status: PluginRuntimeStatus): void {
    this.options.onRuntimeStatus(pluginId, status);
    if (status === "disabled") {
      if (this.options.host.getStatus(pluginId) !== "disabled") return;
      this.#endedPluginIds.delete(pluginId);
      this.#observe(
        () => this.options.surfaces.stop({
          kind: "plugin",
          workspaceId: this.options.workspaceId,
          pluginId,
        }),
        `stop retained surfaces for disabled plugin "${pluginId}"`,
      );
      return;
    }
    if (status !== "ready") return;

    const spawnId = this.options.host.getSpawnId(pluginId);
    if (
      this.options.host.getStatus(pluginId) !== "ready" ||
      !spawnId
    ) {
      return;
    }
    const readyPanels = this.options.host.readyPanelsForSpawn(pluginId, spawnId);
    if (!readyPanels || !this.#endedPluginIds.delete(pluginId)) return;
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
