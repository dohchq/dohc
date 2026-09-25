import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { SyncStatusResult } from "../ipc/bridgeContract";
import { createCollectionRecord, setCollectionRecordFields, type CollectionRecordEditContext } from "../workspaces/collectionRecordEdits";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";
import type { OwnedWorkspaceDatabaseReader } from "../workspaces/ownedWorkspaceFileReader";
import type { WorkspaceAuthorityOperation } from "../workspaces/workspaceAuthorityOwner";
import type { DatabaseEdit } from "../workspaces/workspaceDatabase";
import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { createPluginAuthoredTextWriter } from "./pluginAuthoredWrite";
import { createPluginPanelSdkEventEmitter } from "./pluginPanelSdkEvent";
import { invokePluginSdkHost, type PluginAutomationRunAuthority, type PluginSdkHostContext } from "./pluginSdkHost";
import type { PluginPanelSdkAuthorization } from "./pluginSurfaces";
import type { PluginWorkspaceRuntimes } from "./pluginWorkspaceRuntimes";

type PluginSdkOperation = WorkspaceAuthorityOperation<CreatedWorkspace, {
  pluginRuntimes: PluginWorkspaceRuntimes<CreatedWorkspace>;
}>;

export function createDesktopPluginSdk<Operation extends PluginSdkOperation>(dependencies: {
  withPhysicalWorkspaceOperation<Result>(workspaceId: string, work: (operation: Operation) => Promise<Result>): Promise<Result>;
  ownedWorkspaceReadsFor(workspace: Operation["workspace"], databaseReader: OwnedWorkspaceDatabaseReader): PluginSdkHostContext["reads"];
  workerDatabaseReader(signal?: AbortSignal): OwnedWorkspaceDatabaseReader;
  editWorkspaceDatabaseInWorker(input: {
    rootPath: string;
    relativePath: string;
    edit: DatabaseEdit;
    author: ChangeAuthor;
    nowMs: number;
    operationId?: string;
    signal?: AbortSignal;
  }): ReturnType<PluginSdkHostContext["editDatabase"]>;
  openWorkspaceActivityForOperation(
    operation: Operation,
    options: {},
    ensureOpen: (workspace: CreatedWorkspace, options: {}) => Promise<SyncStatusResult>,
  ): Promise<SyncStatusResult>;
  ensureWorkspaceActivityOpen(workspace: CreatedWorkspace, options: {}): Promise<SyncStatusResult>;
  activity: { engineCaptureFor(workspaceId: string): WorkspaceEngineCapture | null };
  collectionEditContextFor(operation: Operation, signal?: AbortSignal): Promise<CollectionRecordEditContext>;
  requirePluginEngineCaptureForOperation(operation: Operation): Promise<{
    workspace: Operation["workspace"];
    capture: WorkspaceEngineCapture;
  }>;
  assertWritableWorkspace(workspace: CreatedWorkspace): void;
  workspaceAuthorities: {
    withAuthority<Result>(workspaceId: string, work: () => Promise<Result>): Promise<Result>;
  };
  pluginWorkspaceRuntimes: Pick<PluginWorkspaceRuntimes<CreatedWorkspace>, "current">;
  sharedViewOf(workspaceId: string): unknown;
  notifyPluginPanelSdkEvent(event: unknown): void;
}) {
  const {
    withPhysicalWorkspaceOperation, ownedWorkspaceReadsFor, workerDatabaseReader,
    editWorkspaceDatabaseInWorker, openWorkspaceActivityForOperation,
    ensureWorkspaceActivityOpen, activity, collectionEditContextFor,
    requirePluginEngineCaptureForOperation, assertWritableWorkspace,
    workspaceAuthorities, pluginWorkspaceRuntimes, sharedViewOf,
    notifyPluginPanelSdkEvent,
  } = dependencies;

  async function invokeWorkspacePluginSdk(input: {
    workspaceId: string;
    pluginId: string;
    spawnId: string;
    requestPath: "panel" | "plugin-process";
    isWritable: () => boolean;
    signal?: AbortSignal;
    /** The claim id the plugin-process request declared (see SdkRequestParams). */
    automationClaimId?: string;
    invokeChildProcess?: (method: string, params?: unknown) => Promise<unknown>;
    subscribeFileWatch?: (params: unknown) => { subscriptionId: string };
    subscribeRecordWatch?: (
      params: unknown,
      readable?: ReadonlySet<string>,
    ) => { subscriptionId: string };
    unsubscribeWorkspaceEvents?: (params: unknown) => boolean;
    method: string;
    params?: unknown;
  }): Promise<unknown> {
    return withPhysicalWorkspaceOperation(input.workspaceId, async (operation) => {
      const workspace = operation.workspace;
      const signal = input.signal
        ? AbortSignal.any([input.signal, operation.signal])
        : operation.signal;
      // Resolve a request-declared automation claim against the runs this
      // workspace's executor actually started on this plugin — main-derived
      // authority, like the author; the plugin's tag grants nothing.
      const automationRun: PluginAutomationRunAuthority | undefined =
        input.automationClaimId === undefined
          ? undefined
          : operation.state.pluginRuntimes
              .current(input.workspaceId)
              ?.automations.activeRun({
                claimId: input.automationClaimId,
                pluginId: input.pluginId,
              });
      return invokePluginSdkHost(
        {
          pluginId: input.pluginId,
          workspaceRoot: workspace.rootPath,
          spawnId: input.spawnId,
          requestPath: input.requestPath,
          ...(input.automationClaimId === undefined
            ? {}
            : { automationClaimId: input.automationClaimId }),
          ...(automationRun === undefined ? {} : { automationRun }),
          // Read from the registration main holds, never from the request: what a
          // plugin may open is what its approved manifest declares.
          declaredWebApps: operation.state.pluginRuntimes
            .current(input.workspaceId)
            ?.registeredPlugin(input.pluginId)
            ?.manifest.webApps,
          isWritable: input.isWritable,
          /** Main supplies this read authority. Plugins cannot select or widen it. */
          reads: ownedWorkspaceReadsFor(workspace, workerDatabaseReader(signal)),
          editDatabase: ({ path, edit, author, nowMs, operationId, signal: editSignal }) =>
            editWorkspaceDatabaseInWorker({
              rootPath: workspace.rootPath,
              relativePath: path,
              edit,
              author,
              nowMs,
              ...(operationId ? { operationId } : {}),
              ...(editSignal ? { signal: editSignal } : {}),
            }),
          writeAvailable: async () => {
            try {
              await openWorkspaceActivityForOperation(
                operation,
                {},
                ensureWorkspaceActivityOpen,
              );
              operation.assertCurrent();
              return Boolean(activity.engineCaptureFor(input.workspaceId));
            } catch {
              return false;
            }
          },
          signal,
          invokeChildProcess: input.invokeChildProcess,
          subscribeFileWatch: input.subscribeFileWatch,
          // The one main-side collection write seam. Authority mirrors
          // writeAuthoredText: a writable workspace and a running engine
          // capture, resolved when the write happens, never cached.
          editCollections: {
            // The idempotency key is the automation run's claim, attempt, and
            // write ordinal: it must reach the seam, or a retried request
            // could write twice.
            setRecordFields: async ({
              recordPath,
              fields,
              author,
              idempotencyKey,
              signal: editSignal,
            }) =>
              setCollectionRecordFields(
                await collectionEditContextFor(operation, editSignal),
                {
                  recordPath,
                  fields,
                  author,
                  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                },
              ),
            createRecord: async ({
              collectionPath,
              name,
              fields,
              author,
              idempotencyKey,
              signal: editSignal,
            }) =>
              createCollectionRecord(
                await collectionEditContextFor(operation, editSignal),
                {
                  collectionPath,
                  name,
                  ...(fields === undefined ? {} : { fields }),
                  author,
                  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                },
              ),
          },
          subscribeRecordWatch: input.subscribeRecordWatch,
          unsubscribeWorkspaceEvents: input.unsubscribeWorkspaceEvents,
          writeAuthoredText: createPluginAuthoredTextWriter({
            signal,
            requireWritableCapture: async () => {
              const { workspace: workspaceForWrite, capture } =
                await requirePluginEngineCaptureForOperation(operation);
              assertWritableWorkspace(workspaceForWrite);
              return { workspaceRoot: workspaceForWrite.rootPath, capture };
            },
            pipeline: () =>
              operation.state.pluginRuntimes.current(input.workspaceId)?.pipeline,
          }),
        },
        input.method,
        input.params,
      );
    });
  }

  async function routePluginPanelSdk(input: {
    authorization: PluginPanelSdkAuthorization;
    method: string;
    params?: unknown;
  }): Promise<unknown> {
    const { authority, surfaceId, isPushLive } = input.authorization;
    return workspaceAuthorities.withAuthority(authority.workspaceId, async () => {
      const workspaceEvents = pluginWorkspaceRuntimes.current(
        authority.workspaceId,
      )?.workspaceEvents;
      const owner = {
        kind: "panel" as const,
        workspaceId: authority.workspaceId,
        pluginId: authority.pluginId,
        panelId: authority.panelId,
        surfaceId,
      };
      const emitEvent = workspaceEvents
        ? createPluginPanelSdkEventEmitter({
            workspaceId: authority.workspaceId,
            pluginId: authority.pluginId,
            panelId: authority.panelId,
            isPanelRunning: isPushLive,
            send: notifyPluginPanelSdkEvent,
          })
        : undefined;
      return invokeWorkspacePluginSdk({
        workspaceId: authority.workspaceId,
        pluginId: authority.pluginId,
        spawnId: authority.spawnId,
        requestPath: "panel",
        isWritable: () => !sharedViewOf(authority.workspaceId),
        signal: authority.signal,
        subscribeFileWatch:
          workspaceEvents && emitEvent
            ? (watchParams) =>
                workspaceEvents.subscribe({ owner, emitEvent }, watchParams)
            : undefined,
        subscribeRecordWatch:
          workspaceEvents && emitEvent
            ? (watchParams, readable) =>
                workspaceEvents.subscribeRecords(
                  { owner, emitEvent },
                  watchParams,
                  readable,
                )
            : undefined,
        unsubscribeWorkspaceEvents: workspaceEvents
          ? (watchParams) => workspaceEvents.unsubscribe({ owner }, watchParams)
          : undefined,
        method: input.method,
        params: input.params,
      });
    });
  }

  return { invokeWorkspacePluginSdk, routePluginPanelSdk };
}
